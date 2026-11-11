// Keycloak token verification for the extracted Payments & Wallet service (Area B).
//
// The service is a resource server: it does not trust the monolith, it does not share a signing
// secret, and it never reads the monolith's database. It fetches the realm's public keys once at
// boot, caches them by `kid`, and verifies every bearer token itself (RS256 + iss + aud + exp).
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const config = require("./config");

const REFRESH_MS = 5 * 60 * 1000;
const BOOT_ATTEMPTS = 120;

let keys = new Map();
let loaded = false;
let refreshTimer = null;

function jwksUrl() {
  return `${config.keycloak.url}/realms/${config.keycloak.realm}/protocol/openid-connect/certs`;
}

function toPem(jwk) {
  return crypto.createPublicKey({ key: jwk, format: "jwk" }).export({ type: "spki", format: "pem" });
}

async function fetchKeys() {
  const res = await fetch(jwksUrl(), { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`JWKS request failed with ${res.status}`);
  const body = await res.json();
  const next = new Map();
  for (const jwk of body.keys || []) {
    if (jwk.kid && jwk.kty === "RSA") next.set(jwk.kid, toPem(jwk));
  }
  if (next.size === 0) throw new Error("JWKS contained no RSA signing keys");
  keys = next;
  loaded = true;
}

// Called before app.listen(). Keycloak may still be importing the realm when this container boots,
// so retry rather than crash-loop.
async function initKeycloak() {
  if (!config.keycloak.enabled) {
    throw new Error("KEYCLOAK_URL is required: the payments service verifies tokens with JWKS");
  }
  for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt++) {
    try {
      await fetchKeys();
      console.log(JSON.stringify({
        level: "info",
        service: "payments",
        msg: `loaded ${keys.size} Keycloak signing key(s)`,
        issuer: config.keycloak.issuer,
      }));
      break;
    } catch (err) {
      if (attempt === BOOT_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      fetchKeys().catch((err) => {
        console.error(JSON.stringify({
          level: "warn",
          service: "payments",
          msg: "JWKS refresh failed",
          err: err.message,
        }));
      });
    }, REFRESH_MS);
    refreshTimer.unref?.();
  }
}

// Throws on forged signature, expiry, wrong issuer, or wrong audience. Callers map the error to 401.
function verifyToken(token) {
  if (!loaded) throw new Error("Keycloak signing keys are not loaded yet");
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded && decoded.header ? decoded.header.kid : null;
  const pem = (kid && keys.get(kid)) || (keys.size === 1 ? [...keys.values()][0] : null);
  if (!pem) throw new Error(`no Keycloak signing key for kid ${kid || "(none)"}`);

  return jwt.verify(token, pem, {
    algorithms: ["RS256"],
    issuer: config.keycloak.issuer,
    audience: config.keycloak.audience,
    clockTolerance: 0,
  });
}

module.exports = { initKeycloak, verifyToken };
