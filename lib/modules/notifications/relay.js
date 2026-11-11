// The outbox relay — the sole reader of the shared `events` table. Started once from
// instrumentation.js as setInterval(runRelayOnce, 1000); also exported so tests can drain it
// synchronously.
//
// Area C: the relay now PUBLISHES the raw domain event to RabbitMQ. The notifications service
// consumes it and owns the event -> notification projection (notifications-service/notification-
// rules.cjs). The monolith therefore no longer knows how a notification is worded, and a second
// consumer can subscribe without changing this file.
//
// Local-only work still happens here before publishing: the rating aggregates are recomputed from
// this database, because they are Catalog/Provider state, not Notifications state.
//
// Delivery is at-least-once. Each row is claimed before dispatch; if the broker is unavailable the
// claim is released and the next pass retries. Consumers dedupe on the outbox `event_uid`.
import { listUnprocessed, claim, release } from "../../db/events.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { publishDomainEvent } from "../../messaging/publisher.js";
import * as catalogRepository from "../catalog/repository.js";
import * as providersRepository from "../providers/repository.js";

const RELAY = Symbol.for("edemand.relay.interval");

async function dispatch(event) {
  const payload = JSON.parse(event.payload_json);

  // Eventual consistency: recompute the service AND provider aggregates from the reviews table.
  // This is local Catalog/Provider work, so it stays in the monolith; the event is then published
  // so Notifications can tell the provider about the review.
  if (event.type === "review.created") {
    catalogRepository.recomputeRatingAggregate(payload.service_id);
    providersRepository.recomputeRatingAggregate(payload.provider_id);
  }

  await publishDomainEvent(event);
}

// Drain up to 100 unprocessed events. Each is claimed (processed_at) before dispatch; a concurrent
// or repeated pass that loses the claim skips the event. If publishing fails we release the claim so
// the next pass retries — at-least-once, with consumers deduping the effect.
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
      logger.error({ err: err.message, eventId: event.id }, "relay: publish failed; released for retry");
    }
  }
  return processed;
}

export function startRelay() {
  if (globalThis[RELAY]) return;
  if (!config.rabbitmq.enabled) {
    logger.warn("outbox relay not started: RABBITMQ_URL is not configured");
    return;
  }
  const handle = setInterval(() => {
    runRelayOnce().catch((err) => {
      logger.error({ err: err.message }, "relay: pass failed");
    });
  }, 1000);
  // Don't keep the process alive solely for the relay.
  if (typeof handle.unref === "function") handle.unref();
  globalThis[RELAY] = handle;
  logger.info({ exchange: config.rabbitmq.exchange }, "outbox relay started");
}

export function stopRelay() {
  if (globalThis[RELAY]) {
    clearInterval(globalThis[RELAY]);
    globalThis[RELAY] = undefined;
  }
}
