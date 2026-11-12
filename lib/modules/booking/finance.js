// Booking persists delivery requests locally. Payments owns the financial outcome and dedupes retries.
import { randomUUID } from "node:crypto";
import { getDb } from "../../db/index.js";
import { insertEvent } from "../../db/events.js";
import { AppError, ConflictError, NotFoundError } from "../../errors.js";
import { logger } from "../../logger.js";
import { callPayments } from "../payments/client.js";
import { getPaymentSetup, getPaymentSetupByGatewayRef } from "./payment-setup.js";
import { findOrderById, markPaid, markRefunded } from "./repository.js";

const WORKER = Symbol.for("edemand.bookingFinanceWorker");
const active = new Map();

function enqueue(ref, orderId, path, body) {
  getDb().prepare(`INSERT INTO booking_finance_operations (ref, order_id, path, body)
    VALUES (?, ?, ?, ?) ON CONFLICT (ref) DO NOTHING`).run(ref, orderId, path, JSON.stringify(body));
  return ref;
}

export function queueWalletCredit(order, amount) {
  const operationRef = randomUUID();
  return enqueue(operationRef, order.id, "/internal/wallet-credits", {
    operation_ref: operationRef, order_id: order.id, customer_id: order.customer_id,
    provider_id: order.provider_id, method: order.payment_method, amount_cents: amount,
    booking_ref: getPaymentSetup(order.id)?.booking_ref,
  });
}

export function queuePaymentClose(orderId) {
  const setup = getPaymentSetup(orderId);
  if (!setup?.gateway_ref) return null;
  return enqueue(`close:${setup.booking_ref}`, orderId,
    `/internal/intents/${encodeURIComponent(setup.gateway_ref)}/close`, {});
}

async function deliver(ref) {
  const db = getDb();
  const operation = db.prepare("SELECT * FROM booking_finance_operations WHERE ref = ?").get(ref);
  try {
    const result = await callPayments(operation.path, { body: JSON.parse(operation.body) });
    db.transaction(() => {
      const order = findOrderById(operation.order_id);
      if (operation.path === "/internal/settlements" && result.status === "succeeded"
          && order.payment_status === "pending" && order.status !== "cancelled") {
        markPaid(order.id);
        insertEvent("payment.succeeded", "order", order.id, {
          order_id: order.id, provider_id: order.provider_id, amount_cents: order.total_cents,
        });
      }
      if (result.status === "refunded" && order.status === "cancelled" && order.payment_status !== "refunded") {
        markRefunded(order.id);
      }
      db.prepare("DELETE FROM booking_finance_operations WHERE ref = ?").run(ref);
    }).immediate();
    return result;
  } catch (err) {
    if (operation.path === "/internal/settlements" && [404, 409].includes(err.statusCode)) {
      db.prepare("DELETE FROM booking_finance_operations WHERE ref = ?").run(ref);
    } else {
      db.prepare("UPDATE booking_finance_operations SET next_attempt_at = ? WHERE ref = ?")
        .run(Date.now() + 3000, ref);
    }
    throw err;
  }
}

export function deliverFinance(ref) {
  if (active.has(ref)) return active.get(ref);
  const work = deliver(ref).finally(() => active.delete(ref));
  active.set(ref, work);
  return work;
}

export async function settleBookingPayment(payload) {
  const setup = getPaymentSetupByGatewayRef(payload.gateway_ref);
  if (!setup) throw new NotFoundError("payment intent not found");
  const ref = `settle:${payload.gateway_event_id}`;
  const db = getDb();
  enqueue(ref, setup.order_id, "/internal/settlements", payload);
  const queued = JSON.parse(db.prepare("SELECT body FROM booking_finance_operations WHERE ref = ?").get(ref).body);
  if (queued.gateway_ref !== payload.gateway_ref || queued.type !== payload.type) {
    throw new ConflictError("event ID already belongs to another payment event");
  }
  const { status, booking_ref, ...result } = await deliverFinance(ref);
  return result;
}

export async function tryDeliverFinance(ref) {
  if (!ref) return null;
  try {
    return await deliverFinance(ref);
  } catch (err) {
    logger.warn({ operationRef: ref, status: err instanceof AppError ? err.statusCode : 500 },
      "booking finance delivery pending");
    return null;
  }
}

export function startBookingFinanceWorker() {
  if (globalThis[WORKER]) return;
  const tick = async () => {
    try {
      const rows = getDb().prepare(`SELECT ref FROM booking_finance_operations
        WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 25`).all(Date.now());
      await Promise.all(rows.map(({ ref }) => tryDeliverFinance(ref)));
    } catch (err) {
      logger.error({ err: err.message }, "booking finance worker failed");
    } finally {
      globalThis[WORKER] = setTimeout(tick, 2000).unref();
    }
  };
  globalThis[WORKER] = setTimeout(tick, 2000).unref();
}
