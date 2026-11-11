// Token verification for the extracted Payments & Wallet service (Area B).
//
// Every public call carries a Keycloak-issued RS256 access token. This file verifies it locally
// against the realm JWKS, then maps Keycloak's claims onto the `{ sub, role }` shape the money
// tables use. `local_id` is the monolith's numeric user id, which is the business key stored in
// transactions.customer_id / transactions.provider_id and provider_wallets.provider_id.
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

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: `this route requires role: ${role}` });
    }
    return next();
  };
}

module.exports = { requireUser, requireRole, tokenFrom };
