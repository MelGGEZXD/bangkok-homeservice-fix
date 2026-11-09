// Test double for the notifications boundary. The relay's HTTP transport is replaced with an
// in-memory sink, so tests can prove exactly-once delivery semantics without standing up Postgres.
import {
  setNotificationTransport,
  resetNotificationTransport,
} from "../lib/modules/notifications/client.js";

const delivered = [];

export function captureNotifications() {
  delivered.length = 0;
  setNotificationTransport(async (notification) => {
    delivered.push(notification);
    return { id: delivered.length, duplicate: false };
  });
  return delivered;
}

export function deliveredNotifications() {
  return delivered;
}

export function stopCapture() {
  resetNotificationTransport();
  delivered.length = 0;
}
