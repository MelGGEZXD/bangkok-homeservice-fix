// Client for the extracted Payments & Wallet service.
//
// Area A (second extraction): the monolith no longer owns payment_intents, transactions,
// provider_wallets or webhook_events. Every read and write of those tables now crosses this seam.
// The public calls forward the caller's Keycloak token, so the service verifies it itself (Area B);
// the internal calls carry the shared internal key and are idempotent by contract, so a retry can
// never double-credit.
//
// Area D: every call has a timeout, and retryable failures (network error, timeout, 5xx) are retried
// with exponential backoff and full jitter. Every write also carries an Idempotency-Key that is
// stable for the logical operation, so all attempts — and a later reconciliation replay — describe
// the same write. The payments service stores that key and replays the stored response.
//
// `setPaymentsTransport` is the unit-test seam. node:test has no payments service, so
// test-helpers/payments.js installs an in-memory implementation with the same contract.
import { randomUUID } from "node:crypto";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { AppError, BadGatewayError } from "../../errors.js";
import { traceparentFromActive } from "../../telemetry.js";

function baseUrl() {
  return config.paymentsServiceUrl.replace(/\/+$/, "");
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

async function httpTransport({ method, path, body, token, internal, secret, requestId, idempotencyKey }) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (internal) headers["x-internal-key"] = config.internalApiKey;
  if (secret) headers["x-webhook-secret"] = secret;
  if (requestId) headers["x-request-id"] = requestId;
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  // Area E: the downstream server span is a child of the current request span.
  const traceparent = traceparentFromActive();
  if (traceparent) headers.traceparent = traceparent;

  let res;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers,
      cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.paymentsTimeoutMs),
    });
  } catch (err) {
    // A connection reset (the injected lost-reply fault), a timeout, or a refused connection all
    // land here. They are transient by definition, so the caller may retry.
    throw new BadGatewayError("payments service unavailable", { cause: err.message });
  }
  return { status: res.status, body: await readBody(res) };
}

let transport = httpTransport;

export function setPaymentsTransport(fn) {
  transport = fn;
}

export function resetPaymentsTransport() {
  transport = httpTransport;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Exponential backoff with FULL jitter: the delay is uniform in [0, cap]. Jitter is what stops a
// fleet of clients from retrying in lockstep after an outage and re-creating the thundering herd.
export function backoffDelayMs(attempt) {
  const cap = Math.min(config.paymentsRetryMaxMs, config.paymentsRetryBaseMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * (cap + 1));
}

async function request(options) {
  const attempts = options.retries ?? config.paymentsMaxAttempts;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { status, body } = await transport(options);
      if (status >= 200 && status < 300) return body;

      const message = (body && body.error) || `payments service returned ${status}`;
      if (status >= 500) {
        lastError = new BadGatewayError(message);
        if (attempt < attempts) {
          const delay = backoffDelayMs(attempt);
          logger.warn(
            { path: options.path, status, attempt, attempts, delayMs: delay },
            "payments-service retryable response"
          );
          await sleep(delay);
          continue;
        }
        throw lastError;
      }
      // 4xx is a decision, not a transient failure. Retrying cannot change it.
      throw new AppError(status, message);
    } catch (err) {
      // Only boundary/transport failures are retryable. A 4xx AppError thrown above must escape.
      if (err instanceof BadGatewayError && attempt < attempts) {
        lastError = err;
        const delay = backoffDelayMs(attempt);
        logger.warn(
          { path: options.path, err: err.message, attempt, attempts, delayMs: delay },
          "payments-service retry"
        );
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new BadGatewayError("payments service call failed");
}

// ---- internal commands (idempotent) --------------------------------------------------------
export async function ensureIntent({ orderId, amountCents, gatewayRef, requestId, idempotencyKey }) {
  const body = await request({
    method: "POST",
    path: "/internal/payment-intents",
    internal: true,
    requestId,
    idempotencyKey: idempotencyKey ?? `payment-intent:${orderId}`,
    body: { order_id: orderId, amount_cents: amountCents, gateway_ref: gatewayRef },
  });
  return body ? body.intent : null;
}

export async function getIntentByOrder(orderId, requestId) {
  const body = await request({
    method: "GET",
    path: `/internal/payment-intents/by-order/${encodeURIComponent(orderId)}`,
    internal: true,
    requestId,
  });
  return body ? body.intent : null;
}

export async function createWallet(providerId, requestId) {
  return request({
    method: "POST",
    path: "/internal/wallets",
    internal: true,
    requestId,
    idempotencyKey: `wallet:${providerId}`,
    body: { provider_id: providerId },
  });
}

export async function deleteWallet(providerId, requestId) {
  return request({
    method: "DELETE",
    path: `/internal/wallets/${encodeURIComponent(providerId)}`,
    internal: true,
    requestId,
    idempotencyKey: `wallet-delete:${providerId}`,
  });
}

export async function applyBookingCompleted(input, requestId, idempotencyKey) {
  return request({
    method: "POST",
    path: "/internal/ledger/booking-completed",
    internal: true,
    requestId,
    idempotencyKey: idempotencyKey ?? `booking-completed:${input.order_id}`,
    body: input,
  });
}

export async function applyBookingCancelled(input, requestId, idempotencyKey) {
  return request({
    method: "POST",
    path: "/internal/ledger/booking-cancelled",
    internal: true,
    requestId,
    idempotencyKey: idempotencyKey ?? `booking-cancelled:${input.order_id}`,
    body: input,
  });
}

export async function simulate(orderId, requestId) {
  return request({
    method: "POST",
    path: "/internal/simulate",
    internal: true,
    requestId,
    // One key per logical click. A retry of that click replays the same settlement; a second click
    // gets a new key, but the intent's succeeded state still makes it a no-op.
    idempotencyKey: `simulate:${orderId}:${randomUUID()}`,
    body: { order_id: orderId },
  });
}

// ---- public calls (the service verifies the forwarded token itself) ------------------------
export async function getWallet(token, requestId) {
  return request({ method: "GET", path: "/api/provider/wallet", token, requestId });
}

export async function listCustomerTransactions(token, requestId) {
  return request({ method: "GET", path: "/api/customer/transactions", token, requestId });
}

export async function sendWebhook(payload, secret, requestId) {
  return request({
    method: "POST",
    path: "/api/payments/webhook",
    secret,
    requestId,
    idempotencyKey: `webhook:${payload.gateway_event_id}`,
    body: payload,
  });
}
