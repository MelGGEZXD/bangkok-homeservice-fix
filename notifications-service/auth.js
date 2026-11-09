// Token verification for the extracted Notifications service.
//
// Area B: every call carries a Keycloak-issued RS256 access token. This file verifies it locally
// against the realm JWKS (see keycloak.js), then maps Keycloak's claims onto the recipient model
// this context owns:
//   - `local_id` -> the monolith's numeric user id (the same id stored in recipient_id)
//   - `role`     -> customer / provider / admin (the same value stored in recipient_role)
// The Keycloak subject (`sub`) is kept separately for audit, but it is not the business key.
const { verifyToken } = require("./keycloak");

const APP_ROLES = ["customer", "provider", "admin"];

function tokenFrom(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token) return token;
  }
  const cookie = req.headers.cookie;
  if (cookie) {
    const m = cookie.match(/(?:^|;\s*)edemand_token=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

function requireUser(req, res, next) {
  const token = tokenFrom(req);
  if (!token) return res.status(401).json({ error: "missing bearer token" });

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    // forged signature / expired / wrong audience / wrong issuer all land here.
    return res.status(401).json({ error: `invalid token: ${err.message}` });
  }

  if (!APP_ROLES.includes(payload.role)) {
    return res.status(401).json({ error: "token role is not recognised" });
  }
  const sub = Number(payload.local_id);
  if (!Number.isInteger(sub) || sub <= 0) {
    return res.status(401).json({ error: "token is missing a valid local_id" });
  }

  req.user = { sub, role: payload.role, email: payload.email, subject: payload.sub };
  return next();
}

module.exports = { requireUser, tokenFrom };
