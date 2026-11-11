// Client for the extracted Notifications service.
//
// The monolith no longer imports a notifications repository or writes the `notifications` table.
// It has exactly two jobs at this boundary:
//   1. the outbox relay DELIVERS a notification command over HTTP (internal endpoint, shared key)
//   2. the API/UI PROXY the caller's JWT to the service, which owns the read side + ownership check
//
// `setNotificationTransport` exists so the node:test suite can capture deliveries without standing
// up Postgres. Production always uses the HTTP transport below.
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { AppError, BadGatewayError } from "../../errors.js";
import { publishNotification } from "./publisher.js";

function baseUrl() {
  return config.notificationsServiceUrl.replace(/\/+$/, "");
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function httpTransport(notification) {
  let res;
  try {
    res = await fetch(`${baseUrl()}/internal/notifications`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-key": config.internalApiKey,
        "x-request-id": notification.source_event_id,
      },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(config.notificationsTimeoutMs),
    });
  } catch (err) {
    logger.warn({ err: err.message }, "notifications-service delivery failed");
    throw new BadGatewayError("notifications service unavailable", { cause: err.message });
  }

  if (!res.ok) {
    const body = await readBody(res);
    const message = (body && body.error) || `notifications service returned ${res.status}`;
    logger.warn({ status: res.status, message }, "notifications-service rejected delivery");
    throw new BadGatewayError(message);
  }
  return readBody(res);
}

const rabbitEventTypes = new Map([
  ["provider_approved", "provider.approved"],
  ["booking_status", "booking.status_changed"],
]);

async function defaultTransport(notification) {
  const url = process.env.RABBITMQ_URL;
  const eventType = rabbitEventTypes.get(notification.type);

  if (url && eventType) {
    return publishNotification(url, eventType, notification);
  }

  return httpTransport(notification);
}

let transport = defaultTransport;

export function setNotificationTransport(fn) {
  transport = fn;
}

export function resetNotificationTransport() {
  transport = defaultTransport;
}

// Deliver one notification command. The service dedupes on
// (source_event_id, recipient_role, recipient_id, type), so at-least-once relay retries are safe.
export async function deliver(notification) {
  return transport(notification);
}

async function proxyRequest(path, { token, requestId, method = "GET" } = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      cache: "no-store",
      headers: {
        authorization: `Bearer ${token}`,
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
      signal: AbortSignal.timeout(config.notificationsTimeoutMs),
    });
  } catch (err) {
    logger.warn({ err: err.message, path }, "notifications-service proxy failed");
    throw new BadGatewayError("notifications service unavailable", { cause: err.message });
  }

  const body = await readBody(res);
  if (!res.ok) {
    // Preserve the service's 401/403/404 semantics; a service-side 5xx becomes a 502 at this edge.
    const status = res.status >= 500 ? 502 : res.status;
    const message = (body && body.error) || `notifications service returned ${res.status}`;
    if (status >= 500) throw new BadGatewayError(message);
    throw new AppError(status, message);
  }
  return body;
}

export function listForUser(token, requestId) {
  return proxyRequest("/api/notifications", { token, requestId });
}

export function markRead(notificationId, token, requestId) {
  return proxyRequest(`/api/notifications/${encodeURIComponent(notificationId)}/read`, {
    token,
    requestId,
    method: "POST",
  });
}
