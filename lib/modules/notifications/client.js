// Client for the extracted Notifications service.
//
// Area C: the outbox relay no longer calls `deliver()` — it publishes the raw domain event to
// RabbitMQ, and the notifications service owns the projection. The production use of this module
// is now the read-side proxy below: `GET /api/notifications` and mark-read, forwarding the caller's
// JWT to the service that owns the rows and the ownership check.
//
// The HTTP command transport (`deliver`) and its injectable override are retained because the
// service still exposes the idempotent `POST /internal/notifications` endpoint (Area A tooling,
// `verify-area-a.ps1`). They are not on the Area C event path.
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { AppError, BadGatewayError } from "../../errors.js";

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

let transport = httpTransport;

export function setNotificationTransport(fn) {
  transport = fn;
}

export function resetNotificationTransport() {
  transport = httpTransport;
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
