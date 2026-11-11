// Test double for the second Area A boundary (Payments & Wallet).
//
// node:test runs the monolith in-process with SQLite and no payments service, so this installs an
// in-memory transport that implements the SAME contract as the real service: intents are unique per
// order, ledger entries are unique per (order_id, kind), and a duplicate webhook has no second
// effect. The assertions in the tests therefore describe the contract, not a mock's mood.
import { setPaymentsTransport, resetPaymentsTransport } from "../lib/modules/payments/client.js";
import * as bookingService from "../lib/modules/booking/service.js";
import { config } from "../lib/config.js";

const state = {
  intents: new Map(), // order_id -> intent
  wallets: new Map(), // provider_id -> {balance_cents, commission_owed_cents}
  transactions: [],
  webhooks: new Set(),
  nextIntentId: 1,
  nextTransactionId: 1,
  simulateCalls: 0,
};

export function resetPaymentsFake() {
  state.intents.clear();
  state.wallets.clear();
  state.transactions.length = 0;
  state.webhooks.clear();
  state.nextIntentId = 1;
  state.nextTransactionId = 1;
  state.simulateCalls = 0;
}

export function fakeWallet(providerId) {
  const w = state.wallets.get(providerId.toString());
  return w ?? { balance_cents: 0, commission_owed_cents: 0 };
}

export function fakeTransactions(filter = {}) {
  return state.transactions.filter((t) =>
    Object.entries(filter).every(([k, v]) => t[k] === v)
  );
}

export function fakeIntent(orderId) {
  return state.intents.get(orderId.toString()) ?? null;
}

export function paymentsFakeState() {
  return state;
}

function claimsFrom(token) {
  if (!token) return {};
  const part = token.split(".")[1];
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function idOf(token) {
  const claims = claimsFrom(token);
  return Number(claims.local_id ?? claims.sub);
}

function walletOf(providerId) {
  const key = providerId.toString();
  if (!state.wallets.has(key)) {
    state.wallets.set(key, { balance_cents: 0, commission_owed_cents: 0 });
  }
  return state.wallets.get(key);
}

function ensureIntent({ order_id, amount_cents, gateway_ref }) {
  const key = order_id.toString();
  if (!state.intents.has(key)) {
    state.intents.set(key, {
      id: state.nextIntentId++,
      order_id,
      amount_cents,
      gateway_ref,
      status: "requires_payment",
    });
  }
  return state.intents.get(key);
}

function insertLedger(t) {
  const exists = state.transactions.some((row) => row.order_id === t.order_id && row.kind === t.kind);
  if (exists) return false;
  state.transactions.push({
    id: state.nextTransactionId++,
    order_id: t.order_id ?? null,
    customer_id: t.customer_id ?? null,
    provider_id: t.provider_id ?? null,
    kind: t.kind,
    amount_cents: t.amount_cents,
    method: t.method,
    gateway_ref: t.gateway_ref ?? null,
    status: t.status ?? "succeeded",
    created_at: new Date().toISOString(),
  });
  return true;
}

async function settle(intent, gatewayEventId) {
  if (state.webhooks.has(gatewayEventId)) {
    await bookingService.markOrderPaymentStatus(intent.order_id, {
      paymentStatus: "paid",
      gatewayRef: intent.gateway_ref,
    });
    return { received: true, replayed: true };
  }
  state.webhooks.add(gatewayEventId);

  if (intent.status === "requires_payment") {
    intent.status = "succeeded";
    insertLedger({
      order_id: intent.order_id,
      kind: "charge",
      amount_cents: intent.amount_cents,
      method: "gateway",
      gateway_ref: intent.gateway_ref,
    });
  }
  await bookingService.markOrderPaymentStatus(intent.order_id, {
    paymentStatus: "paid",
    gatewayRef: intent.gateway_ref,
  });
  return { received: true, replayed: false, settled: true };
}

async function transport(req) {
  const { method, path, body, token } = req;
  const json = (status, payload) => ({ status, body: payload });

  if (method === "POST" && path === "/internal/payment-intents") {
    return json(201, { intent: ensureIntent(body) });
  }

  let m = path.match(/^\/internal\/payment-intents\/by-order\/(\d+)$/);
  if (method === "GET" && m) {
    return json(200, { intent: state.intents.get(m[1]) ?? null });
  }

  if (method === "POST" && path === "/internal/wallets") {
    const key = body.provider_id.toString();
    if (!state.wallets.has(key)) {
      state.wallets.set(key, { balance_cents: 0, commission_owed_cents: 0 });
    }
    return json(201, { created: true, provider_id: body.provider_id });
  }

  m = path.match(/^\/internal\/wallets\/(\d+)$/);
  if (method === "DELETE" && m) {
    state.wallets.delete(m[1]);
    return json(204, null);
  }
  if (method === "GET" && m) {
    const w = fakeWallet(m[1]);
    return json(200, { provider_id: Number(m[1]), ...w });
  }

  if (method === "POST" && path === "/internal/ledger/booking-completed") {
    const gateway = body.payment_method === "gateway";
    const kind = gateway ? "payout_credit" : "commission_owed";
    const amount = gateway ? body.earnings_cents : body.commission_cents;
    const applied = insertLedger({
      order_id: body.order_id,
      customer_id: body.customer_id,
      provider_id: body.provider_id,
      kind,
      amount_cents: amount,
      method: body.payment_method,
    });
    if (applied && body.provider_id) {
      const wallet = walletOf(body.provider_id);
      if (gateway) wallet.balance_cents += amount;
      else wallet.commission_owed_cents += amount;
    }
    return json(200, { applied, kind, amount_cents: amount });
  }

  if (method === "POST" && path === "/internal/ledger/booking-cancelled") {
    const applied = insertLedger({
      order_id: body.order_id,
      customer_id: body.customer_id,
      provider_id: body.provider_id,
      kind: "refund",
      amount_cents: body.total_cents,
      method: "gateway",
      status: "refunded",
    });
    return json(200, { applied, kind: "refund", amount_cents: body.total_cents });
  }

  if (method === "POST" && path === "/internal/simulate") {
    state.simulateCalls++;
    const intent = state.intents.get(body.order_id.toString());
    if (!intent) return json(409, { error: "this booking has no gateway payment to settle" });
    const result = await settle(intent, `SIM-EVT-${intent.id}-${state.simulateCalls}`);
    return json(200, { ok: true, ...result });
  }

  if (method === "GET" && path === "/api/provider/wallet") {
    const providerId = idOf(token);
    const w = fakeWallet(providerId);
    return json(200, {
      provider_id: providerId,
      balance_cents: w.balance_cents,
      commission_owed_cents: w.commission_owed_cents,
      transactions: fakeTransactions({ provider_id: providerId }),
    });
  }

  if (method === "GET" && path === "/api/customer/transactions") {
    const customerId = idOf(token);
    return json(200, fakeTransactions({ customer_id: customerId }));
  }

  if (method === "POST" && path === "/api/payments/webhook") {
    if (req.secret !== config.webhookSecret) {
      return json(401, { error: "invalid webhook secret" });
    }
    const intent = [...state.intents.values()].find((i) => i.gateway_ref === body.gateway_ref);
    if (!intent) return json(404, { error: `payment intent ${body.gateway_ref} not found` });
    return json(200, await settle(intent, body.gateway_event_id));
  }

  return json(404, { error: `fake payments: no route for ${method} ${path}` });
}

export function installPaymentsFake() {
  setPaymentsTransport(transport);
}

export function stopPaymentsFake() {
  resetPaymentsTransport();
  resetPaymentsFake();
}
