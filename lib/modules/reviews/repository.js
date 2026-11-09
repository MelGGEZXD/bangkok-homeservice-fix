// Reviews context owns the reviews table. SQL only. reviews.order_id UNIQUE enforces one review
// per completed booking.
import { getDb } from "../../db/index.js";
import { ConflictError } from "../../errors.js";

export function insertReview(r) {
  try {
    return getDb()
      .prepare(
        `INSERT INTO reviews (order_id, customer_id, provider_id, service_id, rating, comment)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(r.orderId, r.customerId, r.providerId, r.serviceId, r.rating, r.comment ?? null).lastInsertRowid;
  } catch (err) {
    if (err && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new ConflictError("this booking has already been reviewed");
    }
    throw err;
  }
}

export function findById(id) {
  return getDb().prepare("SELECT * FROM reviews WHERE id = ?").get(id);
}
export function findByOrderId(orderId) {
  return getDb().prepare("SELECT * FROM reviews WHERE order_id = ?").get(orderId);
}
export function findByEventTarget(eventId) {
  return getDb().prepare("SELECT * FROM reviews WHERE id = ?").get(eventId);
}
export function listForService(serviceId) {
  return getDb().prepare("SELECT * FROM reviews WHERE service_id = ? ORDER BY id DESC").all(serviceId);
}
