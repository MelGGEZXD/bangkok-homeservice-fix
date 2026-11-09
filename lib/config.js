// Central environment configuration. Every module reads settings from here — nothing else in the
// codebase touches process.env directly (except db/index.js resolving the db path at open time),
// so the whole config surface is grep-able in one file.
const NODE_ENV = process.env.NODE_ENV || "development";

export const config = Object.freeze({
  nodeEnv: NODE_ENV,
  isTest: NODE_ENV === "test",
  port: parseInt(process.env.PORT, 10) || 3000,
  jwtSecret: process.env.JWT_SECRET || "dev secret - do not use in production",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "12h",
  logLevel: process.env.LOG_LEVEL || (NODE_ENV === "test" ? "silent" : "info"),
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 10,
  // First order id after a fresh seed. sqlite_sequence is primed to (firstOrderId - 1) so the next
  // AUTOINCREMENT insert lands here, deterministically, on every boot.
  firstOrderId: 8001,
  // One flat tax rate, snapshotted onto each order_item at booking time (tax-excluded).
  taxPercent: 7.0,
  // Shared secret the mock payment gateway signs its webhook callbacks with.
  webhookSecret: process.env.WEBHOOK_SECRET || "edemand-webhook-secret",
  // ---- Identity provider (Area B) -------------------------------------------------------------
  // Keycloak is the only token issuer whenever KEYCLOAK_URL is present. The node:test suite sets
  // NODE_ENV=test and has no Keycloak, so it stays on the local HS256 path. Keeping the switch in
  // one place means a route can never accidentally pick the weaker verifier in production.
  keycloak: {
    enabled: Boolean(process.env.KEYCLOAK_URL) && NODE_ENV !== "test",
    url: process.env.KEYCLOAK_URL || "http://localhost:8080",
    realm: process.env.KEYCLOAK_REALM || "edemand",
    issuer: process.env.KEYCLOAK_ISSUER || `http://localhost:8080/realms/${process.env.KEYCLOAK_REALM || "edemand"}`,
    audience: process.env.KEYCLOAK_AUDIENCE || "edemand-api",
    clientId: process.env.KEYCLOAK_CLIENT_ID || "edemand-web",
    adminUser: process.env.KEYCLOAK_ADMIN_USER || "admin",
    adminPassword: process.env.KEYCLOAK_ADMIN_PASSWORD || "admin",
  },
  // ---- Extracted services (Area A) ------------------------------------------------------------
  // Internal base URL of the notifications service. Inside docker compose this is the service DNS
  // name; for local `npm run dev` it defaults to localhost:3001.
  notificationsServiceUrl: process.env.NOTIFICATIONS_SERVICE_URL || "http://localhost:3001",
  // Shared secret for monolith -> notifications-service internal calls (never sent to browsers).
  internalApiKey: process.env.INTERNAL_API_KEY || "dev-internal-key-change-me",
  // How long a cross-service notification call may take before the relay gives up and retries.
  notificationsTimeoutMs: parseInt(process.env.NOTIFICATIONS_TIMEOUT_MS, 10) || 3000,
});
