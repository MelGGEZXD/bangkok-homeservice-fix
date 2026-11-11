// Identity context owns customers, providers, admins. SQL only.
//
// Area D race fix: the service-level "is this email taken?" check is advisory. Two concurrent
// registrations can both pass it, so the UNIQUE(email) constraint is the real arbiter. These
// inserts translate that constraint into the same 409 the sequential path returns, instead of
// leaking a raw SQLITE_CONSTRAINT (which the HTTP layer would turn into a 500).
import { getDb } from "../../db/index.js";
import { ConflictError } from "../../errors.js";

function insertIdentity(table, label, { email, passwordHash, name, phone }) {
  try {
    return getDb()
      .prepare(`INSERT INTO ${table} (email, password_hash, name, phone) VALUES (?, ?, ?, ?)`)
      .run(email, passwordHash, name, phone ?? null).lastInsertRowid;
  } catch (err) {
    if (err && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new ConflictError(`${label} email ${email} is already registered`);
    }
    throw err;
  }
}

// ---- customers ----
export function findCustomerByEmail(email) {
  return getDb().prepare("SELECT * FROM customers WHERE email = ?").get(email);
}
export function findCustomerById(id) {
  return getDb().prepare("SELECT * FROM customers WHERE id = ?").get(id);
}
export function insertCustomer(input) {
  return insertIdentity("customers", "customer", input);
}
// Compensating delete when Keycloak provisioning fails after the local insert.
export function deleteCustomer(id) {
  getDb().prepare("DELETE FROM customers WHERE id = ?").run(id);
}

// ---- providers ----
export function findProviderByEmail(email) {
  return getDb().prepare("SELECT * FROM providers WHERE email = ?").get(email);
}
export function findProviderById(id) {
  return getDb().prepare("SELECT * FROM providers WHERE id = ?").get(id);
}
export function insertProvider(input) {
  return insertIdentity("providers", "provider", input);
}
export function insertProviderProfile(providerId, companyName) {
  getDb()
    .prepare("INSERT INTO provider_profiles (provider_id, company_name) VALUES (?, ?)")
    .run(providerId, companyName ?? null);
}
// Area A: provider_wallets is owned by the payments service. This context only knows the provider
// and its profile; the wallet is created and removed through the payments client.
// Compensating delete when Keycloak provisioning fails after the local transaction commits.
export function deleteProvider(id) {
  const remove = getDb().transaction(() => {
    getDb().prepare("DELETE FROM provider_profiles WHERE provider_id = ?").run(id);
    getDb().prepare("DELETE FROM providers WHERE id = ?").run(id);
  });
  remove();
}

// ---- admins ----
export function findAdminByEmail(email) {
  return getDb().prepare("SELECT * FROM admins WHERE email = ?").get(email);
}
export function findAdminById(id) {
  return getDb().prepare("SELECT * FROM admins WHERE id = ?").get(id);
}
