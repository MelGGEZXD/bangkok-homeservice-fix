// Identity context owns customers, providers, admins. SQL only.
import { getDb } from "../../db/index.js";

// ---- customers ----
export function findCustomerByEmail(email) {
  return getDb().prepare("SELECT * FROM customers WHERE email = ?").get(email);
}
export function findCustomerById(id) {
  return getDb().prepare("SELECT * FROM customers WHERE id = ?").get(id);
}
export function insertCustomer({ email, passwordHash, name, phone }) {
  return getDb()
    .prepare("INSERT INTO customers (email, password_hash, name, phone) VALUES (?, ?, ?, ?)")
    .run(email, passwordHash, name, phone ?? null).lastInsertRowid;
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
export function insertProvider({ email, passwordHash, name, phone }) {
  return getDb()
    .prepare("INSERT INTO providers (email, password_hash, name, phone) VALUES (?, ?, ?, ?)")
    .run(email, passwordHash, name, phone ?? null).lastInsertRowid;
}
export function insertProviderProfile(providerId, companyName) {
  getDb()
    .prepare("INSERT INTO provider_profiles (provider_id, company_name) VALUES (?, ?)")
    .run(providerId, companyName ?? null);
}
export function insertProviderWallet(providerId) {
  getDb()
    .prepare("INSERT INTO provider_wallets (provider_id, balance_cents, commission_owed_cents) VALUES (?, 0, 0)")
    .run(providerId);
}
// Compensating delete when Keycloak provisioning fails after the local transaction commits.
export function deleteProvider(id) {
  const remove = getDb().transaction(() => {
    getDb().prepare("DELETE FROM provider_wallets WHERE provider_id = ?").run(id);
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
