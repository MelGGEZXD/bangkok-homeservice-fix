// Client for the extracted Payments & Wallet service.
//
// Area A (second extraction): the monolith no longer owns payment_intents, transactions,
// provider_wallets or webhook_events. Every read and write of those tables now crosses this seam.
// The public calls forward the caller's Keycloak token, so the service verifies it itself (Area B);
// the internal calls carry the shared internal key and are idempotent by contract, so a retry can
// never double-credit.
//
// `setPaymentsTransport` is the unit-test seam. node:test has no payments service, so
// test-helpers/payments.js installs an in-memory implementation with the same contract.
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { AppError, BadGatewayError } from "../../errors.js";

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

async function httpTransport({ method, path, body, token, internal, secret, requestId }) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (internal) headers["x-internal-key"] = config.internalApiKey;
  if (secret) headers["x-webhook-secret"] = secret;
  if (requestId) headers["x-request-id"] = requestId;

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
    logger.warn({ err: err.message, path }, "payments-service call failed");
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

async function request(options) {
  const { status, body } = await transport(options);
  if (status >= 200 && status < 300) return body;
  const message = (body && body.error) || `payments service returned ${status}`;
  if (status >= 500) throw new BadGatewayError(message);
  throw new AppError(status, message);
}

// ---- internal commands (idempotent) --------------------------------------------------------
export async function ensureIntent({ orderId, amountCents, gatewayRef, requestId }) {
  const body = await request({
    method: "POST",
    path: "/internal/payment-intents",
    internal: true,
    requestId,
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
    body: { provider_id: providerId },
  });
}

export async function deleteWallet(providerId, requestId) {
  return request({
    method: "DELETE",
    path: `/internal/wallets/${encodeURIComponent(providerId)}`,
    internal: true,
    requestId,
  });
}

export async function applyBookingCompleted(input, requestId) {
  return request({
    method: "POST",
    path: "/internal/ledger/booking-completed",
    internal: true,
    requestId,
    body: input,
  });
}

export async function applyBookingCancelled(input, requestId) {
  return request({
    method: "POST",
    path: "/internal/ledger/booking-cancelled",
    internal: true,
    requestId,
    body: input,
  });
}

export async function simulate(orderId, requestId) {
  return request({
    method: "POST",
    path: "/internal/simulate",
    internal: true,
    requestId,
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
    body: payload,
  });
}
