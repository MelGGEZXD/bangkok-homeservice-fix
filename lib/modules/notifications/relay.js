// The outbox relay — the sole consumer of the shared `events` table. Started once from
// instrumentation.js as setInterval(runRelayOnce, 1000); also exported so tests can drain it
// synchronously. Every domain event is claimed exactly once (processed_at) before dispatch, so a
// second pass over the same event is a no-op — the relay is idempotent.
//
// Notifications themselves now live in the extracted notifications service. The relay only DELIVERS
// a notification command across the boundary; it never writes the notifications table. The service
// dedupes on (source_event_id, recipient, type), which is what makes re-delivery safe if we release
// a failed event for retry.
//
// THE rating aggregate is recomputed HERE, driven by the review.created event, never inline in the
// review handler. That is the deliberate eventual-consistency contrast the course teaches.
import { listUnprocessed, claim, release } from "../../db/events.js";
import { logger } from "../../logger.js";
import { deliver } from "./client.js";
import * as catalogRepository from "../catalog/repository.js";
import * as providersRepository from "../providers/repository.js";

const RELAY = Symbol.for("edemand.relay.interval");

async function notify(event, recipientRole, recipientId, type, title, body, orderId = null) {
  await deliver({
    source_event_id: event.event_uid,
    recipient_role: recipientRole,
    recipient_id: recipientId,
    type,
    title,
    body,
    order_id: orderId,
  });
}

async function dispatch(event) {
  const payload = JSON.parse(event.payload_json);
  switch (event.type) {
    case "review.created": {
      // Eventual consistency: recompute the service AND provider aggregates from the reviews table.
      catalogRepository.recomputeRatingAggregate(payload.service_id);
      providersRepository.recomputeRatingAggregate(payload.provider_id);
      await notify(
        event,
        "provider", payload.provider_id, "new_review", "New review",
        `You received a ${payload.rating}-star review on booking #${payload.order_id}.`,
        payload.order_id
      );
      break;
    }
    case "provider.approved": {
      await notify(
        event,
        "provider", payload.provider_id, "provider_approved", "You're approved",
        "Your provider account has been approved. Your services are now visible to customers."
      );
      break;
    }
    case "booking.status_changed": {
      // Notify the counterparty of whoever drove the transition.
      const toCustomer = payload.actor_role === "provider";
      const recipientRole = toCustomer ? "customer" : "provider";
      const recipientId = toCustomer ? payload.customer_id : payload.provider_id;
      await notify(
        event,
        recipientRole, recipientId, "booking_status",
        `Booking ${payload.to}`,
        `Booking #${payload.order_id} is now ${payload.to}.`,
        payload.order_id
      );
      break;
    }
    case "booking.completed": {
      await notify(
        event,
        "customer", payload.customer_id, "rating_request", "How did it go?",
        `Booking #${payload.order_id} is complete — leave a review for your provider.`,
        payload.order_id
      );
      break;
    }
    case "bid.accepted": {
      await notify(
        event,
        "provider", payload.winner_provider_id, "bid_accepted", "Your bid was accepted",
        `Your bid on job #${payload.job_request_id} was accepted — booking #${payload.order_id} created.`,
        payload.order_id
      );
      for (const loserId of payload.loser_provider_ids || []) {
        await notify(
          event,
          "provider", loserId, "bid_rejected", "Bid not selected",
          `Your bid on job #${payload.job_request_id} was not selected.`
        );
      }
      break;
    }
    case "payment.succeeded": {
      if (payload.provider_id != null) {
        await notify(
          event,
          "provider", payload.provider_id, "payment_received", "Payment received",
          `Payment of ${payload.amount_cents} cents was received for booking #${payload.order_id}.`,
          payload.order_id
        );
      }
      break;
    }
    default:
      logger.warn({ type: event.type, id: event.id }, "relay: unknown event type");
  }
}

// Drain up to 100 unprocessed events. Each is claimed (processed_at) before dispatch; a concurrent
// or repeated pass that loses the claim skips the event. If delivery across the boundary fails we
// release the claim so the next pass retries — at-least-once, with the service deduping the effect.
// Returns the number of events processed successfully.
export async function runRelayOnce() {
  const rows = listUnprocessed(100);
  let processed = 0;
  for (const event of rows) {
    if (claim(event.id) === 0) continue; // someone else already claimed it
    try {
      await dispatch(event);
      processed += 1;
    } catch (err) {
      release(event.id);
      logger.error({ err: err.message, eventId: event.id }, "relay: dispatch failed; released for retry");
    }
  }
  return processed;
}

export function startRelay() {
  if (globalThis[RELAY]) return;
  const handle = setInterval(() => {
    runRelayOnce().catch((err) => {
      logger.error({ err: err.message }, "relay: pass failed");
    });
  }, 1000);
  // Don't keep the process alive solely for the relay.
  if (typeof handle.unref === "function") handle.unref();
  globalThis[RELAY] = handle;
  logger.info("outbox relay started");
}

export function stopRelay() {
  if (globalThis[RELAY]) {
    clearInterval(globalThis[RELAY]);
    globalThis[RELAY] = undefined;
  }
}
