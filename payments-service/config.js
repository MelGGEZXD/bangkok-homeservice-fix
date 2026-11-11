// Environment configuration for the extracted Payments & Wallet service. Everything is injected;
// nothing is hard-coded into a committed file.
function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const keycloakUrl = (process.env.KEYCLOAK_URL || "").replace(/\/+$/, "");
const keycloakRealm = process.env.KEYCLOAK_REALM || "edemand";

module.exports = {
  port: int(process.env.PORT, 3002),
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://user:password@localhost:5432/payments_db",
  internalApiKey: process.env.INTERNAL_API_KEY || "dev-internal-key-change-me",
  webhookSecret: process.env.WEBHOOK_SECRET || "edemand-webhook-secret",
  logLevel: process.env.LOG_LEVEL || "info",
  // Area A: after the money rows commit, the service tells the monolith (which still owns orders)
  // that the order was paid. That call is idempotent, so a webhook replay is harmless.
  bookingServiceUrl: (process.env.BOOKING_SERVICE_URL || "http://localhost:3000").replace(/\/+$/, ""),
  bookingTimeoutMs: int(process.env.BOOKING_TIMEOUT_MS, 3000),
  // Area B: this service is a resource server. It verifies Keycloak-issued RS256 tokens itself
  // against the realm JWKS; it never trusts a token forwarded without proof.
  keycloak: {
    enabled: Boolean(keycloakUrl),
    url: keycloakUrl,
    realm: keycloakRealm,
    issuer: process.env.KEYCLOAK_ISSUER || `${keycloakUrl}/realms/${keycloakRealm}`,
    audience: process.env.KEYCLOAK_AUDIENCE || "edemand-api",
  },
};
