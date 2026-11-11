// Provider Profile business logic: the public directory, a provider's own editable profile, weekly
// availability, and the admin-only approve / set-commission actions.
//
// Area C: approval starts an orchestrated saga. The flag flip, the saga row and the
// `provider.approved` outbox event commit in ONE SQLite transaction. The relay publishes the event
// to RabbitMQ; Notifications creates the welcome notification and reports back. If it fails, the
// saga's compensating action unapproves the provider (see lib/modules/sagas/service.js).
import { getDb } from "../../db/index.js";
import { insertEvent } from "../../db/events.js";
import * as repository from "./repository.js";
import * as identityRepository from "../identity/repository.js";
import * as catalogRepository from "../catalog/repository.js";
import { startProviderApprovalSaga } from "../sagas/service.js";
import { NotFoundError, ConflictError } from "../../errors.js";

function publicProfile(provider, profile, { includeCommission = false } = {}) {
  const out = {
    id: provider.id,
    name: provider.name,
    email: provider.email,
    company_name: profile.company_name,
    about: profile.about,
    is_approved: Boolean(profile.is_approved),
    service_radius_km: profile.service_radius_km,
    is_accepting_custom_jobs: Boolean(profile.is_accepting_custom_jobs),
    rating_avg: profile.rating_avg,
    rating_count: profile.rating_count,
  };
  if (includeCommission) out.commission_pct = profile.commission_pct;
  return out;
}

export function listProviders() {
  return repository.listApprovedProviders().map((r) => ({
    ...r,
    is_accepting_custom_jobs: Boolean(r.is_accepting_custom_jobs),
  }));
}

export function listAllForAdmin() {
  return repository.listAllProviders().map((r) => ({ ...r, is_approved: Boolean(r.is_approved) }));
}

export function getPublicProvider(providerId) {
  const row = repository.findPublicProvider(providerId);
  if (!row || !row.is_approved) throw new NotFoundError(`provider ${providerId} not found`);
  return {
    id: row.id,
    name: row.name,
    company_name: row.company_name,
    about: row.about,
    rating_avg: row.rating_avg,
    rating_count: row.rating_count,
    service_radius_km: row.service_radius_km,
    is_accepting_custom_jobs: Boolean(row.is_accepting_custom_jobs),
    services: catalogRepository.listByProvider(providerId).map(catalogRepository.toPublicService),
    timings: repository.listTimings(providerId),
  };
}

export function getOwnProfile(providerId) {
  const provider = identityRepository.findProviderById(providerId);
  const profile = repository.findProfile(providerId);
  if (!provider || !profile) throw new NotFoundError("provider not found");
  return publicProfile(provider, profile, { includeCommission: true });
}

// A provider may edit these fields only — is_approved and commission_pct are admin-controlled.
export function updateOwnProfile(providerId, fields) {
  const allowed = {};
  for (const key of ["company_name", "about", "service_radius_km", "is_accepting_custom_jobs"]) {
    if (fields[key] !== undefined) {
      allowed[key] = key === "is_accepting_custom_jobs" ? (fields[key] ? 1 : 0) : fields[key];
    }
  }
  repository.updateProfile(providerId, allowed);
  return getOwnProfile(providerId);
}

export function getTimings(providerId) {
  return repository.listTimings(providerId);
}

export function replaceTimings(providerId, timings) {
  const run = getDb().transaction(() => {
    for (const t of timings) {
      repository.upsertTiming(providerId, t);
    }
  });
  run();
  return repository.listTimings(providerId);
}

export function approveProvider(providerId) {
  const profile = repository.findProfile(providerId);
  if (!profile) throw new NotFoundError(`provider ${providerId} not found`);
  if (profile.is_approved) throw new ConflictError("provider is already approved");

  let sagaId;
  const run = getDb().transaction(() => {
    repository.approve(providerId);
    // The saga row is part of the same transaction as the state change, so we can never publish an
    // approval event without a workflow to complete or compensate it.
    sagaId = startProviderApprovalSaga(providerId);
    insertEvent("provider.approved", "provider", providerId, {
      provider_id: providerId,
      saga_id: sagaId,
    });
  });
  run();
  // saga_id lets the admin UI/script follow this approval through completion or compensation.
  return { ...getOwnProfile(providerId), saga_id: sagaId };
}

export function setCommission(providerId, commissionPct) {
  const profile = repository.findProfile(providerId);
  if (!profile) throw new NotFoundError(`provider ${providerId} not found`);
  repository.setCommission(providerId, commissionPct);
  return getOwnProfile(providerId);
}
