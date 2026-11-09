// Booking context owns orders, order_items, slot_holds, addresses. SQL only — including the
// conditional UPDATEs that ARE the state-machine concurrency control (no "SELECT then check in JS
// then UPDATE"; every transition is one UPDATE with the precondition in its WHERE clause) and the
// slot_holds insert whose UNIQUE index is the double-book guard.
import { getDb } from "../../db/index.js";
import { ConflictError } from "../../errors.js";

// ---- addresses ----
export function listAddresses(customerId) {
  return getDb().prepare("SELECT * FROM addresses WHERE customer_id = ? ORDER BY is_default DESC, id").all(customerId);
}
export function findAddress(id) {
  return getDb().prepare("SELECT * FROM addresses WHERE id = ?").get(id);
}
export function insertAddress(customerId, { label, line1, area, city, lat, lng, is_default }) {
  return getDb()
    .prepare(
      "INSERT INTO addresses (customer_id, label, line1, area, city, lat, lng, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(customerId, label, line1, area ?? null, city, lat ?? null, lng ?? null, is_default ? 1 : 0).lastInsertRowid;
}

// ---- orders ----
export function insertOrder(o) {
  return getDb()
    .prepare(
      `INSERT INTO orders
         (customer_id, provider_id, address_id, service_date, starting_time, ending_time, duration_min,
          subtotal_cents, tax_cents, total_cents, commission_pct, payment_method, otp, job_request_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting')`
    )
    .run(
      o.customerId, o.providerId, o.addressId ?? null, o.serviceDate, o.startingTime, o.endingTime,
      o.durationMin, o.subtotalCents, o.taxCents, o.totalCents, o.commissionPct, o.paymentMethod,
      o.otp, o.jobRequestId ?? null
    ).lastInsertRowid;
}

export function findOrderById(id) {
  return getDb().prepare("SELECT * FROM orders WHERE id = ?").get(id);
}

export function listForCustomer(customerId, { status, limit, offset }) {
  const clause = status ? "AND status = ?" : "";
  const args = status ? [customerId, status, limit, offset] : [customerId, limit, offset];
  return getDb()
    .prepare(`SELECT * FROM orders WHERE customer_id = ? ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args);
}
export function countForCustomer(customerId, status) {
  const clause = status ? "AND status = ?" : "";
  const args = status ? [customerId, status] : [customerId];
  return getDb().prepare(`SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? ${clause}`).get(...args).n;
}
export function listForProvider(providerId, { status, limit, offset }) {
  const clause = status ? "AND status = ?" : "";
  const args = status ? [providerId, status, limit, offset] : [providerId, limit, offset];
  return getDb()
    .prepare(`SELECT * FROM orders WHERE provider_id = ? ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args);
}
export function countForProvider(providerId, status) {
  const clause = status ? "AND status = ?" : "";
  const args = status ? [providerId, status] : [providerId];
  return getDb().prepare(`SELECT COUNT(*) AS n FROM orders WHERE provider_id = ? ${clause}`).get(...args).n;
}

export function listAllOrders({ status, limit, offset }) {
  const clause = status ? "WHERE status = ?" : "";
  const args = status ? [status, limit, offset] : [limit, offset];
  return getDb().prepare(`SELECT * FROM orders ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args);
}
export function countAllOrders(status) {
  const clause = status ? "WHERE status = ?" : "";
  const args = status ? [status] : [];
  return getDb().prepare(`SELECT COUNT(*) AS n FROM orders ${clause}`).get(...args).n;
}

// ---- order_items ----
export function insertOrderItem(orderId, it) {
  getDb()
    .prepare(
      `INSERT INTO order_items (order_id, service_id, service_title, unit_price_cents, tax_percent, tax_cents, quantity, subtotal_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(orderId, it.serviceId, it.serviceTitle, it.unitPriceCents, it.taxPercent, it.taxCents, it.quantity, it.subtotalCents);
}
export function listOrderItems(orderId) {
  return getDb().prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id").all(orderId);
}

// ---- slot_holds : THE double-book guard ----
// One INSERT per 30-min slot. The UNIQUE(provider_id, service_date, slot_time) index makes a clash
// a storage-layer impossibility: the second writer's INSERT raises SQLITE_CONSTRAINT_UNIQUE, which
// rolls the surrounding transaction back. We translate it to a domain ConflictError right here.
export function insertSlotHold(providerId, serviceDate, slotTime, orderId) {
  try {
    getDb()
      .prepare("INSERT INTO slot_holds (provider_id, service_date, slot_time, order_id) VALUES (?, ?, ?, ?)")
      .run(providerId, serviceDate, slotTime, orderId);
  } catch (err) {
    if (err && err.code === "SQLITE_CONSTRAINT_UNIQUE" && String(err.message).includes("slot_holds")) {
      throw new ConflictError("slot no longer available");
    }
    throw err;
  }
}
export function deleteSlotHoldsForOrder(orderId) {
  return getDb().prepare("DELETE FROM slot_holds WHERE order_id = ?").run(orderId).changes;
}
export function heldSlotTimes(providerId, serviceDate) {
  return getDb()
    .prepare("SELECT slot_time FROM slot_holds WHERE provider_id = ? AND service_date = ?")
    .all(providerId, serviceDate)
    .map((r) => r.slot_time);
}

// ---- atomic state transitions (precondition baked into WHERE) ----
export function confirmAtomic(orderId, providerId) {
  return getDb()
    .prepare("UPDATE orders SET status = 'confirmed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND provider_id = ? AND status = 'awaiting'")
    .run(orderId, providerId).changes;
}
export function startAtomic(orderId, providerId) {
  // A booking rescheduled after confirmation is still startable.
  return getDb()
    .prepare("UPDATE orders SET status = 'started', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND provider_id = ? AND status IN ('confirmed','rescheduled')")
    .run(orderId, providerId).changes;
}
// THE OTP gate + exactly-once wallet-credit precondition: only a 'started' row owned by this
// provider WITH the matching OTP flips to 'completed'. A replay or a wrong OTP matches zero rows.
export function completeAtomic(orderId, providerId, otp, commissionCents, earningsCents) {
  return getDb()
    .prepare(
      `UPDATE orders
       SET status = 'completed', commission_cents = ?, provider_earnings_cents = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND provider_id = ? AND status = 'started' AND otp = ?`
    )
    .run(commissionCents, earningsCents, orderId, providerId, otp).changes;
}
export function cancelAtomic(orderId, customerId) {
  return getDb()
    .prepare("UPDATE orders SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND customer_id = ? AND status IN ('awaiting','confirmed')")
    .run(orderId, customerId).changes;
}
export function rescheduleAtomic(orderId, serviceDate, startingTime, endingTime, durationMin) {
  return getDb()
    .prepare(
      `UPDATE orders
       SET service_date = ?, starting_time = ?, ending_time = ?, duration_min = ?, status = 'rescheduled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`
    )
    .run(serviceDate, startingTime, endingTime, durationMin, orderId).changes;
}
export function markPaid(orderId) {
  return getDb().prepare("UPDATE orders SET payment_status = 'paid' WHERE id = ?").run(orderId).changes;
}
export function markRefunded(orderId) {
  return getDb().prepare("UPDATE orders SET payment_status = 'refunded' WHERE id = ?").run(orderId).changes;
}
