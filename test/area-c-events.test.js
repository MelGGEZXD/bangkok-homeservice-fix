// Area C proof at the unit level: outbox -> RabbitMQ publisher, event projection, dedupe, and the
// orchestrated provider-approval saga including its compensating action.
//
// The broker itself is proven by scripts/verify-area-c.sh on the live stack; here the publisher is
// replaced with the shared projection rules so the semantics can be exercised deterministically.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, loginAdmin, futureWeekday } from "../test-helpers/auth.js";
import { captureNotifications, publishedEvents } from "../test-helpers/notifications.js";
import { runRelayOnce } from "../lib/modules/notifications/relay.js";
import { handleNotificationOutcome } from "../lib/modules/sagas/service.js";
import { release } from "../lib/db/events.js";
import * as providersRepository from "../lib/modules/providers/repository.js";

import * as approve from "../app/api/admin/providers/[id]/approve/route.js";
import * as bookings from "../app/api/bookings/route.js";

freshBoot();

const GLOW_ID = 3; // seeded pending provider
const SERVICE_ID = 2; // Sofa Shampoo, Sparkle

function sagaRow(id) {
  return getDb().prepare("SELECT * FROM sagas WHERE id = ?").get(id);
}

test("Area C: outbox -> broker, duplicate dedupe, and a compensating saga", async (t) => {
  const admin = await loginAdmin();
  const customer = await loginSeededCustomer("nong@example.com");
  const provider = await loginSeededProvider("sparkle@example.com");
  const addressId = getDb().prepare("SELECT id FROM addresses WHERE customer_id = ? LIMIT 1").get(customer.id).id;
  const date = futureWeekday(3);
  const notifications = captureNotifications();

  let sagaId;
  let approvalEvent;

  await t.test("approval commits the flag, saga row and provider.approved event atomically", async () => {
    const res = await call(approve.POST, { token: admin.token, params: { id: String(GLOW_ID) }, method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(res.body.is_approved, true);
    assert.match(res.body.saga_id, /^[0-9a-f-]{36}$/, "approval returns the orchestrating saga id");
    sagaId = res.body.saga_id;

    const saga = sagaRow(sagaId);
    assert.ok(saga, "saga row committed with the approval");
    assert.equal(saga.type, "provider_approval");
    assert.equal(saga.state, "awaiting_notification");
    assert.equal(saga.aggregate_id, GLOW_ID);

    approvalEvent = getDb()
      .prepare("SELECT * FROM events WHERE type = 'provider.approved' AND aggregate_id = ?")
      .get(GLOW_ID);
    assert.ok(approvalEvent, "provider.approved written in the same transaction");
    assert.equal(JSON.parse(approvalEvent.payload_json).saga_id, sagaId);
  });

  await t.test("the relay publishes the raw event; the projection creates exactly one notification", async () => {
    const processed = await runRelayOnce();
    assert.ok(processed >= 1);

    const published = publishedEvents().filter((e) => e.type === "provider.approved");
    assert.equal(published.length, 1, "one raw provider.approved envelope crosses the boundary");
    assert.equal(published[0].event_uid, approvalEvent.event_uid);
    assert.equal(published[0].payload.saga_id, sagaId);

    const notes = notifications.filter((n) => n.type === "provider_approved" && n.recipient_id === GLOW_ID);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].source_event_id, approvalEvent.event_uid);
  });

  await t.test("a duplicate RabbitMQ delivery has exactly one effect", async () => {
    const deliveredBefore = notifications.length;

    // Emulate broker redelivery: release the outbox claim, so the relay publishes the same event
    // (same event_uid) again. The consumer-side dedupe key must absorb it.
    release(approvalEvent.id);
    await runRelayOnce();

    assert.equal(
      publishedEvents().filter((e) => e.type === "provider.approved").length,
      2,
      "the same event really was published twice"
    );
    assert.equal(notifications.length, deliveredBefore, "no second notification row for the same event");
  });

  await t.test("notification.created completes the saga; a duplicate outcome is a no-op", async () => {
    const outcome = {
      type: "notification.created",
      payload: { saga_id: sagaId, source_event_id: approvalEvent.event_uid },
    };
    handleNotificationOutcome(outcome);
    assert.equal(sagaRow(sagaId).state, "completed");

    handleNotificationOutcome(outcome);
    assert.equal(sagaRow(sagaId).state, "completed", "duplicate completion does not move the saga");
    assert.equal(sagaRow(sagaId).attempts, 0);
  });

  await t.test("a second event type (booking.status_changed) also travels as an event", async () => {
    const placed = await call(bookings.POST, {
      token: customer.token,
      body: {
        provider_id: provider.id,
        address_id: addressId,
        service_date: date,
        starting_time: "10:00",
        items: [{ service_id: SERVICE_ID, quantity: 1 }],
        payment_method: "cod",
      },
    });
    assert.equal(placed.status, 201);

    const bookingEvent = getDb()
      .prepare("SELECT * FROM events WHERE type = 'booking.status_changed' AND aggregate_id = ?")
      .get(placed.body.order.id);
    assert.ok(bookingEvent);

    await runRelayOnce();
    const published = publishedEvents().filter((e) => e.type === "booking.status_changed");
    assert.ok(published.some((e) => e.event_uid === bookingEvent.event_uid), "booking event published to the broker");

    const notes = notifications.filter(
      (n) => n.type === "booking_status" && n.order_id === placed.body.order.id && n.recipient_id === provider.id
    );
    assert.equal(notes.length, 1, "the projection routed the booking event to the counterparty");
  });

  await t.test("notification.failed compensates: the provider is unapproved and a revert event is written", async () => {
    // The demo needs a pending provider again. This is a test fixture reset, not the compensation.
    providersRepository.unapprove(GLOW_ID);

    const res = await call(approve.POST, { token: admin.token, params: { id: String(GLOW_ID) }, method: "POST" });
    assert.equal(res.status, 200);
    const failingSagaId = res.body.saga_id;
    await runRelayOnce();

    const failure = {
      type: "notification.failed",
      payload: { saga_id: failingSagaId, error: "injected notification failure" },
    };
    handleNotificationOutcome(failure);

    const saga = sagaRow(failingSagaId);
    assert.equal(saga.state, "compensated");
    assert.equal(saga.attempts, 1);
    assert.match(saga.last_error, /injected notification failure/);

    const profile = getDb().prepare("SELECT is_approved FROM provider_profiles WHERE provider_id = ?").get(GLOW_ID);
    assert.equal(profile.is_approved, 0, "compensating action unapproved the provider");

    const revert = getDb()
      .prepare("SELECT * FROM events WHERE type = 'provider.approval_reverted' AND aggregate_id = ?")
      .get(GLOW_ID);
    assert.ok(revert, "revert event written in the same transaction as the compensation");
    assert.equal(JSON.parse(revert.payload_json).saga_id, failingSagaId);

    // A duplicate failure message must not compensate twice or emit a second revert event.
    handleNotificationOutcome(failure);
    assert.equal(sagaRow(failingSagaId).attempts, 1, "duplicate failure is a no-op");
    const reverts = getDb()
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'provider.approval_reverted' AND aggregate_id = ?")
      .get(GLOW_ID).n;
    assert.equal(reverts, 1);

    await runRelayOnce();
    const revertNotes = notifications.filter(
      (n) => n.type === "provider_approval_reverted" && n.recipient_id === GLOW_ID
    );
    assert.equal(revertNotes.length, 1, "the revert was projected like any other event");
  });

  await t.test("after compensation the admin can retry and the approval completes", async () => {
    const res = await call(approve.POST, { token: admin.token, params: { id: String(GLOW_ID) }, method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(res.body.is_approved, true);
    assert.notEqual(res.body.saga_id, sagaId, "a retry is a fresh saga");

    await runRelayOnce();
    handleNotificationOutcome({
      type: "notification.created",
      payload: { saga_id: res.body.saga_id },
    });
    assert.equal(sagaRow(res.body.saga_id).state, "completed");
  });
});
