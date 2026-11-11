// Outbox -> broker publisher.
//
// The relay used to POST a pre-formatted notification command to the service over HTTP. Area C
// changes the contract: it publishes the raw domain event to RabbitMQ, and the notifications
// service owns the projection (event -> notification). That keeps the monolith from knowing how a
// notification is worded and makes a second consumer possible without touching the publisher.
//
// `setPublisher` is the unit-test seam. It replaces both RabbitMQ and the network, so node:test can
// drive the relay in-process; the production path never installs an override.
import { config } from "../config.js";
import { logger } from "../logger.js";
import { publishEnvelope } from "./rabbit.js";
import { getTracer, extractTraceparent, traceparentOf, context, trace, SpanKind } from "../telemetry.js";

let override = null;

// The wire format. Everything a consumer needs is inside the message; it never reads the monolith DB.
export function toEnvelope(event) {
  return {
    event_uid: event.event_uid,
    type: event.type,
    aggregate_type: event.aggregate_type,
    aggregate_id: Number(event.aggregate_id),
    payload: JSON.parse(event.payload_json),
    occurred_at: event.created_at,
    // Area E: the trace the relay's publish span will continue.
    trace_parent: event.trace_parent || null,
  };
}

export function setPublisher(fn) {
  override = fn;
}

export function resetPublisher() {
  override = null;
}

export async function publishDomainEvent(event) {
  const envelope = toEnvelope(event);
  if (override) return override(envelope);
  if (!config.rabbitmq.enabled) {
    // Fail closed rather than silently dropping an event. Tests always install a publisher; the
    // compose stack sets RABBITMQ_URL. A bare `npm run dev` needs `docker compose up rabbitmq` too.
    throw new Error("RabbitMQ is not configured (set RABBITMQ_URL)");
  }

  // Area E: the publish is its own PRODUCER span, parented to the request that wrote the outbox row.
  // The message carries this span's traceparent, so the consumer's span joins the same trace even
  // though the relay runs on a timer seconds later.
  const parent = event.trace_parent ? extractTraceparent({ traceparent: event.trace_parent }) : context.active();
  const span = getTracer("edemand").startSpan(
    `publish ${envelope.type}`,
    { kind: SpanKind.PRODUCER, attributes: { "messaging.system": "rabbitmq", "messaging.destination": config.rabbitmq.exchange } },
    parent
  );
  try {
    envelope.trace_parent = traceparentOf(span);
    await context.with(trace.setSpan(context.active(), span), () => publishEnvelope(envelope));
    logger.debug({ type: envelope.type, eventUid: envelope.event_uid }, "relay: event published");
  } finally {
    span.end();
  }
}
