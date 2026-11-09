import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, futureWeekday } from "../test-helpers/auth.js";
import { todayDate, weekdayOf, nowHHMM } from "../lib/modules/booking/slots.js";

import * as slots from "../app/api/providers/[id]/slots/route.js";
import * as bookings from "../app/api/bookings/route.js";

freshBoot();

function nextSunday() {
  let d = new Date();
  do {
    d = new Date(d.getTime() + 86400000);
  } while (d.getUTCDay() !== 0);
  return d.toISOString().slice(0, 10);
}

test("available slots", async (t) => {
  const provider = await loginSeededProvider("sparkle@example.com");
  const pid = String(provider.id);
  const openDate = futureWeekday(3);

  await t.test("a closed weekday (Sunday) yields no slots", async () => {
    const res = await call(slots.GET, { params: { id: pid }, query: { date: nextSunday(), duration: 60 } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.slots, []);
  });

  await t.test("an open weekday reflects 09:00–18:00 hours for a 60-min service", async () => {
    const res = await call(slots.GET, { params: { id: pid }, query: { date: openDate, duration: 60 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.slots[0], "09:00");
    assert.equal(res.body.slots[res.body.slots.length - 1], "17:00", "17:00 + 60 = 18:00 fits; 17:30 would not");
    assert.ok(!res.body.slots.includes("17:30"));
  });

  await t.test("a 180-min service near closing yields no late start", async () => {
    const res = await call(slots.GET, { params: { id: pid }, query: { date: openDate, duration: 180 } });
    assert.equal(res.body.slots[res.body.slots.length - 1], "15:00", "15:00 + 180 = 18:00; 15:30 would overrun");
    assert.ok(!res.body.slots.includes("15:30"));
    assert.ok(!res.body.slots.includes("16:00"));
  });

  await t.test("held slots are excluded", async () => {
    const customer = await loginSeededCustomer("nong@example.com");
    const addressId = getDb().prepare("SELECT id FROM addresses WHERE customer_id = ? LIMIT 1").get(customer.id).id;
    // Sofa Shampoo (id 2, 90 min) at 10:00 -> holds 10:00, 10:30, 11:00.
    const placed = await call(bookings.POST, {
      token: customer.token,
      body: {
        provider_id: provider.id, address_id: addressId, service_date: openDate,
        starting_time: "10:00", items: [{ service_id: 2, quantity: 1 }], payment_method: "cod",
      },
    });
    assert.equal(placed.status, 201);

    const res = await call(slots.GET, { params: { id: pid }, query: { date: openDate, duration: 60 } });
    assert.ok(res.body.slots.includes("09:00"), "09:00–10:00 is still free");
    assert.ok(!res.body.slots.includes("09:30"), "09:30–10:30 overlaps the 10:00 hold");
    assert.ok(!res.body.slots.includes("10:00"));
    assert.ok(!res.body.slots.includes("10:30"));
    assert.ok(!res.body.slots.includes("11:00"));
    assert.ok(res.body.slots.includes("11:30"), "11:30–12:30 is free again");
  });

  await t.test("past starts today are excluded", async () => {
    const today = todayDate();
    const res = await call(slots.GET, { params: { id: pid }, query: { date: today, duration: 60 } });
    assert.equal(res.status, 200);
    if (weekdayOf(today) === 0) {
      assert.deepEqual(res.body.slots, [], "Sunday: closed");
    } else {
      const now = nowHHMM();
      for (const s of res.body.slots) {
        assert.ok(s >= now, `slot ${s} should not be before now (${now})`);
      }
    }
  });
});
