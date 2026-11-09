import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { registerCustomer, loginAdmin } from "../test-helpers/auth.js";
import { captureNotifications } from "../test-helpers/notifications.js";
import { runRelayOnce } from "../lib/modules/notifications/relay.js";

import * as approve from "../app/api/admin/providers/[id]/approve/route.js";
import * as commission from "../app/api/admin/providers/[id]/commission/route.js";
import * as adminBookings from "../app/api/admin/bookings/route.js";

freshBoot();

test("admin", async (t) => {
  const admin = await loginAdmin();
  const glowId = getDb().prepare("SELECT id FROM providers WHERE email = 'glow@example.com'").get().id;

  await t.test("a non-admin is forbidden", async () => {
    const customer = await registerCustomer();
    const res = await call(approve.POST, { token: customer.token, params: { id: String(glowId) }, method: "POST" });
    assert.equal(res.status, 403);

    const noAuth = await call(adminBookings.GET);
    assert.equal(noAuth.status, 401);
  });

  await t.test("admin approves the pending provider (Glow) -> is_approved + notification", async () => {
    const before = getDb().prepare("SELECT is_approved FROM provider_profiles WHERE provider_id = ?").get(glowId);
    assert.equal(before.is_approved, 0);

    const res = await call(approve.POST, { token: admin.token, params: { id: String(glowId) }, method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(res.body.is_approved, true);

    const after = getDb().prepare("SELECT is_approved FROM provider_profiles WHERE provider_id = ?").get(glowId);
    assert.equal(after.is_approved, 1);

    // Extraction: approval writes a provider.approved outbox event in the same transaction and the
    // monolith no longer writes a notifications table at all. Delivery happens when the relay runs.
    const evt = getDb().prepare("SELECT * FROM events WHERE type = 'provider.approved' AND aggregate_id = ?").get(glowId);
    assert.ok(evt, "provider.approved event written atomically with the approval");
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='notifications'").get().n, 0,
      "monolith schema no longer owns a notifications table");

    const notifications = captureNotifications();
    await runRelayOnce();
    const notes = notifications.filter((n) => n.recipient_role === "provider" && n.recipient_id === glowId && n.type === "provider_approved");
    assert.equal(notes.length, 1, "relay delivered exactly one approval notification");
  });

  await t.test("admin sets a provider's commission", async () => {
    const res = await call(commission.PATCH, { token: admin.token, params: { id: String(glowId) }, body: { commission_pct: 12.5 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.commission_pct, 12.5);
  });

  await t.test("GET /api/admin/bookings lists all bookings with pagination headers", async () => {
    const res = await call(adminBookings.GET, { token: admin.token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.headers.get("x-total-count") !== null);
    assert.equal(res.headers.get("x-page"), "1");
  });
});
