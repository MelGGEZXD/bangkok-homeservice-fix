import { randomUUID } from "node:crypto";
import { config } from "../../config.js";
import { getDb } from "../../db/index.js";
import { insertEvent } from "../../db/events.js";
import { logger } from "../../logger.js";
import { ConflictError } from "../../errors.js";
import * as booking from "./repository.js";
import { paymentsRequest } from "../payments/client.js";

const WORKER = Symbol.for("edemand.paymentSetupWorker");
const inProgress = new Map();

export function createPaymentSetup(orderId) {
  getDb().prepare("INSERT INTO booking_payment_setup (order_id, booking_ref) VALUES (?, ?)")
    .run(orderId, randomUUID());
}

export function getPaymentSetup(orderId) {
  return getDb().prepare("SELECT * FROM booking_payment_setup WHERE order_id = ?").get(orderId);
}

export function getPaymentSetupByGatewayRef(gatewayRef) {
  return getDb().prepare("SELECT * FROM booking_payment_setup WHERE gateway_ref = ?").get(gatewayRef);
}

export function getPreparedIntent(setup, paymentStatus) {
  if (!setup?.intent_json) return null;
  const intent = { ...JSON.parse(setup.intent_json), order_id: setup.order_id };
  if (paymentStatus === "paid" || paymentStatus === "refunded") intent.status = "succeeded";
  return intent;
}

export function requirePaymentSetupReady(orderId) {
  if (getPaymentSetup(orderId)?.state === "pending") {
    throw new ConflictError("payment setup is still pending");
  }
}

function finishSetup(order, setup, intent) {
  const db = getDb();
  db.transaction(() => {
    const state = intent ? "ready" : "rejected";
    const changed = db.prepare(`
      UPDATE booking_payment_setup SET state = ?, gateway_ref = ?, intent_json = ?
       WHERE booking_ref = ? AND state = 'pending'
    `).run(state, intent?.gateway_ref ?? null, intent ? JSON.stringify(intent) : null, setup.booking_ref).changes;
    if (!changed) return;

    if (!intent) {
      if (!booking.cancelAtomic(order.id, order.customer_id)) {
        throw new ConflictError("pending payment booking could not be cancelled");
      }
      booking.deleteSlotHoldsForOrder(order.id);
      return;
    }

    // Publish a usable booking to the provider only after the intent exists.
    insertEvent("booking.status_changed", "order", order.id, {
      order_id: order.id, from: null, to: "awaiting",
      customer_id: order.customer_id, provider_id: order.provider_id, actor_role: "customer",
    });
  }).immediate();
}

async function advanceSetup(orderId) {
  const setup = getPaymentSetup(orderId);
  if (setup?.state !== "pending") return setup;
  const order = booking.findOrderById(orderId);

  let response, result;
  try {
    const body = {
      booking_ref: setup.booking_ref, order_id: order.id, customer_id: order.customer_id,
      provider_id: order.provider_id, amount_cents: order.total_cents,
    };
    if (config.paymentsOwnsLedger) {
      ({ response, result } = await paymentsRequest("/internal/payment-intents", { body }));
    } else {
      // Isolated tests exercise the setup protocol with an in-process HTTP stub.
      response = await fetch(new URL("/internal/payment-intents", config.paymentsServiceUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.paymentsTimeoutMs),
      });
      result = await response.json();
    }
  } catch (err) {
    logger.debug({ orderId, err: err.message }, "payment setup outcome unknown; will retry");
    return setup;
  }

  if (response.status === 422 && result?.code === "payment_setup_rejected") {
    finishSetup(order, setup, null);
  } else if (response.ok && result?.booking_ref === setup.booking_ref
    && result?.amount_cents === order.total_cents && result?.status === "requires_payment"
    && Number.isSafeInteger(result?.id) && typeof result?.gateway_ref === "string") {
    const { id, gateway_ref, amount_cents, status } = result;
    finishSetup(order, setup, { id, gateway_ref, amount_cents, status });
  } else {
    logger.warn({ orderId, status: response.status }, "payment setup response did not resolve outcome");
    return setup;
  }
  return getPaymentSetup(orderId);
}

export function advancePaymentSetup(orderId) {
  if (inProgress.has(orderId)) return inProgress.get(orderId);
  const work = advanceSetup(orderId).finally(() => inProgress.delete(orderId));
  inProgress.set(orderId, work);
  return work;
}

export function startPaymentSetupWorker() {
  if (globalThis[WORKER]) return;
  const run = async () => {
    try {
      const pending = getDb().prepare(
        "SELECT order_id FROM booking_payment_setup WHERE state = 'pending' ORDER BY order_id LIMIT 25"
      ).all();
      await Promise.allSettled(pending.map(({ order_id }) => advancePaymentSetup(order_id)));
    } finally {
      globalThis[WORKER] = setTimeout(() => run().catch(
        (err) => logger.error({ err: err.message }, "payment setup worker failed")
      ), 2000).unref();
    }
  };
  globalThis[WORKER] = setTimeout(() => run().catch(
    (err) => logger.error({ err: err.message }, "payment setup worker failed")
  ), 2000).unref();
}
