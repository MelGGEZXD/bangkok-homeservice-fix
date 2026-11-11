// Express app for the extracted Payments & Wallet bounded context (Area A, second extraction).
//
// Public read/write side (through the gateway, Keycloak JWT verified locally):
//   GET  /api/provider/wallet          -> the caller's wallet + ledger
//   GET  /api/customer/transactions    -> the caller's ledger
//   POST /api/payments/webhook         -> gateway callback (shared x-webhook-secret, not a JWT)
//
// Internal side (monolith only, shared x-internal-key):
//   POST   /internal/payment-intents                 -> idempotent intent per order
//   GET    /internal/payment-intents/by-order/:id    -> the intent for a booking
//   POST   /internal/wallets                         -> create a provider wallet
//   DELETE /internal/wallets/:providerId             -> compensating delete
//   POST   /internal/ledger/booking-completed        -> exactly-once payout / commission entry
//   POST   /internal/ledger/booking-cancelled        -> exactly-once refund entry
//   POST   /internal/simulate                        -> mock gateway "pay now" for a booking
//
// Nothing in this file reads the monolith's database. When money settles, the service tells the
// monolith (which still owns orders) over an idempotent internal endpoint.
const express = require("express");
const crypto = require("node:crypto");
const { z } = require("zod");
const { requireUser, requireRole } = require("./auth");
const config = require("./config");
const db = require("./db");

const intentCommand = z.object({
  order_id: z.coerce.number().int().positive(),
  amount_cents: z.coerce.number().int().nonnegative(),
  gateway_ref: z.string().min(1).max(128),
});

const walletCommand = z.object({ provider_id: z.coerce.number().int().positive() });

const completionCommand = z.object({
  order_id: z.coerce.number().int().positive(),
  customer_id: z.coerce.number().int().positive().nullable().optional(),
  provider_id: z.coerce.number().int().positive().nullable().optional(),
  payment_method: z.enum(["cod", "gateway"]),
  total_cents: z.coerce.number().int().nonnegative(),
  commission_cents: z.coerce.number().int().nonnegative(),
  earnings_cents: z.coerce.number().int().nonnegative(),
});

const cancellationCommand = z.object({
  order_id: z.coerce.number().int().positive(),
  customer_id: z.coerce.number().int().positive().nullable().optional(),
  provider_id: z.coerce.number().int().positive().nullable().optional(),
  total_cents: z.coerce.number().int().nonnegative(),
});

const webhookCommand = z.object({
  gateway_event_id: z.string().min(1).max(128),
  type: z.string().min(1).max(64),
  gateway_ref: z.string().min(1).max(128),
});

const simulateCommand = z.object({ order_id: z.coerce.number().int().positive() });

function toTransaction(row) {
  return {
    id: Number(row.id),
    order_id: row.order_id === null ? null : Number(row.order_id),
    kind: row.kind,
    amount_cents: Number(row.amount_cents),
    method: row.method,
    gateway_ref: row.gateway_ref,
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
}

function toIntent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    order_id: Number(row.order_id),
    amount_cents: Number(row.amount_cents),
    gateway_ref: row.gateway_ref,
    status: row.status,
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireInternalKey(req, res, next) {
  const supplied = req.headers["x-internal-key"];
  if (!supplied || !safeEqual(supplied, config.internalApiKey)) {
    return res.status(401).json({ error: "invalid internal key" });
  }
  return next();
}

// After the money state commits, tell the order owner. This is idempotent on the monolith side and
// is safe to repeat, which is what lets the webhook retry path heal a lost reply.
async function notifyOrderPayment(orderId, paymentStatus, gatewayRef) {
  let res;
  try {
    res = await fetch(`${config.bookingServiceUrl}/api/internal/orders/${orderId}/payment-status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-key": config.internalApiKey,
      },
      body: JSON.stringify({ payment_status: paymentStatus, gateway_ref: gatewayRef }),
      signal: AbortSignal.timeout(config.bookingTimeoutMs),
    });
  } catch (err) {
    throw httpError(502, `booking service unavailable: ${err.message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw httpError(502, `booking service returned ${res.status}${text ? `: ${text}` : ""}`);
  }
}

// The marquee idempotency hook. The gateway's event id is the dedupe key; the (order_id, kind)
// unique key makes the ledger entry exactly-once even if two workers race.
async function settleWebhook(payload) {
  const intent = await db.findIntentByGatewayRef(payload.gateway_ref);
  if (!intent) throw httpError(404, `payment intent ${payload.gateway_ref} not found`);

  let outcome;
  const client = await db.getPool().connect();
  try {
    await client.query("BEGIN");
    // The dedupe row, the intent flip and the ledger entry commit together. A crash anywhere
    // before COMMIT rolls all three back, so a retry can settle rather than being mistaken for a
    // duplicate of an effect that never happened.
    const fresh = await db.recordWebhookEvent(payload.gateway_event_id, payload.type, payload, client);
    if (!fresh) {
      await client.query("COMMIT");
      outcome = { replayed: true };
    } else {
      const flipped = await db.markIntentSucceeded(intent.id, client);
      if (flipped === 0) {
        await db.markWebhookProcessed(payload.gateway_event_id, client);
        await client.query("COMMIT");
        outcome = { replayed: false, already_settled: true };
      } else {
        await db.insertLedgerEntry(
          {
            orderId: intent.order_id,
            kind: "charge",
            amountCents: intent.amount_cents,
            method: "gateway",
            gatewayRef: payload.gateway_ref,
            status: "succeeded",
          },
          client
        );
        await db.markWebhookProcessed(payload.gateway_event_id, client);
        await client.query("COMMIT");
        outcome = { replayed: false, settled: true };
      }
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Notify after the commit, including on a replay: a reply lost after COMMIT must not leave the
  // order pending, and the monolith update is idempotent, so repeating it has no second effect.
  await notifyOrderPayment(intent.order_id, "paid", payload.gateway_ref);
  return outcome;
}

function createApp(pool) {
  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    req.requestId = req.headers["x-request-id"] || crypto.randomUUID();
    res.setHeader("x-request-id", req.requestId);
    next();
  });

  app.use(express.json({ limit: "64kb" }));

  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", service: "payments", database: "up" });
    } catch (err) {
      res.status(503).json({ status: "unavailable", service: "payments", error: err.message });
    }
  });

  // ---- public read side (JWT verified by this service) --------------------------------------
  app.get("/api/provider/wallet", requireUser, requireRole("provider"), async (req, res) => {
    const wallet = await db.findWallet(req.user.sub);
    const transactions = await db.listTransactionsForProvider(req.user.sub);
    res.json({
      provider_id: req.user.sub,
      balance_cents: wallet ? Number(wallet.balance_cents) : 0,
      commission_owed_cents: wallet ? Number(wallet.commission_owed_cents) : 0,
      transactions: transactions.map(toTransaction),
    });
  });

  app.get("/api/customer/transactions", requireUser, requireRole("customer"), async (req, res) => {
    const rows = await db.listTransactionsForCustomer(req.user.sub);
    res.json(rows.map(toTransaction));
  });

  // ---- gateway callback (shared secret, not a user token) -----------------------------------
  app.post("/api/payments/webhook", async (req, res) => {
    const supplied = req.headers["x-webhook-secret"];
    if (!supplied || !safeEqual(supplied, config.webhookSecret)) {
      return res.status(401).json({ error: "invalid webhook secret" });
    }
    const parsed = webhookCommand.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid webhook payload", details: parsed.error.flatten() });
    }
    const result = await settleWebhook(parsed.data);
    return res.status(200).json({ received: true, ...result });
  });

  // ---- internal write side (monolith only) --------------------------------------------------
  app.post("/internal/payment-intents", requireInternalKey, async (req, res) => {
    const parsed = intentCommand.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid intent command", details: parsed.error.flatten() });
    }
    const intent = await db.ensureIntent({
      orderId: parsed.data.order_id,
      amountCents: parsed.data.amount_cents,
      gatewayRef: parsed.data.gateway_ref,
    });
    res.status(201).json({ intent: toIntent(intent) });
  });

  app.get("/internal/payment-intents/by-order/:orderId", requireInternalKey, async (req, res) => {
    const orderId = Number.parseInt(req.params.orderId, 10);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ error: "order id must be a positive integer" });
    }
    res.json({ intent: toIntent(await db.findIntentByOrder(orderId)) });
  });

  app.post("/internal/wallets", requireInternalKey, async (req, res) => {
    const parsed = walletCommand.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid wallet command", details: parsed.error.flatten() });
    }
    await db.createWallet(parsed.data.provider_id);
    res.status(201).json({ created: true, provider_id: parsed.data.provider_id });
  });

  app.delete("/internal/wallets/:providerId", requireInternalKey, async (req, res) => {
    const providerId = Number.parseInt(req.params.providerId, 10);
    if (!Number.isInteger(providerId) || providerId <= 0) {
      return res.status(400).json({ error: "provider id must be a positive integer" });
    }
    await db.deleteWallet(providerId);
    res.status(204).end();
  });

  app.get("/internal/wallets/:providerId", requireInternalKey, async (req, res) => {
    const providerId = Number.parseInt(req.params.providerId, 10);
    if (!Number.isInteger(providerId) || providerId <= 0) {
      return res.status(400).json({ error: "provider id must be a positive integer" });
    }
    const wallet = await db.findWallet(providerId);
    res.json({
      provider_id: providerId,
      balance_cents: wallet ? Number(wallet.balance_cents) : 0,
      commission_owed_cents: wallet ? Number(wallet.commission_owed_cents) : 0,
    });
  });

  // Exactly-once ledger application. The unique (order_id, kind) key means a redelivered command
  // inserts nothing and the wallet delta is skipped.
  app.post("/internal/ledger/booking-completed", requireInternalKey, async (req, res) => {
    const parsed = completionCommand.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid completion command", details: parsed.error.flatten() });
    }
    const c = parsed.data;
    const gateway = c.payment_method === "gateway";
    const kind = gateway ? "payout_credit" : "commission_owed";
    const amount = gateway ? c.earnings_cents : c.commission_cents;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await db.insertLedgerEntry(
        {
          orderId: c.order_id,
          customerId: c.customer_id ?? null,
          providerId: c.provider_id ?? null,
          kind,
          amountCents: amount,
          method: c.payment_method,
        },
        client
      );
      if (inserted && c.provider_id) {
        await db.applyWalletDelta(
          c.provider_id,
          gateway ? { balanceDelta: amount } : { commissionDelta: amount },
          client
        );
      }
      await client.query("COMMIT");
      res.json({ applied: inserted, kind, amount_cents: amount });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  app.post("/internal/ledger/booking-cancelled", requireInternalKey, async (req, res) => {
    const parsed = cancellationCommand.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid cancellation command", details: parsed.error.flatten() });
    }
    const c = parsed.data;
    const inserted = await db.insertLedgerEntry({
      orderId: c.order_id,
      customerId: c.customer_id ?? null,
      providerId: c.provider_id ?? null,
      kind: "refund",
      amountCents: c.total_cents,
      method: "gateway",
      status: "refunded",
    });
    res.json({ applied: inserted, kind: "refund", amount_cents: c.total_cents });
  });

  // The monolith has already checked that the caller owns the booking; this only settles it.
  app.post("/internal/simulate", requireInternalKey, async (req, res) => {
    const parsed = simulateCommand.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid simulate command", details: parsed.error.flatten() });
    }
    const intent = await db.findIntentByOrder(parsed.data.order_id);
    if (!intent) throw httpError(409, "this booking has no gateway payment to settle");
    const result = await settleWebhook({
      gateway_event_id: `SIM-EVT-${crypto.randomUUID()}`,
      type: "payment_intent.succeeded",
      gateway_ref: intent.gateway_ref,
    });
    res.json({ ok: true, ...result });
  });

  app.use((req, res) => {
    res.status(404).json({ error: `no route for ${req.method} ${req.path}` });
  });

  app.use((err, _req, res, _next) => {
    // Keep 4xx statuses (bad input, missing intent, wrong secret) and the 502 raised when the
    // order-side call fails; only truly unexpected errors collapse to 500.
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) {
      console.error(JSON.stringify({ level: "error", service: "payments", err: err.stack || err.message }));
    }
    res.status(status).json({ error: status >= 500 ? "internal server error" : err.message });
  });

  return app;
}

module.exports = { createApp };
