// The mock payment gateway. The real product integrates a hosted checkout that calls back a
// webhook; here "Pay now (simulate)" drives this, which mints a gateway event id and posts it
// through the same settlement path. Each click has a distinct event ID; the settled state
// prevents two successful charge records for the same intent.
import { randomUUID } from "node:crypto";
import * as repository from "./repository.js";
import { handleWebhook } from "./service.js";
import { NotFoundError, ForbiddenError, ConflictError } from "../../errors.js";
import * as bookingRepository from "../booking/repository.js";
import { getPaymentSetup, getPreparedIntent } from "../booking/payment-setup.js";
import { config } from "../../config.js";

export async function simulateSucceeded(orderId, customerId) {
  const order = bookingRepository.findOrderById(orderId);
  if (!order) throw new NotFoundError(`booking ${orderId} not found`);
  if (order.customer_id !== customerId) throw new ForbiddenError("you are not the customer on this booking");
  const setup = getPaymentSetup(orderId);
  const intent = setup ? getPreparedIntent(setup, order.payment_status)
    : config.paymentsOwnsLedger ? null : repository.findIntentByOrderId(orderId);
  if (!intent) throw new ConflictError("this booking has no gateway payment to settle");
  if (config.paymentsOwnsLedger && order.status === "cancelled" && order.payment_status === "pending") {
    throw new ConflictError("cancelled booking cannot be paid");
  }

  const result = await handleWebhook({
    gateway_event_id: `SIM-EVT-${randomUUID()}`,
    type: "payment_intent.succeeded",
    gateway_ref: intent.gateway_ref,
  });
  return { ok: true, ...result };
}
