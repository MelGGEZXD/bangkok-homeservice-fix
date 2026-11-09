// Identity business logic: registration, login, and the /me projection for each role.
//
// Area B: Keycloak is the token issuer. Login still takes an email + password, but when Keycloak is
// configured the monolith forwards the credentials to Keycloak and returns its access token; it
// never signs a production token itself. Registration also creates the Keycloak user (with the
// `local_id` and `role` attributes the realm mappers put into the token), so a new account can log
// in immediately. The local bcrypt hash remains for the test/dev fallback path only.
//
// A provider register is one transaction that also creates the provider_profiles + provider_wallets
// rows, so a provider can never exist without its profile/wallet. If Keycloak provisioning fails,
// the local rows are removed again as a compensating action.
import bcrypt from "bcryptjs";
import { config } from "../../config.js";
import { getDb } from "../../db/index.js";
import { signToken } from "../../http/auth.js";
import * as keycloak from "../../http/keycloak.js";
import * as repository from "./repository.js";
import * as providersRepository from "../providers/repository.js";
import { ConflictError, UnauthorizedError, NotFoundError } from "../../errors.js";

function publicCustomer(row) {
  return { id: row.id, email: row.email, name: row.name, phone: row.phone, created_at: row.created_at };
}
function publicProvider(row) {
  return { id: row.id, email: row.email, name: row.name, phone: row.phone, created_at: row.created_at };
}

// Keycloak verifies the password and minted the token; the local hash is used only when Keycloak is
// not configured (node:test / local dev without compose).
async function issueToken({ email, password, localId, role, passwordHash }) {
  if (config.keycloak.enabled) {
    return keycloak.loginWithPassword(email, password);
  }
  if (!bcrypt.compareSync(password, passwordHash)) {
    throw new UnauthorizedError("invalid email or password");
  }
  return signToken({ sub: localId, role, email });
}

export async function registerCustomer({ email, password, name, phone }) {
  if (repository.findCustomerByEmail(email)) {
    throw new ConflictError(`email ${email} is already registered`);
  }
  const passwordHash = bcrypt.hashSync(password, config.bcryptRounds);
  const id = repository.insertCustomer({ email, passwordHash, name, phone });

  if (config.keycloak.enabled) {
    try {
      await keycloak.provisionUser({ email, password, name, role: "customer", localId: id });
    } catch (err) {
      repository.deleteCustomer(id);
      throw err;
    }
  }
  return publicCustomer(repository.findCustomerById(id));
}

export async function loginCustomer({ email, password }) {
  const customer = repository.findCustomerByEmail(email);
  if (!customer) throw new UnauthorizedError("invalid email or password");

  const token = await issueToken({
    email,
    password,
    localId: customer.id,
    role: "customer",
    passwordHash: customer.password_hash,
  });
  return { token, customer: publicCustomer(customer) };
}

export async function registerProvider({ email, password, name, phone, company_name }) {
  if (repository.findProviderByEmail(email)) {
    throw new ConflictError(`email ${email} is already registered`);
  }
  const passwordHash = bcrypt.hashSync(password, config.bcryptRounds);
  const create = getDb().transaction(() => {
    const id = repository.insertProvider({ email, passwordHash, name, phone });
    repository.insertProviderProfile(id, company_name);
    repository.insertProviderWallet(id);
    return id;
  });
  const id = create();

  if (config.keycloak.enabled) {
    try {
      await keycloak.provisionUser({ email, password, name, role: "provider", localId: id });
    } catch (err) {
      repository.deleteProvider(id);
      throw err;
    }
  }
  return publicProvider(repository.findProviderById(id));
}

export async function loginProvider({ email, password }) {
  const provider = repository.findProviderByEmail(email);
  if (!provider) throw new UnauthorizedError("invalid email or password");

  const token = await issueToken({
    email,
    password,
    localId: provider.id,
    role: "provider",
    passwordHash: provider.password_hash,
  });
  const profile = providersRepository.findProfile(provider.id);
  return { token, is_approved: profile ? Boolean(profile.is_approved) : false };
}

export async function loginAdmin({ email, password }) {
  const admin = repository.findAdminByEmail(email);
  if (!admin) throw new UnauthorizedError("invalid email or password");

  const token = await issueToken({
    email,
    password,
    localId: admin.id,
    role: "admin",
    passwordHash: admin.password_hash,
  });
  return { token };
}

// The /me projection, role-appropriate.
export function getMe(auth) {
  if (auth.role === "customer") {
    const c = repository.findCustomerById(auth.sub);
    if (!c) throw new NotFoundError("customer not found");
    return { role: "customer", ...publicCustomer(c) };
  }
  if (auth.role === "provider") {
    const p = repository.findProviderById(auth.sub);
    if (!p) throw new NotFoundError("provider not found");
    const profile = providersRepository.findProfile(auth.sub);
    return { role: "provider", ...publicProvider(p), profile: profile ?? null };
  }
  const a = repository.findAdminById(auth.sub);
  if (!a) throw new NotFoundError("admin not found");
  return { role: "admin", id: a.id, email: a.email, name: a.name };
}
