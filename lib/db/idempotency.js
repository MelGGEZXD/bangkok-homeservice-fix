// Generic Idempotency-Key support. Used by POST /api/bookings.
// A repeated key on the same endpoint replays the stored {statusCode, body} instead of repeating
// the write; the idempotency_keys.key PRIMARY KEY makes two racing writes on one key impossible.
//
// Keys are SCOPED TO THE ACTOR: the stored key is `${actor}:${key}`, so one customer's
// client-generated Idempotency-Key can never replay another customer's response (reusing a key you
// observed from someone else just creates your own booking). This is how real APIs (e.g. Stripe)
// scope idempotency to the calling principal, not globally.
import { getDb } from "./index.js";
import { ConflictError } from "../errors.js";

function find(key) {
  return getDb().prepare("SELECT * FROM idempotency_keys WHERE key = ?").get(key);
}

function save(key, endpoint, statusCode, body) {
  getDb()
    .prepare(
      `INSERT INTO idempotency_keys (key, endpoint, response_json, status_code)
       VALUES (?, ?, ?, ?)`
    )
    .run(key, endpoint, JSON.stringify(body), statusCode);
}

// Runs `performWrite` (a synchronous function returning {statusCode, body}) under the given
// idempotency key + endpoint, atomically: lookup, write, and key-save all happen inside one
// db.transaction, so a crash between "wrote the order" and "recorded the key" cannot happen, and
// two requests racing on the same key cannot both perform the write (the second one to reach the
// INSERT on idempotency_keys.key, a PRIMARY KEY, fails with a constraint error inside the
// transaction, which the caller sees as a thrown error rather than a silent double-write).
//
// If `key` is falsy, idempotency is skipped entirely and `performWrite` still runs inside its own
// transaction for consistency of caller code.
export function withIdempotency(key, endpoint, performWrite, actor = null) {
  const scoped = key ? `${actor}:${key}` : null;
  const run = getDb().transaction(() => {
    if (scoped) {
      const existing = find(scoped);
      if (existing) {
        if (existing.endpoint !== endpoint) {
          throw new ConflictError(
            "Idempotency-Key has already been used for a different request"
          );
        }
        return {
          statusCode: existing.status_code,
          body: JSON.parse(existing.response_json),
          replayed: true,
        };
      }
    }

    const result = performWrite();
    if (scoped) {
      save(scoped, endpoint, result.statusCode, result.body);
    }
    return { ...result, replayed: false };
  });

  // BEGIN IMMEDIATE: grab the write lock up front so a concurrent same-key request cannot slip
  // its lookup in between our lookup and our INSERT.
  return run.immediate();
}
