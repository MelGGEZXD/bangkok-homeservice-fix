// The booking lifecycle + the transactional seams the course cares about:
//   awaiting -> confirmed -> started -> completed
//   awaiting|confirmed -> cancelled          (releases slot_holds, refunds a paid gateway order)
//   * -> rescheduled                         (re-holds slots atomically)
// Every transition writes an events row in the SAME transaction as the state change (the outbox).
// Place-booking is one .immediate() transaction (order + items + slot_holds + optional payment
// intent + outbox); completion is OTP-gated with an exactly-once wallet credit.
import { randomUUID } from "node:crypto";
import { getDb } from "../../db/index.js";
import { withIdempotency } from "../../db/idempotency.js";
import { insertEvent } from "../../db/events.js";
import * as repository from "./repository.js";
import * as catalogRepository from "../catalog/repository.js";
import * as providersRepository from "../providers/repository.js";
import * as paymentsRepository from "../payments/repository.js";
import { slotRange, timeToMinutes, minutesToTime, weekdayOf, todayDate } from "./slots.js";
import { NotFoundError, ForbiddenError, ConflictError, BadRequestError } from "../../errors.js";

const PLACE_ENDPOINT = "POST /api/bookings";

function round(n) {
  return Math.round(n);
}

export function toPublicOrder(row) {
  return {
    id: row.id,
    customer_id: row.customer_id,
    provider_id: row.provider_id,
    address_id: row.address_id,
    service_date: row.service_date,
    starting_time: row.starting_time,
    ending_time: row.ending_time,
    duration_min: row.duration_min,
    subtotal_cents: row.subtotal_cents,
    tax_cents: row.tax_cents,
    total_cents: row.total_cents,
    commission_pct: row.commission_pct,
    commission_cents: row.commission_cents,
    provider_earnings_cents: row.provider_earnings_cents,
    payment_method: row.payment_method,
    payment_status: row.payment_status,
    status: row.status,
    job_request_id: row.job_request_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function publicIntent(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    order_id: row.order_id,
    amount_cents: row.amount_cents,
    gateway_ref: row.gateway_ref,
    status: row.status,
  };
}

function assertParticipant(order, auth) {
  const isCustomer = auth.role === "customer" && order.customer_id === auth.sub;
  const isProvider = auth.role === "provider" && order.provider_id === auth.sub;
  if (!isCustomer && !isProvider) throw new ForbiddenError("you are not a participant on this booking");
}

// Validate that a [start, start+duration) window on `date` fits inside the provider's open hours
// for that weekday, and the date is not in the past. Returns the ending 'HH:MM'.
function validateWindow(providerId, date, startingTime, durationMin) {
  if (date < todayDate()) {
    throw new BadRequestError("validation failed", [{ path: "service_date", message: "service_date is in the past" }]);
  }
  const timing = providersRepository.findTiming(providerId, weekdayOf(date));
  if (!timing || !timing.is_open) {
    throw new BadRequestError("validation failed", [{ path: "service_date", message: "provider is closed on that day" }]);
  }
  const start = timeToMinutes(startingTime);
  const end = start + durationMin;
  const opening = timeToMinutes(timing.opening_time);
  const closing = timeToMinutes(timing.closing_time);
  if (start < opening || end > closing) {
    throw new BadRequestError("validation failed", [
      { path: "starting_time", message: "requested time is outside the provider's working hours" },
    ]);
  }
  return minutesToTime(end);
}

// ---------- the place-booking transaction ----------
export function placeBooking(customerId, input, idempotencyKey) {
  const { statusCode, body } = withIdempotency(idempotencyKey, PLACE_ENDPOINT, () => {
    // (idempotency keys are scoped to this customer — see the actor arg passed below)
    // 1. Load services; assert same provider, provider approved, status=1.
    if (!input.items || input.items.length === 0) {
      throw new BadRequestError("validation failed", [{ path: "items", message: "at least one item is required" }]);
    }
    const profile = providersRepository.findProfile(input.provider_id);
    if (!profile) throw new NotFoundError(`provider ${input.provider_id} not found`);
    if (!profile.is_approved) throw new ConflictError("provider is not approved");

    let addressId = null;
    if (input.address_id != null) {
      const addr = repository.findAddress(input.address_id);
      if (!addr || addr.customer_id !== customerId) {
        throw new BadRequestError("validation failed", [{ path: "address_id", message: "unknown address" }]);
      }
      addressId = addr.id;
    }

    const items = [];
    let subtotal = 0;
    let tax = 0;
    let duration = 0;
    for (const line of input.items) {
      const service = catalogRepository.findServiceRaw(line.service_id);
      if (!service) throw new NotFoundError(`service ${line.service_id} not found`);
      if (service.provider_id !== input.provider_id) {
        throw new BadRequestError("validation failed", [{ path: "items", message: "all services must belong to the same provider" }]);
      }
      if (service.status !== 1) throw new ConflictError(`service ${service.id} is not available`);
      const qty = line.quantity;
      const lineSubtotal = service.price_cents * qty;
      const lineTax = round((lineSubtotal * service.tax_percent) / 100);
      subtotal += lineSubtotal;
      tax += lineTax;
      duration += service.duration_min * qty;
      items.push({
        serviceId: service.id,
        serviceTitle: service.title,
        unitPriceCents: service.price_cents,
        taxPercent: service.tax_percent,
        taxCents: lineTax,
        quantity: qty,
        subtotalCents: lineSubtotal,
      });
    }

    // 2. window fits provider hours + not past.
    const endingTime = validateWindow(input.provider_id, input.service_date, input.starting_time, duration);
    const total = subtotal + tax;

    // 4. otp + commission snapshot.
    const otp = 100000 + Math.floor(Math.random() * 900000);
    const commissionPct = profile.commission_pct;

    // 5. order.
    const orderId = repository.insertOrder({
      customerId,
      providerId: input.provider_id,
      addressId,
      serviceDate: input.service_date,
      startingTime: input.starting_time,
      endingTime,
      durationMin: duration,
      subtotalCents: subtotal,
      taxCents: tax,
      totalCents: total,
      commissionPct,
      paymentMethod: input.payment_method,
      otp,
      jobRequestId: null,
    });

    // 6. items.
    for (const it of items) repository.insertOrderItem(orderId, it);

    // 7. slot_holds — the atomic conditional insert. A clash throws ConflictError (mapped in the
    //    repository) and rolls the whole transaction back: zero partial rows survive.
    for (const slot of slotRange(input.starting_time, duration)) {
      repository.insertSlotHold(input.provider_id, input.service_date, slot, orderId);
    }

    // 8. gateway bookings get a payment intent inside the same tx.
    let intent;
    if (input.payment_method === "gateway") {
      const intentId = paymentsRepository.insertPaymentIntent({
        orderId,
        amountCents: total,
        gatewayRef: `SIM-PI-${randomUUID()}`,
      });
      intent = paymentsRepository.findIntentById(intentId);
    }

    // 9. outbox event, same tx.
    insertEvent("booking.status_changed", "order", orderId, {
      order_id: orderId,
      from: null,
      to: "awaiting",
      customer_id: customerId,
      provider_id: input.provider_id,
      actor_role: "customer",
    });

    const order = repository.findOrderById(orderId);
    return {
      statusCode: 201,
      body: { order: toPublicOrder(order), otp, payment_intent: publicIntent(intent) },
    };
  }, customerId);

  return { statusCode, body };
}

// ---------- state transitions ----------
export function confirmBooking(orderId, providerId) {
  const order = repository.findOrderById(orderId);
  if (!order) throw new NotFoundError(`booking ${orderId} not found`);
  if (order.provider_id !== providerId) throw new ForbiddenError("you are not the provider on this booking");

  const run = getDb().transaction(() => {
    const changes = repository.confirmAtomic(orderId, providerId);
    if (changes === 0) throw new ConflictError(`cannot confirm booking from status '${order.status}'`);
    insertEvent("booking.status_changed", "order", orderId, {
      order_id: orderId, from: order.status, to: "confirmed",
      customer_id: order.customer_id, provider_id: providerId, actor_role: "provider",
    });
    return toPublicOrder(repository.findOrderById(orderId));
  });
  return run.immediate();
}

export function startBooking(orderId, providerId) {
  const order = repository.findOrderById(orderId);
  if (!order) throw new NotFoundError(`booking ${orderId} not found`);
  if (order.provider_id !== providerId) throw new ForbiddenError("you are not the provider on this booking");

  const run = getDb().transaction(() => {
    const changes = repository.startAtomic(orderId, providerId);
    if (changes === 0) throw new ConflictError(`cannot start booking from status '${order.status}'`);
    insertEvent("booking.status_changed", "order", orderId, {
      order_id: orderId, from: order.status, to: "started",
      customer_id: order.customer_id, provider_id: providerId, actor_role: "provider",
    });
    return toPublicOrder(repository.findOrderById(orderId));
  });
  return run.immediate();
}

// OTP-gated completion. The wallet credit lives *inside* the WHERE status='started' AND otp=?
// update, so a replay (or a second provider) matches zero rows and the balance is credited exactly
// once. Matches the real product's `otp==$otp` gate + `balance += total-commission` / `commission
// owed += commission` split, but made race-safe and idempotent.
export function completeBooking(orderId, providerId, otp) {
  const order = repository.findOrderById(orderId);
  if (!order) throw new NotFoundError(`booking ${orderId} not found`);
  if (order.provider_id !== providerId) throw new ForbiddenError("you are not the provider on this booking");
  if (otp === undefined || otp === null || Number.isNaN(otp)) {
    throw new BadRequestError("OTP is required");
  }

  const run = getDb().transaction(() => {
    const commission = round((order.total_cents * order.commission_pct) / 100);
    const earnings = order.total_cents - commission;

    const changes = repository.completeAtomic(orderId, providerId, otp, commission, earnings);
    if (changes === 0) {
      const fresh = repository.findOrderById(orderId);
      if (fresh.status === "completed") throw new ConflictError("booking is already completed");
      if (fresh.otp !== otp) throw new ConflictError("incorrect OTP");
      throw new ConflictError(`cannot complete booking from status '${fresh.status}'`);
    }

    if (order.payment_method === "gateway") {
      paymentsRepository.creditBalance(providerId, earnings);
      paymentsRepository.insertTransaction({
        orderId, customerId: order.customer_id, providerId,
        kind: "payout_credit", amountCents: earnings, method: "gateway",
      });
    } else {
      paymentsRepository.addCommissionOwed(providerId, commission);
      paymentsRepository.insertTransaction({
        orderId, customerId: order.customer_id, providerId,
        kind: "commission_owed", amountCents: commission, method: "cod",
      });
    }

    insertEvent("booking.completed", "order", orderId, {
      order_id: orderId, total_cents: order.total_cents, commission_cents: commission,
      provider_earnings_cents: earnings, customer_id: order.customer_id, provider_id: providerId,
    });
    insertEvent("booking.status_changed", "order", orderId, {
      order_id: orderId, from: "started", to: "completed",
      customer_id: order.customer_id, provider_id: providerId, actor_role: "provider",
    });

    return toPublicOrder(repository.findOrderById(orderId));
  });
  return run.immediate();
}

export function cancelBooking(orderId, customerId) {
  const order = repository.findOrderById(orderId);
  if (!order) throw new NotFoundError(`booking ${orderId} not found`);
  if (order.customer_id !== customerId) throw new ForbiddenError("you are not the customer on this booking");

  const run = getDb().transaction(() => {
    const changes = repository.cancelAtomic(orderId, customerId);
    if (changes === 0) throw new ConflictError(`cannot cancel booking from status '${order.status}'`);

    repository.deleteSlotHoldsForOrder(orderId);

    let refunded = false;
    if (order.payment_status === "paid") {
      repository.markRefunded(orderId);
      paymentsRepository.insertTransaction({
        orderId, customerId, providerId: order.provider_id,
        kind: "refund", amountCents: order.total_cents, method: "gateway", status: "refunded",
      });
      refunded = true;
    }

    insertEvent("booking.status_changed", "order", orderId, {
      order_id: orderId, from: order.status, to: "cancelled",
      customer_id: customerId, provider_id: order.provider_id, actor_role: "customer",
    });

    return { order: toPublicOrder(repository.findOrderById(orderId)), refunded };
  });
  return run.immediate();
}

export function rescheduleBooking(orderId, auth, { service_date, starting_time }) {
  const order = repository.findOrderById(orderId);
  if (!order) throw new NotFoundError(`booking ${orderId} not found`);
  assertParticipant(order, auth);
  if (["completed", "cancelled"].includes(order.status)) {
    throw new ConflictError(`cannot reschedule a ${order.status} booking`);
  }

  const run = getDb().transaction(() => {
    const endingTime = validateWindow(order.provider_id, service_date, starting_time, order.duration_min);
    // Drop this order's own holds first (so re-holding an overlapping window is fine), then re-hold.
    // A clash with ANOTHER order's holds throws ConflictError -> the whole tx rolls back, which
    // undoes the delete too, leaving the old holds intact.
    repository.deleteSlotHoldsForOrder(orderId);
    for (const slot of slotRange(starting_time, order.duration_min)) {
      repository.insertSlotHold(order.provider_id, service_date, slot, orderId);
    }
    repository.rescheduleAtomic(orderId, service_date, starting_time, endingTime, order.duration_min);
    insertEvent("booking.status_changed", "order", orderId, {
      order_id: orderId, from: order.status, to: "rescheduled",
      customer_id: order.customer_id, provider_id: order.provider_id, actor_role: auth.role,
    });
    return toPublicOrder(repository.findOrderById(orderId));
  });
  return run.immediate();
}

// ---------- reads ----------
export function getBooking(orderId, auth) {
  const order = repository.findOrderById(orderId);
  if (!order) throw new NotFoundError(`booking ${orderId} not found`);
  assertParticipant(order, auth);
  const intent = paymentsRepository.findIntentByOrderId(orderId);
  const out = {
    ...toPublicOrder(order),
    items: repository.listOrderItems(orderId),
    slot_times: repository.heldSlotTimes(order.provider_id, order.service_date).filter((s) => s), // advisory
    payment_intent: publicIntent(intent),
  };
  // OTP is the proof-of-presence code the customer reads to the provider — customer-only.
  if (auth.role === "customer") out.otp = order.otp;
  return out;
}

export function listBookings(auth, { status, page, size }) {
  const offset = (page - 1) * size;
  if (auth.role === "provider") {
    const items = repository.listForProvider(auth.sub, { status, limit: size, offset });
    const total = repository.countForProvider(auth.sub, status);
    return { items: items.map(toPublicOrder), total, page, size };
  }
  const items = repository.listForCustomer(auth.sub, { status, limit: size, offset });
  const total = repository.countForCustomer(auth.sub, status);
  return { items: items.map(toPublicOrder), total, page, size };
}

export function listAllBookings({ status, page, size }) {
  const offset = (page - 1) * size;
  const items = repository.listAllOrders({ status, limit: size, offset });
  const total = repository.countAllOrders(status);
  return { items: items.map(toPublicOrder), total, page, size };
}

// ---------- addresses (customer) ----------
export function listAddresses(customerId) {
  return repository.listAddresses(customerId);
}
export function addAddress(customerId, input) {
  const id = repository.insertAddress(customerId, input);
  return repository.findAddress(id);
}

// slot_holds count for an order (used by tests + the UI schedule view).
export function orderById(orderId) {
  return repository.findOrderById(orderId);
}
