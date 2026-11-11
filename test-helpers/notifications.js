// Test double for the Area C event boundary.
//
// Production publishes the raw domain event to RabbitMQ, and the notifications service projects it.
// node:test has no broker, so this installs an in-process publisher and runs the SAME projection
// rules (notifications-service/notification-rules.cjs) that production runs. That keeps the tests
// honest about the contract while still proving dedupe: the same rule file and the same
// (source_event_id, recipient_role, recipient_id, type) key.
import rules from "../notifications-service/notification-rules.cjs";
import { setPublisher, resetPublisher } from "../lib/messaging/publisher.js";

const published = [];
const delivered = [];
const seen = new Set();

function keyOf(n) {
  return [n.source_event_id, n.recipient_role, n.recipient_id, n.type].join("|");
}

export function captureNotifications() {
  published.length = 0;
  delivered.length = 0;
  seen.clear();

  setPublisher(async (envelope) => {
    published.push(envelope);
    for (const notification of rules.project(envelope)) {
      const key = keyOf(notification);
      if (seen.has(key)) continue; // duplicate delivery: exactly one effect
      seen.add(key);
      delivered.push(notification);
    }
  });

  return delivered;
}

// Raw envelopes the relay would have published to RabbitMQ.
export function publishedEvents() {
  return published;
}

// Projected notifications (what the service would have stored).
export function deliveredNotifications() {
  return delivered;
}

export function stopCapture() {
  resetPublisher();
  published.length = 0;
  delivered.length = 0;
  seen.clear();
}
