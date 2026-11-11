// Orchestrated saga for provider approval (Area C).
//
// Why orchestration, not choreography: approval is a single admin action with a clear owner (the
// monolith), a short, fixed sequence of steps, and one compensating action. Putting the sequence in
// one place makes it readable and testable; there is no need for each participant to infer the flow
// from a stream of events. The remote participant (Notifications) stays dumb: it reports whether the
// welcome notification was created.
//
// Steps:
//   1. LOCAL  approve provider + write saga row + write provider.approved outbox event (one SQLite tx)
//   2. REMOTE notifications service consumes the event, creates the welcome notification
//   3. LOCAL  notifications publishes notification.created; saga -> completed
//
// Compensating action: if Notifications reports notification.failed, the monolith unapproves the
// provider and records provider.approval_reverted in the outbox (same transaction as the saga state
// change). The admin can retry a clean approval. A duplicate completion/failure message matches the
// conditional UPDATE zero times and changes nothing.
import { randomUUID } from "node:crypto";
import { getDb } from "../../db/index.js";
import { insertEvent } from "../../db/events.js";
import { logger } from "../../logger.js";
import { NotFoundError } from "../../errors.js";
import * as repository from "./repository.js";
import * as providersRepository from "../providers/repository.js";

export const PROVIDER_APPROVAL = "provider_approval";

// Called inside the approval transaction, so the saga row and the event commit atomically with the
// flag flip. Returns the saga id that is carried in the event payload and exposed to the admin API.
export function startProviderApprovalSaga(providerId) {
  const id = randomUUID();
  repository.insertSaga({
    id,
    type: PROVIDER_APPROVAL,
    state: "awaiting_notification",
    aggregateType: "provider",
    aggregateId: providerId,
    payload: { provider_id: providerId },
  });
  return id;
}

function compensate(saga, reason) {
  const run = getDb().transaction(() => {
    const changed = repository.markCompensated(saga.id, reason);
    if (changed === 0) return false; // already completed/compensated: duplicate message

    if (saga.type === PROVIDER_APPROVAL) {
      // Undo the local step. provider.approval_reverted goes through the same outbox, so the
      // provider is told why they are visible again as pending.
      const reverted = providersRepository.unapprove(saga.aggregate_id);
      if (reverted > 0) {
        insertEvent("provider.approval_reverted", "provider", saga.aggregate_id, {
          provider_id: saga.aggregate_id,
          saga_id: saga.id,
          reason: reason || "notification delivery failed",
        });
      }
    }
    return true;
  });
  return run();
}

// Consume the Notifications service's outcome event. Unknown/duplicate outcomes are harmless.
export function handleNotificationOutcome(envelope) {
  const sagaId = envelope.payload && envelope.payload.saga_id;
  if (!sagaId) return { handled: false, reason: "not a saga outcome" };

  const saga = repository.findSaga(sagaId);
  if (!saga) {
    logger.warn({ sagaId, type: envelope.type }, "saga: outcome for unknown saga");
    return { handled: false, reason: "unknown saga" };
  }

  if (envelope.type === "notification.created") {
    const changed = repository.markCompleted(sagaId);
    if (changed) logger.info({ sagaId, type: saga.type }, "saga: completed");
    return { handled: true, state: changed ? "completed" : saga.state };
  }

  if (envelope.type === "notification.failed") {
    const error = (envelope.payload && envelope.payload.error) || "notification delivery failed";
    const changed = compensate(saga, error);
    if (changed) logger.warn({ sagaId, type: saga.type, error }, "saga: compensated (provider unapproved)");
    return { handled: true, state: changed ? "compensated" : saga.state };
  }

  return { handled: false, reason: `unsupported outcome ${envelope.type}` };
}

export function getSaga(id) {
  const row = repository.findSaga(id);
  if (!row) throw new NotFoundError(`saga ${id} not found`);
  return {
    id: row.id,
    type: row.type,
    state: row.state,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.aggregate_id,
    payload: JSON.parse(row.payload_json),
    attempts: row.attempts,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listSagas() {
  return repository.listSagas().map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
}
