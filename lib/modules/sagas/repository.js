// Persistence for cross-service sagas. SQL only.
import { getDb } from "../../db/index.js";

export function insertSaga({ id, type, state, aggregateType, aggregateId, payload }) {
  getDb()
    .prepare(
      `INSERT INTO sagas (id, type, state, aggregate_type, aggregate_id, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, type, state, aggregateType, aggregateId, JSON.stringify(payload ?? {}));
  return id;
}

export function findSaga(id) {
  return getDb().prepare("SELECT * FROM sagas WHERE id = ?").get(id);
}

export function listSagas(limit = 50) {
  return getDb().prepare("SELECT * FROM sagas ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit);
}

// Conditional transitions: a duplicate broker message must never move a finished saga again.
export function markCompleted(id) {
  return getDb()
    .prepare(
      `UPDATE sagas
          SET state = 'completed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND state = 'awaiting_notification'`
    )
    .run(id).changes;
}

export function markCompensated(id, error) {
  return getDb()
    .prepare(
      `UPDATE sagas
          SET state = 'compensated', last_error = ?, attempts = attempts + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND state = 'awaiting_notification'`
    )
    .run(error ?? null, id).changes;
}

export function markFailed(id, error) {
  return getDb()
    .prepare(
      `UPDATE sagas
          SET state = 'failed', last_error = ?, attempts = attempts + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND state = 'awaiting_notification'`
    )
    .run(error ?? null, id).changes;
}
