// Shared helpers for spinning up throwaway customers/providers and logging in as seeded accounts,
// so lifecycle tests aren't full of register/login boilerplate. Route handlers are imported here
// (after boot.js in the test file) and driven through call().
import { randomUUID } from "node:crypto";
import { call } from "./call.js";
import { getDb } from "./boot.js";
import { SEED_PASSWORD } from "../lib/db/seed.js";

import * as customerRegister from "../app/api/auth/customer/register/route.js";
import * as customerLogin from "../app/api/auth/customer/login/route.js";
import * as providerRegister from "../app/api/auth/provider/register/route.js";
import * as providerLogin from "../app/api/auth/provider/login/route.js";
import * as adminLogin from "../app/api/auth/admin/login/route.js";

export async function registerCustomer(overrides = {}) {
  const email = overrides.email || `cust-${randomUUID()}@example.com`;
  const password = overrides.password || "TestPass123!";
  const reg = await call(customerRegister.POST, {
    body: { email, password, name: overrides.name || "Test Customer", phone: overrides.phone },
  });
  const login = await call(customerLogin.POST, { body: { email, password } });
  return { id: reg.body.id, email, password, token: login.body.token, reg, login };
}

export async function registerProvider(overrides = {}) {
  const email = overrides.email || `prov-${randomUUID()}@example.com`;
  const password = overrides.password || "TestPass123!";
  const reg = await call(providerRegister.POST, {
    body: { email, password, name: overrides.name || "Test Provider", company_name: overrides.company_name },
  });
  const login = await call(providerLogin.POST, { body: { email, password } });
  return { id: reg.body.id, email, password, token: login.body.token, is_approved: login.body.is_approved, reg, login };
}

// Seeded accounts share SEED_PASSWORD. Their ids come from the DB so tests can reference them.
export async function loginSeededCustomer(email) {
  const row = getDb().prepare("SELECT id FROM customers WHERE email = ?").get(email);
  const login = await call(customerLogin.POST, { body: { email, password: SEED_PASSWORD } });
  return { id: row.id, email, token: login.body.token };
}
export async function loginSeededProvider(email) {
  const row = getDb().prepare("SELECT id FROM providers WHERE email = ?").get(email);
  const login = await call(providerLogin.POST, { body: { email, password: SEED_PASSWORD } });
  return { id: row.id, email, token: login.body.token, is_approved: login.body.is_approved };
}
export async function loginAdmin() {
  const login = await call(adminLogin.POST, { body: { email: "admin@edemand.test", password: SEED_PASSWORD } });
  return { token: login.body.token };
}

// A future weekday date (Mon–Sat) so bookings land inside the seeded 09:00–18:00 open hours.
export function futureWeekday(offsetDays = 3) {
  let d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  while (d.getUTCDay() === 0) d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
