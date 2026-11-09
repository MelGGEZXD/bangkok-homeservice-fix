// Payments & Wallet context owns payment_intents, transactions, provider_wallets, webhook_events.
// SQL only. The webhook insert relies on webhook_events.gateway_event_id UNIQUE for replay dedupe;
// the wallet credits are plain conditional arithmetic meant to run inside a caller's transaction.
import { getDb } from "../../db/index.js";

// ---- payment_intents ----
export function insertPaymentIntent({ orderId, amountCents, gatewayRef }) {
  return getDb()
    .prepare("INSERT INTO payment_intents (order_id, amount_cents, gateway_ref) VALUES (?, ?, ?)")
    .run(orderId, amountCents, gatewayRef).lastInsertRowid;
}
export function findIntentById(id) {
  return getDb().prepare("SELECT * FROM payment_intents WHERE id = ?").get(id);
}
export function findIntentByOrderId(orderId) {
  return getDb().prepare("SELECT * FROM payment_intents WHERE order_id = ?").get(orderId);
}
export function findIntentByGatewayRef(gatewayRef) {
  return getDb().prepare("SELECT * FROM payment_intents WHERE gateway_ref = ?").get(gatewayRef);
}
export function markIntentSucceeded(id) {
  return getDb()
    .prepare("UPDATE payment_intents SET status = 'succeeded' WHERE id = ? AND status = 'requires_payment'")
    .run(id).changes;
}

// ---- transactions ----
export function insertTransaction(t) {
  return getDb()
    .prepare(
      `INSERT INTO transactions (order_id, customer_id, provider_id, kind, amount_cents, method, gateway_ref, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      t.orderId ?? null, t.customerId ?? null, t.providerId ?? null, t.kind, t.amountCents,
      t.method, t.gatewayRef ?? null, t.status ?? "succeeded"
    ).lastInsertRowid;
}
export function listTransactionsForProvider(providerId) {
  return getDb().prepare("SELECT * FROM transactions WHERE provider_id = ? ORDER BY id DESC").all(providerId);
}
export function listTransactionsForCustomer(customerId) {
  return getDb().prepare("SELECT * FROM transactions WHERE customer_id = ? ORDER BY id DESC").all(customerId);
}
export function countTransactionsByKindForOrder(orderId, kind) {
  return getDb().prepare("SELECT COUNT(*) AS n FROM transactions WHERE order_id = ? AND kind = ?").get(orderId, kind).n;
}

// ---- provider_wallets ----
export function findWallet(providerId) {
  return getDb().prepare("SELECT * FROM provider_wallets WHERE provider_id = ?").get(providerId);
}
export function creditBalance(providerId, amountCents) {
  return getDb()
    .prepare("UPDATE provider_wallets SET balance_cents = balance_cents + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE provider_id = ?")
    .run(amountCents, providerId).changes;
}
export function addCommissionOwed(providerId, amountCents) {
  return getDb()
    .prepare("UPDATE provider_wallets SET commission_owed_cents = commission_owed_cents + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE provider_id = ?")
    .run(amountCents, providerId).changes;
}

// ---- webhook_events : the replay dedupe ----
// Returns true on a fresh insert; false if the gateway_event_id was already recorded (a replay).
export function recordWebhookEvent(gatewayEventId, type, payloadJson) {
  try {
    getDb()
      .prepare("INSERT INTO webhook_events (gateway_event_id, type, payload_json) VALUES (?, ?, ?)")
      .run(gatewayEventId, type, payloadJson);
    return true;
  } catch (err) {
    if (err && err.code === "SQLITE_CONSTRAINT_UNIQUE") return false;
    throw err;
  }
}
export function markWebhookProcessed(gatewayEventId) {
  getDb()
    .prepare("UPDATE webhook_events SET processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE gateway_event_id = ?")
    .run(gatewayEventId);
}
