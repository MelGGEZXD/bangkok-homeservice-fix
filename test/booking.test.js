// Core booking lifecycle — one top-level test with sequential subtests. Order ids are AUTOINCREMENT
// and this file's very first booking MUST land on 8001 (sqlite_sequence primed to 8000 on seed);
// later subtests build on state earlier ones created. Sequential subtests make that chain explicit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, futureWeekday } from "../test-helpers/auth.js";

import * as bookings from "../app/api/bookings/route.js";
import * as bookingDetail from "../app/api/bookings/[id]/route.js";
import * as confirm from "../app/api/bookings/[id]/confirm/route.js";
import * as start from "../app/api/bookings/[id]/start/route.js";
import * as complete from "../app/api/bookings/[id]/complete/route.js";
import * as cancel from "../app/api/bookings/[id]/cancel/route.js";
import * as reschedule from "../app/api/bookings/[id]/reschedule/route.js";

freshBoot();

const SERVICE_ID = 2; // Sofa Shampoo, Sparkle, 90 min (3 slots)

function orderCount() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM orders").get().n;
}
function slotHoldCount(providerId, date, slot) {
  return getDb()
    .prepare("SELECT COUNT(*) AS n FROM slot_holds WHERE provider_id = ? AND service_date = ? AND slot_time = ?")
    .get(providerId, date, slot).n;
}

test("booking lifecycle", async (t) => {
  let customer, provider, otherProvider, addressId, date, date2;
  let first, firstOtp;

  await t.test("setup", async () => {
    customer = await loginSeededCustomer("nong@example.com");
    provider = await loginSeededProvider("sparkle@example.com");
    otherProvider = await loginSeededProvider("fixit@example.com");
    addressId = getDb().prepare("SELECT id FROM addresses WHERE customer_id = ? LIMIT 1").get(customer.id).id;
    date = futureWeekday(3);
    date2 = futureWeekday(10);
    // ensure the two dates differ
    if (date === date2) date2 = futureWeekday(11);
  });

  await t.test("place the first booking -> id 8001, awaiting, OTP present, 3 slot_holds", async () => {
    const res = await call(bookings.POST, {
      token: customer.token,
      body: {
        provider_id: provider.id, address_id: addressId, service_date: date,
        starting_time: "10:00", items: [{ service_id: SERVICE_ID, quantity: 1 }], payment_method: "cod",
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.order.id, 8001, "first booking on a fresh boot is 8001");
    assert.equal(res.headers.get("location"), "/api/bookings/8001");
    assert.equal(res.body.order.status, "awaiting");
    assert.ok(res.body.otp >= 100000 && res.body.otp <= 999999, "6-digit OTP present");
    const holds = getDb().prepare("SELECT COUNT(*) AS n FROM slot_holds WHERE order_id = ?").get(8001).n;
    assert.equal(holds, 3, "90 min / 30 = 3 slot_holds");
    first = res.body.order;
    firstOtp = res.body.otp;
  });

  await t.test("validation: missing items -> 400; bad service_date -> 400", async () => {
    const noItems = await call(bookings.POST, {
      token: customer.token,
      body: { provider_id: provider.id, service_date: date, starting_time: "10:00", items: [], payment_method: "cod" },
    });
    assert.equal(noItems.status, 400);

    const badDate = await call(bookings.POST, {
      token: customer.token,
      body: { provider_id: provider.id, service_date: "not-a-date", starting_time: "10:00", items: [{ service_id: SERVICE_ID, quantity: 1 }], payment_method: "cod" },
    });
    assert.equal(badDate.status, 400);
  });

  await t.test("idempotency: same key replays the same order, no second row", async () => {
    const key = "book-idem-1";
    const body = {
      provider_id: provider.id, address_id: addressId, service_date: date,
      starting_time: "14:00", items: [{ service_id: SERVICE_ID, quantity: 1 }], payment_method: "cod",
    };
    const firstCall = await call(bookings.POST, { token: customer.token, body, headers: { "idempotency-key": key } });
    assert.equal(firstCall.status, 201);
    const before = orderCount();
    const replay = await call(bookings.POST, { token: customer.token, body, headers: { "idempotency-key": key } });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.order.id, firstCall.body.order.id, "replay returns the same order id");
    assert.equal(orderCount(), before, "replay did not create a second order");
  });

  await t.test("SLOT DOUBLE-BOOK RACE: two concurrent bookings on the same slot -> one 201, one 409", async () => {
    const mk = () =>
      call(bookings.POST, {
        token: customer.token,
        body: {
          provider_id: provider.id, address_id: addressId, service_date: date,
          starting_time: "16:00", items: [{ service_id: SERVICE_ID, quantity: 1 }], payment_method: "cod",
        },
      });
    const [a, b] = await Promise.all([mk(), mk()]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409], `expected one 201 and one 409, got ${statuses}`);
    const loser = a.status === 409 ? a : b;
    assert.match(loser.body.error, /slot no longer available/);
    // Exactly one order holds the 16:00 slot.
    assert.equal(slotHoldCount(provider.id, date, "16:00"), 1, "exactly one slot_holds row for 16:00");
  });

  await t.test("state machine: confirm, wrong-provider start 403, complete-before-start 409, start, illegal restart 409", async () => {
    const confirmed = await call(confirm.POST, { token: provider.token, params: { id: "8001" }, method: "POST" });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.status, "confirmed");

    const wrongProvider = await call(start.POST, { token: otherProvider.token, params: { id: "8001" }, method: "POST" });
    assert.equal(wrongProvider.status, 403);

    const tooEarly = await call(complete.POST, { token: provider.token, params: { id: "8001" }, body: { otp: firstOtp } });
    assert.equal(tooEarly.status, 409, "cannot complete a booking that has not started");

    const started = await call(start.POST, { token: provider.token, params: { id: "8001" }, method: "POST" });
    assert.equal(started.status, 200);
    assert.equal(started.body.status, "started");

    const restart = await call(start.POST, { token: provider.token, params: { id: "8001" }, method: "POST" });
    assert.equal(restart.status, 409);
  });

  await t.test("OTP-gated complete: wrong 409, missing 400, correct 200; wallet credited exactly once", async () => {
    const wrongOtp = await call(complete.POST, { token: provider.token, params: { id: "8001" }, body: { otp: 111111 } });
    assert.equal(wrongOtp.status, 409);
    assert.match(wrongOtp.body.error, /incorrect OTP/);

    const missing = await call(complete.POST, { token: provider.token, params: { id: "8001" }, body: {}, method: "POST" });
    assert.equal(missing.status, 400);

    const done = await call(complete.POST, { token: provider.token, params: { id: "8001" }, body: { otp: firstOtp } });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, "completed");

    const event = getDb().prepare("SELECT * FROM events WHERE type = 'booking.completed' AND aggregate_id = 8001").get();
    assert.ok(event, "expected a booking.completed outbox event");

    // COD: commission is owed by the provider. total = 64200, commission = round(64200*0.15) = 9630.
    const owedAfter = getDb().prepare("SELECT commission_owed_cents AS c FROM provider_wallets WHERE provider_id = ?").get(provider.id).c;
    assert.equal(owedAfter, 9630);

    const second = await call(complete.POST, { token: provider.token, params: { id: "8001" }, body: { otp: firstOtp } });
    assert.equal(second.status, 409, "a second complete is rejected");
    const owedStill = getDb().prepare("SELECT commission_owed_cents AS c FROM provider_wallets WHERE provider_id = ?").get(provider.id).c;
    assert.equal(owedStill, 9630, "wallet unchanged — credited exactly once");
  });

  await t.test("cancel releases slot_holds; a cancelled slot is bookable again; cancel a completed booking -> 409", async () => {
    const placed = await call(bookings.POST, {
      token: customer.token,
      body: {
        provider_id: provider.id, address_id: addressId, service_date: date,
        starting_time: "12:00", items: [{ service_id: SERVICE_ID, quantity: 1 }], payment_method: "cod",
      },
    });
    assert.equal(placed.status, 201);
    assert.equal(slotHoldCount(provider.id, date, "12:00"), 1);

    const cancelled = await call(cancel.POST, { token: customer.token, params: { id: String(placed.body.order.id) }, method: "POST" });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.order.status, "cancelled");
    assert.equal(slotHoldCount(provider.id, date, "12:00"), 0, "slot released");

    const rebook = await call(bookings.POST, {
      token: customer.token,
      body: {
        provider_id: provider.id, address_id: addressId, service_date: date,
        starting_time: "12:00", items: [{ service_id: SERVICE_ID, quantity: 1 }], payment_method: "cod",
      },
    });
    assert.equal(rebook.status, 201, "the freed slot is bookable again");

    const cancelDone = await call(cancel.POST, { token: customer.token, params: { id: "8001" }, method: "POST" });
    assert.equal(cancelDone.status, 409, "cannot cancel a completed booking");
  });

  await t.test("reschedule onto a taken slot -> 409 (old holds intact); onto a free slot -> 200 rescheduled", async () => {
    const placed = await call(bookings.POST, {
      token: customer.token,
      body: {
        provider_id: provider.id, address_id: addressId, service_date: date2,
        starting_time: "10:00", items: [{ service_id: SERVICE_ID, quantity: 1 }], payment_method: "cod",
      },
    });
    const id = String(placed.body.order.id);
    assert.equal(placed.status, 201);

    // date @ 10:00 is held by booking 8001 -> clash -> 409, and this booking keeps its own holds.
    const clash = await call(reschedule.POST, { token: customer.token, params: { id }, body: { service_date: date, starting_time: "10:00" } });
    assert.equal(clash.status, 409);
    assert.equal(slotHoldCount(provider.id, date2, "10:00"), 1, "old holds preserved after a failed reschedule");

    const ok = await call(reschedule.POST, { token: customer.token, params: { id }, body: { service_date: date2, starting_time: "13:00" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, "rescheduled");
    assert.equal(slotHoldCount(provider.id, date2, "10:00"), 0, "old slot released");
    assert.equal(slotHoldCount(provider.id, date2, "13:00"), 1, "new slot held");
  });

  await t.test("GET /api/bookings/:id is participant-only, and shows OTP to the customer only", async () => {
    const asCustomer = await call(bookingDetail.GET, { token: customer.token, params: { id: "8001" } });
    assert.equal(asCustomer.status, 200);
    assert.ok(asCustomer.body.otp, "customer sees the OTP");

    const asProvider = await call(bookingDetail.GET, { token: provider.token, params: { id: "8001" } });
    assert.equal(asProvider.status, 200);
    assert.equal(asProvider.body.otp, undefined, "provider does not see the OTP");

    const stranger = await call(bookingDetail.GET, { token: otherProvider.token, params: { id: "8001" } });
    assert.equal(stranger.status, 403);
  });
});
