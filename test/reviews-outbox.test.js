import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, futureWeekday } from "../test-helpers/auth.js";
import { captureNotifications, deliveredNotifications } from "../test-helpers/notifications.js";
import { runRelayOnce } from "../lib/modules/notifications/relay.js";

import * as bookings from "../app/api/bookings/route.js";
import * as confirm from "../app/api/bookings/[id]/confirm/route.js";
import * as start from "../app/api/bookings/[id]/start/route.js";
import * as complete from "../app/api/bookings/[id]/complete/route.js";
import * as review from "../app/api/bookings/[id]/review/route.js";

freshBoot();

const SERVICE_ID = 2; // Sofa Shampoo, Sparkle

test("reviews + outbox eventual consistency", async (t) => {
  const notifications = captureNotifications();
  const customer = await loginSeededCustomer("nong@example.com");
  const provider = await loginSeededProvider("sparkle@example.com");
  const addressId = getDb().prepare("SELECT id FROM addresses WHERE customer_id = ? LIMIT 1").get(customer.id).id;
  const date = futureWeekday(3);

  let orderId, otp;

  await t.test("a review before completion -> 409", async () => {
    const placed = await call(bookings.POST, {
      token: customer.token,
      body: {
        provider_id: provider.id, address_id: addressId, service_date: date,
        starting_time: "10:00", items: [{ service_id: SERVICE_ID, quantity: 1 }], payment_method: "cod",
      },
    });
    orderId = placed.body.order.id;
    otp = placed.body.otp;
    const early = await call(review.POST, { token: customer.token, params: { id: String(orderId) }, body: { rating: 5 } });
    assert.equal(early.status, 409);
  });

  await t.test("complete then review (201) writes the review + event but the aggregate stays stale", async () => {
    await call(confirm.POST, { token: provider.token, params: { id: String(orderId) }, method: "POST" });
    await call(start.POST, { token: provider.token, params: { id: String(orderId) }, method: "POST" });
    const done = await call(complete.POST, { token: provider.token, params: { id: String(orderId) }, body: { otp } });
    assert.equal(done.status, 200);

    const res = await call(review.POST, { token: customer.token, params: { id: String(orderId) }, body: { rating: 5, comment: "spotless" } });
    assert.equal(res.status, 201);
    assert.equal(res.body.rating, 5);

    const evt = getDb().prepare("SELECT * FROM events WHERE type = 'review.created'").get();
    assert.ok(evt, "review.created outbox event exists");

    const svc = getDb().prepare("SELECT rating_avg, rating_count FROM services WHERE id = ?").get(SERVICE_ID);
    assert.equal(svc.rating_count, 0, "aggregate is STILL stale — recompute happens in the relay, not inline");
    assert.equal(svc.rating_avg, 0);
  });

  await t.test("running the relay recomputes the aggregate and delivers the notification across the boundary", async () => {
    const processed = await runRelayOnce();
    assert.ok(processed > 0, "relay drained events");

    const svc = getDb().prepare("SELECT rating_avg, rating_count FROM services WHERE id = ?").get(SERVICE_ID);
    assert.equal(svc.rating_count, 1);
    assert.equal(svc.rating_avg, 5);

    const prof = getDb().prepare("SELECT rating_avg, rating_count FROM provider_profiles WHERE provider_id = ?").get(provider.id);
    assert.equal(prof.rating_count, 1, "provider aggregate recomputed too");

    const notes = notifications.filter((n) => n.type === "new_review" && n.recipient_id === provider.id);
    assert.equal(notes.length, 1, "provider got exactly one new_review notification");
    assert.equal(notes[0].recipient_role, "provider");
    assert.match(notes[0].source_event_id, /^[0-9a-f-]{36}$/, "delivery carries the outbox event UUID for dedupe");
  });

  await t.test("a duplicate review -> 409", async () => {
    const dup = await call(review.POST, { token: customer.token, params: { id: String(orderId) }, body: { rating: 3 } });
    assert.equal(dup.status, 409);
  });

  await t.test("the relay is idempotent: a second pass does not double-apply", async () => {
    const before = getDb().prepare("SELECT rating_avg, rating_count FROM services WHERE id = ?").get(SERVICE_ID);
    const deliveredBefore = notifications.length;
    const processed = await runRelayOnce();
    assert.equal(processed, 0, "no unprocessed events remain");
    const after = getDb().prepare("SELECT rating_avg, rating_count FROM services WHERE id = ?").get(SERVICE_ID);
    assert.deepEqual(after, before, "aggregate unchanged on a second relay pass");
    assert.equal(notifications.length, deliveredBefore, "no duplicate notification delivered");
  });
});
