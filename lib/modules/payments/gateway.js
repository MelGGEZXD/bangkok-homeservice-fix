// The mock payment gateway. The real product integrates a hosted checkout that calls back a
// webhook; here "Pay now (simulate)" drives this, which mints a gateway event id and posts it
// through the very same idempotent webhook path (§3.3). A double-click therefore replays a
// duplicate event id and credits nothing twice — the teaching point, exercised from the UI.
import { randomUUID } from "node:crypto";
import * as repository from "./repository.js";
import { handleWebhook } from "./service.js";
import { NotFoundError, ForbiddenError, ConflictError } from "../../errors.js";
import * as bookingRepository from "../booking/repository.js";

export function simulateSucceeded(orderId, customerId) {
  const order = bookingRepository.findOrderById(orderId);
  if (!order) throw new NotFoundError(`booking ${orderId} not found`);
  if (order.customer_id !== customerId) throw new ForbiddenError("you are not the customer on this booking");
  const intent = repository.findIntentByOrderId(orderId);
  if (!intent) throw new ConflictError("this booking has no gateway payment to settle");

  const result = handleWebhook({
    gateway_event_id: `SIM-EVT-${randomUUID()}`,
    type: "payment_intent.succeeded",
    gateway_ref: intent.gateway_ref,
  });
  return { ok: true, ...result };
}
