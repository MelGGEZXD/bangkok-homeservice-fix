import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import * as health from "../app/api/health/route.js";
import * as ready from "../app/api/ready/route.js";

freshBoot();

test("GET /api/health is a liveness check returning {status:ok}", async () => {
  const res = await call(health.GET);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "ok" });
  assert.ok(res.headers.get("x-request-id"), "expected X-Request-Id header");
});

test("GET /api/ready reports the database is reachable", async () => {
  const res = await call(ready.GET);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "ok" });
});
