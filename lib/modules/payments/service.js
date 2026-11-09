// Payments & Wallet business logic. The webhook is the marquee idempotency hook: the gateway's
// event id is the dedupe key, and webhook_events.gateway_event_id UNIQUE means a replayed callback
// does nothing (no double-credit). Everything runs inside one .immediate() transaction.
import { getDb } from "../../db/index.js";
import * as repository from "./repository.js";
import * as bookingRepository from "../booking/repository.js";
import { insertEvent } from "../../db/events.js";
import { NotFoundError } from "../../errors.js";

function publicTransaction(row) {
  return {
    id: row.id,
    order_id: row.order_id,
    kind: row.kind,
    amount_cents: row.amount_cents,
    method: row.method,
    gateway_ref: row.gateway_ref,
    status: row.status,
    created_at: row.created_at,
  };
}

// Idempotent webhook. `{ gateway_event_id, type, gateway_ref }`. Returns {replayed:true} for a
// duplicate event id (still a 200 to the caller — the gateway sees success and stops retrying).
export function handleWebhook(payload) {
  const run = getDb().transaction(() => {
    const fresh = repository.recordWebhookEvent(
      payload.gateway_event_id,
      payload.type,
      JSON.stringify(payload)
    );
    if (!fresh) {
      // A replay hit the UNIQUE constraint and did NOTHING. This is the dedupe.
      return { replayed: true };
    }

    const intent = repository.findIntentByGatewayRef(payload.gateway_ref);
    if (!intent) throw new NotFoundError(`payment intent ${payload.gateway_ref} not found`);

    // Conditional flip; if it was already succeeded this matches 0 rows and we skip the credit.
    const flipped = repository.markIntentSucceeded(intent.id);
    if (flipped === 0) {
      repository.markWebhookProcessed(payload.gateway_event_id);
      return { replayed: false, already_settled: true };
    }

    const order = bookingRepository.findOrderById(intent.order_id);
    bookingRepository.markPaid(intent.order_id);
    repository.insertTransaction({
      orderId: intent.order_id,
      customerId: order ? order.customer_id : null,
      providerId: order ? order.provider_id : null,
      kind: "charge",
      amountCents: intent.amount_cents,
      method: "gateway",
      gatewayRef: payload.gateway_ref,
      status: "succeeded",
    });
    insertEvent("payment.succeeded", "order", intent.order_id, {
      order_id: intent.order_id,
      provider_id: order ? order.provider_id : null,
      amount_cents: intent.amount_cents,
    });
    repository.markWebhookProcessed(payload.gateway_event_id);
    return { replayed: false, settled: true };
  });
  return run.immediate();
}

export function getWallet(providerId) {
  const wallet = repository.findWallet(providerId);
  return {
    provider_id: providerId,
    balance_cents: wallet ? wallet.balance_cents : 0,
    commission_owed_cents: wallet ? wallet.commission_owed_cents : 0,
    transactions: repository.listTransactionsForProvider(providerId).map(publicTransaction),
  };
}

export function listCustomerTransactions(customerId) {
  return repository.listTransactionsForCustomer(customerId).map(publicTransaction);
}

export function getIntentForOrder(orderId) {
  return repository.findIntentByOrderId(orderId);
}
