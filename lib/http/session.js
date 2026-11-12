// Server-Component session helper. Reads+verifies the httpOnly edemand_token cookie so layouts and
// pages can identify the browser user without going through a route handler. Returns the normalised
// payload { sub, role, email } or null. Uses the same verifier as the API (Keycloak in production,
// HS256 in the test suite). Used only by the UI, so its dependence on next/headers cookies() is safe.
import { cookies } from "next/headers";
import { verifyToken } from "./auth.js";

export function getSessionToken() {
  return cookies().get("edemand_token")?.value;
}

export function getSession() {
  const token = getSessionToken();
  if (!token) return null;
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
}
