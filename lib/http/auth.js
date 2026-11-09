// JWT verification + role gates for route handlers.
//
// Area B: when Keycloak is configured (`config.keycloak.enabled`), every request token is a
// Keycloak-issued RS256 access token. The service verifies signature, issuer, audience and expiry
// itself against the realm JWKS, then normalises the claims to the `{ sub, role, email }` shape the
// rest of the monolith already uses (`local_id` -> `sub`, `role` -> role).
//
// Without Keycloak (the node:test suite, and local dev that has not booted compose) the original
// HS256 path remains. The two paths are selected in exactly one place so a route cannot choose.
//
// The token can arrive two ways and BOTH verify the same JWT:
//   - Authorization: Bearer <jwt>   (API clients + the test suite)
//   - Cookie: edemand_token=<jwt>    (the browser UI, set httpOnly by the login handlers)
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { verifyKeycloakToken } from "./keycloak.js";
import { UnauthorizedError, ForbiddenError } from "../errors.js";

const APP_ROLES = ["customer", "provider", "admin"];

// Test-only/local-dev issuer. Production tokens are always minted by Keycloak (see keycloak.js).
export function signToken(payload) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

// Exposed so route handlers can forward the caller's token to an extracted service, which must
// verify it itself (Area B). The monolith still verifies it first for a consistent local 401.
export function getToken(req) {
  return readToken(req);
}

function readToken(req) {
  const header = req.headers.get("authorization");
  if (header && header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token) return token;
  }
  // NextRequest exposes parsed cookies; a plain Request (tests) does not, so fall back to the
  // raw Cookie header.
  const cookieVal = req.cookies?.get?.("edemand_token")?.value;
  if (cookieVal) return cookieVal;
  const raw = req.headers.get("cookie");
  if (raw) {
    const m = raw.match(/(?:^|;\s*)edemand_token=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

// Verify any bearer token, whichever issuer is configured. Throws UnauthorizedError on any failure:
// forged signature, expired, wrong audience, wrong issuer, or missing app claims.
export function verifyToken(token) {
  if (config.keycloak.enabled) {
    let payload;
    try {
      payload = verifyKeycloakToken(token);
    } catch (err) {
      throw new UnauthorizedError(`invalid token: ${err.message}`);
    }

    if (!APP_ROLES.includes(payload.role)) {
      throw new UnauthorizedError("token role is not recognised");
    }
    const sub = Number(payload.local_id);
    if (!Number.isInteger(sub) || sub <= 0) {
      throw new UnauthorizedError("token is missing a valid local_id");
    }
    return { ...payload, sub, role: payload.role, email: payload.email };
  }

  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (err) {
    throw new UnauthorizedError(`invalid token: ${err.message}`);
  }
}

// Authenticates AND (optionally) authorizes in one step. `roles` may be a single role string or an
// array; omit it for "any authenticated user". Returns the payload { sub, role, email }.
export function getAuth(req, roles) {
  const token = readToken(req);
  if (!token) throw new UnauthorizedError("missing bearer token");

  const payload = verifyToken(token);

  if (roles) {
    const allowed = Array.isArray(roles) ? roles : [roles];
    if (!allowed.includes(payload.role)) {
      throw new ForbiddenError(`this route requires role: ${allowed.join(" or ")}`);
    }
  }
  return payload;
}

const COOKIE = "edemand_token";
const TWELVE_HOURS = 12 * 60 * 60;

// The httpOnly session cookie the browser UI carries. API clients ignore it and use Bearer; both
// verify the same JWT. Keycloak's realm access-token lifespan matches this window (12 hours).
export function tokenCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TWELVE_HOURS}`;
}
export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
