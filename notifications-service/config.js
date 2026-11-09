// Environment configuration for the extracted Notifications service. Everything is injected;
// nothing is hard-coded into a committed file.
function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const keycloakUrl = (process.env.KEYCLOAK_URL || "").replace(/\/+$/, "");
const keycloakRealm = process.env.KEYCLOAK_REALM || "edemand";

module.exports = {
  port: int(process.env.PORT, 3001),
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://user:password@localhost:5432/notifications_db",
  internalApiKey: process.env.INTERNAL_API_KEY || "dev-internal-key-change-me",
  logLevel: process.env.LOG_LEVEL || "info",
  // Area B: the service verifies Keycloak-issued RS256 tokens itself. `issuer` is the public
  // frontend URL Keycloak stamps into every token; `url` is the internal address used to fetch the
  // JWKS, so both the host and the compose network resolve the same realm keys.
  keycloak: {
    enabled: Boolean(keycloakUrl),
    url: keycloakUrl,
    realm: keycloakRealm,
    issuer: process.env.KEYCLOAK_ISSUER || `${keycloakUrl}/realms/${keycloakRealm}`,
    audience: process.env.KEYCLOAK_AUDIENCE || "edemand-api",
  },
};
