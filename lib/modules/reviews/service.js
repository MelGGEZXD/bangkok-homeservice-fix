// Reviews business logic. A customer reviews their own completed booking, exactly once. The review
// row AND a review.created outbox event are written in ONE transaction — but the rating aggregate
// is NOT recomputed here. That happens in the relay, driven by the event. This is the deliberate
// contrast with Ride (which updates the aggregate inline): eDemand teaches eventual consistency +
// the outbox, so a fresh review leaves the service aggregate momentarily stale until the relay runs.
import { getDb } from "../../db/index.js";
import { insertEvent } from "../../db/events.js";
import * as repository from "./repository.js";
import * as bookingRepository from "../booking/repository.js";
import * as catalogRepository from "../catalog/repository.js";
import { NotFoundError, ForbiddenError, ConflictError } from "../../errors.js";

function publicReview(row) {
  return {
    id: row.id,
    order_id: row.order_id,
    customer_id: row.customer_id,
    provider_id: row.provider_id,
    service_id: row.service_id,
    rating: row.rating,
    comment: row.comment,
    created_at: row.created_at,
  };
}

export function createReview(orderId, customerId, { rating, comment }) {
  const order = bookingRepository.findOrderById(orderId);
  if (!order) throw new NotFoundError(`booking ${orderId} not found`);
  if (order.customer_id !== customerId) throw new ForbiddenError("you are not the customer on this booking");
  if (order.status !== "completed") throw new ConflictError("only a completed booking can be reviewed");
  if (repository.findByOrderId(orderId)) throw new ConflictError("this booking has already been reviewed");

  const items = bookingRepository.listOrderItems(orderId);
  if (items.length === 0) throw new ConflictError("this booking has no reviewable service");
  const serviceId = items[0].service_id;

  const run = getDb().transaction(() => {
    const reviewId = repository.insertReview({
      orderId,
      customerId,
      providerId: order.provider_id,
      serviceId,
      rating,
      comment,
    });
    // Outbox event — the relay recomputes the service + provider aggregates and notifies the
    // provider. NOT recomputed here.
    insertEvent("review.created", "review", reviewId, {
      review_id: reviewId,
      order_id: orderId,
      service_id: serviceId,
      provider_id: order.provider_id,
      customer_id: customerId,
      rating,
    });
    return repository.findById(reviewId);
  });
  return publicReview(run.immediate());
}

export function listServiceReviews(serviceId) {
  const service = catalogRepository.findServiceRaw(serviceId);
  if (!service) throw new NotFoundError(`service ${serviceId} not found`);
  return {
    service_id: serviceId,
    rating_avg: service.rating_avg,
    rating_count: service.rating_count,
    reviews: repository.listForService(serviceId).map(publicReview),
  };
}
