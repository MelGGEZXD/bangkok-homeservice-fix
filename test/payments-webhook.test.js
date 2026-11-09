import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, futureWeekday } from "../test-helpers/auth.js";
import { config } from "../lib/config.js";

import * as bookings from "../app/api/bookings/route.js";
import * as webhook from "../app/api/payments/webhook/route.js";

freshBoot();

test("payment webhook idempotency", async (t) => {
  const customer = await loginSeededCustomer("nong@example.com");
  const provider = await loginSeededProvider("sparkle@example.com");
  const addressId = getDb().prepare("SELECT id FROM addresses WHERE customer_id = ? LIMIT 1").get(customer.id).id;
  const date = futureWeekday(3);

  let orderId, gatewayRef;

  await t.test("a gateway booking creates a requires_payment intent", async () => {
    const placed = await call(bookings.POST, {
      token: customer.token,
      body: {
        provider_id: provider.id, address_id: addressId, service_date: date,
        starting_time: "09:00", items: [{ service_id: 2, quantity: 1 }], payment_method: "gateway",
      },
    });
    assert.equal(placed.status, 201);
    assert.equal(placed.body.payment_intent.status, "requires_payment");
    orderId = placed.body.order.id;
    gatewayRef = placed.body.payment_intent.gateway_ref;
    assert.match(gatewayRef, /^SIM-PI-/);
  });

  await t.test("bad X-Webhook-Secret -> 401", async () => {
    const res = await call(webhook.POST, {
      body: { gateway_event_id: "evt-x", type: "payment_intent.succeeded", gateway_ref: gatewayRef },
      secret: "wrong-secret",
    });
    assert.equal(res.status, 401);
  });

  await t.test("first webhook settles the intent, marks the order paid, records one charge + event", async () => {
    const res = await call(webhook.POST, {
      body: { gateway_event_id: "evt-1", type: "payment_intent.succeeded", gateway_ref: gatewayRef },
      secret: config.webhookSecret,
    });
    assert.equal(res.status, 200);

    const intent = getDb().prepare("SELECT status FROM payment_intents WHERE order_id = ?").get(orderId);
    assert.equal(intent.status, "succeeded");
    const order = getDb().prepare("SELECT payment_status FROM orders WHERE id = ?").get(orderId);
    assert.equal(order.payment_status, "paid");
    const charges = getDb().prepare("SELECT COUNT(*) AS n FROM transactions WHERE order_id = ? AND kind = 'charge'").get(orderId).n;
    assert.equal(charges, 1);
    const ev = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'payment.succeeded' AND aggregate_id = ?").get(orderId).n;
    assert.equal(ev, 1);
  });

  await t.test("replaying the same gateway_event_id is a 200 no-op — no double credit", async () => {
    const res = await call(webhook.POST, {
      body: { gateway_event_id: "evt-1", type: "payment_intent.succeeded", gateway_ref: gatewayRef },
      secret: config.webhookSecret,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.replayed, true);

    const charges = getDb().prepare("SELECT COUNT(*) AS n FROM transactions WHERE order_id = ? AND kind = 'charge'").get(orderId).n;
    assert.equal(charges, 1, "still exactly one charge transaction");
    const flips = getDb().prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE gateway_event_id = 'evt-1'").get().n;
    assert.equal(flips, 1, "webhook event recorded exactly once");
  });
});
