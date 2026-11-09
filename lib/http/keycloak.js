// Keycloak integration for the monolith (Area B).
//
// Two responsibilities, both kept at the boundary:
//   1. VERIFY the access token locally. The monolith fetches the realm's JWKS once at boot (with
//      retries), caches the RSA public keys by `kid`, and verifies RS256/iss/aud/exp synchronously
//      with jsonwebtoken. That keeps every existing route handler synchronous.
//   2. ISSUE tokens by asking Keycloak. The login routes still accept an email + password, but the
//      monolith forwards them to Keycloak's token endpoint (Resource Owner Password grant on the
//      public `edemand-web` client) and returns the Keycloak access token. The monolith never signs
//      a production token itself.
//
// Registration creates the matching Keycloak user through the Admin REST API so a freshly
// registered account can log in immediately. The realm import already contains every seeded demo
// user, with a `local_id` attribute equal to the monolith's numeric id.
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { UnauthorizedError, BadGatewayError } from "../errors.js";

const REFRESH_MS = 5 * 60 * 1000;
const BOOT_ATTEMPTS = 120;

let keys = new Map();
let refreshTimer = null;
let adminToken = null;
let adminTokenExpiresAt = 0;

// Next bundles `lib/http/keycloak.js` into more than one server chunk (instrumentation and each
// route group). Module-level state is therefore NOT shared between the boot hook and a route
// handler, even in the same process. The verified key set lives on globalThis so every copy sees
// the same cache; the local variable is only a fallback while the boot hook is still fetching.
const KEY_CACHE = Symbol.for("edemand.keycloak.keys");
function currentKeys() {
  return globalThis[KEY_CACHE] || keys;
}

function realmUrl() {
  return `${config.keycloak.url}/realms/${config.keycloak.realm}`;
}

function jwksUrl() {
  return `${realmUrl()}/protocol/openid-connect/certs`;
}

function tokenUrl() {
  return `${realmUrl()}/protocol/openid-connect/token`;
}

function adminUrl() {
  return `${config.keycloak.url}/admin/realms/${config.keycloak.realm}`;
}

// Convert a JWK to a PEM public key once; jsonwebtoken accepts PEM everywhere.
function toPem(jwk) {
  return crypto
    .createPublicKey({ key: jwk, format: "jwk" })
    .export({ type: "spki", format: "pem" });
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
  globalThis[KEY_CACHE] = next;
}

// Called from instrumentation.js before the outbox relay starts. Keycloak may still be importing
// the realm when the monolith container boots, so retry instead of crash-looping the stack.
export async function initKeycloak() {
  if (!config.keycloak.enabled) return;
  let lastError;
  for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt++) {
    try {
      await fetchKeys();
      logger.info({ issuer: config.keycloak.issuer, keys: keys.size }, "keycloak: signing keys loaded");
      break;
    } catch (err) {
      lastError = err;
      if (attempt === BOOT_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      fetchKeys().catch((err) => logger.warn({ err: err.message }, "keycloak: JWKS refresh failed"));
    }, REFRESH_MS);
    refreshTimer.unref?.();
  }
  return lastError;
}

export function stopKeycloakRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// Synchronous verification so getAuth() stays a plain function for all 35 route handlers.
export function verifyKeycloakToken(token) {
  const cache = currentKeys();
  if (cache.size === 0) throw new Error("Keycloak signing keys are not loaded yet");
  const decoded = jwt.decode(token, { complete: true });
  const kid = decoded?.header?.kid;
  const pem = (kid && cache.get(kid)) || (cache.size === 1 ? [...cache.values()][0] : null);
  if (!pem) throw new Error(`no Keycloak signing key for kid ${kid || "(none)"}`);

  return jwt.verify(token, pem, {
    algorithms: ["RS256"],
    issuer: config.keycloak.issuer,
    audience: config.keycloak.audience,
    clockTolerance: 0,
  });
}

// ---- issuing tokens -------------------------------------------------------------------------

export async function loginWithPassword(email, password) {
  let res;
  try {
    res = await fetch(tokenUrl(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: config.keycloak.clientId,
        username: email,
        password,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    throw new BadGatewayError("identity provider unavailable", { cause: err.message });
  }

  if (res.status === 400 || res.status === 401) {
    // Keycloak deliberately does not distinguish unknown user from wrong password.
    throw new UnauthorizedError("invalid email or password");
  }
  if (!res.ok) {
    throw new BadGatewayError(`identity provider returned ${res.status}`);
  }

  const body = await res.json();
  if (!body.access_token) throw new BadGatewayError("identity provider returned no access token");
  return body.access_token;
}

// ---- provisioning local registrations -------------------------------------------------------

async function getAdminToken() {
  if (adminToken && Date.now() < adminTokenExpiresAt - 10_000) return adminToken;

  let res;
  try {
    res = await fetch(`${config.keycloak.url}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: config.keycloak.adminUser,
        password: config.keycloak.adminPassword,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    throw new BadGatewayError("identity provider admin API unavailable", { cause: err.message });
  }
  if (!res.ok) throw new BadGatewayError(`identity provider admin login returned ${res.status}`);

  const body = await res.json();
  adminToken = body.access_token;
  adminTokenExpiresAt = Date.now() + (body.expires_in || 60) * 1000;
  return adminToken;
}

async function findUserIdByEmail(token, email) {
  const res = await fetch(
    `${adminUrl()}/users?email=${encodeURIComponent(email)}&exact=true`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new BadGatewayError(`identity provider lookup returned ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0].id : null;
}

async function assignRealmRole(token, userId, role) {
  const roleRes = await fetch(`${adminUrl()}/roles/${encodeURIComponent(role)}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!roleRes.ok) throw new BadGatewayError(`identity provider role lookup returned ${roleRes.status}`);
  const roleRep = await roleRes.json();

  const res = await fetch(`${adminUrl()}/users/${encodeURIComponent(userId)}/role-mappings/realm`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify([{ id: roleRep.id, name: roleRep.name }]),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok && res.status !== 204) {
    throw new BadGatewayError(`identity provider role assignment returned ${res.status}`);
  }
}

// Create (or reuse) the Keycloak user for a local registration. The realm's protocol mappers turn
// `local_id` and `role` into token claims, which is what lets the extracted service authorise the
// caller without ever reading the monolith's SQLite file.
export async function provisionUser({ email, password, name, role, localId }) {
  const token = await getAdminToken();
  // Keycloak's declarative user profile requires a last name for a fully set-up account. Split the
  // single display name the marketplace collects; fall back to "-" when it is one word.
  const parts = String(name).trim().split(/\s+/);
  const firstName = parts[0] || email;
  const lastName = parts.slice(1).join(" ") || "-";

  let userId = await findUserIdByEmail(token, email);
  if (!userId) {
    const res = await fetch(`${adminUrl()}/users`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        username: email,
        email,
        emailVerified: true,
        enabled: true,
        firstName,
        lastName,
        attributes: { local_id: [String(localId)], role: [role] },
        credentials: [{ type: "password", value: password, temporary: false }],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 409) {
      userId = await findUserIdByEmail(token, email);
    } else if (res.status !== 201) {
      throw new BadGatewayError(`identity provider user creation returned ${res.status}`);
    } else {
      userId = (res.headers.get("location") || "").split("/").pop();
    }
  }
  if (!userId) throw new BadGatewayError("identity provider did not return a user id");

  await assignRealmRole(token, userId, role);
  return userId;
}

// Compensating action if the local insert has to be rolled back after a provisioning failure.
export async function deleteProvisionedUser(email) {
  try {
    const token = await getAdminToken();
    const userId = await findUserIdByEmail(token, email);
    if (!userId) return;
    await fetch(`${adminUrl()}/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    logger.warn({ err: err.message, email }, "keycloak: could not remove orphaned user");
  }
}
