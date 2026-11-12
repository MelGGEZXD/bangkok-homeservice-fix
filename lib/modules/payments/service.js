// Compose uses the extracted ledger. Standalone and isolated tests retain their local ledger.
import { getDb } from "../../db/index.js";
import * as repository from "./repository.js";
import * as bookingRepository from "../booking/repository.js";
import { insertEvent } from "../../db/events.js";
import { ConflictError, NotFoundError } from "../../errors.js";
import { getPaymentSetupByGatewayRef, getPreparedIntent } from "../booking/payment-setup.js";
import { config } from "../../config.js";
import { callPayments } from "./client.js";
import { settleBookingPayment } from "../booking/finance.js";

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
  if (config.paymentsOwnsLedger) return settleBookingPayment(payload);
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

    // The isolated setup test exercises the remote-intent protocol with a local ledger.
    const setup = getPaymentSetupByGatewayRef(payload.gateway_ref);
    const intent = setup ? getPreparedIntent(setup) : repository.findIntentByGatewayRef(payload.gateway_ref);
    if (!intent) throw new NotFoundError(`payment intent ${payload.gateway_ref} not found`);

    const order = bookingRepository.findOrderById(intent.order_id);
    if (setup && order.status === "cancelled" && order.payment_status === "pending") {
      throw new ConflictError("cancelled booking cannot be paid");
    }
    // Conditional flip; if it was already succeeded this matches 0 rows and we skip the credit.
    const flipped = setup ? order.payment_status === "pending" : repository.markIntentSucceeded(intent.id);
    if (!flipped) {
      repository.markWebhookProcessed(payload.gateway_event_id);
      return { replayed: false, already_settled: true };
    }

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

export function getWallet(providerId, token) {
  if (config.paymentsOwnsLedger) return callPayments("/api/provider/wallet", { token });
  const wallet = repository.findWallet(providerId);
  return {
    provider_id: providerId,
    balance_cents: wallet ? wallet.balance_cents : 0,
    commission_owed_cents: wallet ? wallet.commission_owed_cents : 0,
    transactions: repository.listTransactionsForProvider(providerId).map(publicTransaction),
  };
}

export function listCustomerTransactions(customerId, token) {
  if (config.paymentsOwnsLedger) return callPayments("/api/customer/transactions", { token });
  return repository.listTransactionsForCustomer(customerId).map(publicTransaction);
}
