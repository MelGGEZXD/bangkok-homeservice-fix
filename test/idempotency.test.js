// Idempotency keys are scoped per actor: one customer cannot replay another customer's stored
// response by reusing the same Idempotency-Key. Unit-level test against withIdempotency directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot } from "../test-helpers/boot.js";
import { withIdempotency } from "../lib/db/idempotency.js";

freshBoot();

test("idempotency keys are scoped per actor", () => {
  // actor 1 stores a response under key "shared"
  const a = withIdempotency("shared", "POST /api/bookings", () => ({ statusCode: 201, body: { who: 1 } }), 1);
  assert.equal(a.statusCode, 201);
  assert.deepEqual(a.body, { who: 1 });
  assert.equal(a.replayed, false);

  // actor 2 reusing the SAME literal key -> its OWN write, never actor 1's body
  const b = withIdempotency("shared", "POST /api/bookings", () => ({ statusCode: 201, body: { who: 2 } }), 2);
  assert.equal(b.statusCode, 201);
  assert.deepEqual(b.body, { who: 2 });
  assert.equal(b.replayed, false);

  // actor 1 replaying still gets actor 1's original body (not a re-run, not actor 2's)
  const a2 = withIdempotency("shared", "POST /api/bookings", () => ({ statusCode: 500, body: { who: "reran" } }), 1);
  assert.equal(a2.statusCode, 201);
  assert.deepEqual(a2.body, { who: 1 });
  assert.equal(a2.replayed, true);
});

test("same actor + same key on a different endpoint conflicts", () => {
  withIdempotency("dual", "POST /api/a", () => ({ statusCode: 200, body: { ok: true } }), 7);
  assert.throws(
    () => withIdempotency("dual", "POST /api/b", () => ({ statusCode: 200, body: {} }), 7),
    /already been used for a different request/
  );
});
