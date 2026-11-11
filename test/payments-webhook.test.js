import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, futureWeekday } from "../test-helpers/auth.js";
import { fakeIntent, fakeTransactions } from "../test-helpers/payments.js";
import { config } from "../lib/config.js";

import * as bookings from "../app/api/bookings/route.js";
import * as webhook from "../app/api/payments/webhook/route.js";
import * as simulate from "../app/api/payments/simulate/route.js";
import * as markPayment from "../app/api/internal/orders/[id]/payment-status/route.js";

freshBoot();

test("payments extraction: intent, idempotent webhook, order settlement", async (t) => {
  const customer = await loginSeededCustomer("nong@example.com");
  const provider = await loginSeededProvider("sparkle@example.com");
  const addressId = getDb().prepare("SELECT id FROM addresses WHERE customer_id = ? LIMIT 1").get(customer.id).id;
  const date = futureWeekday(3);

  let orderId, gatewayRef;

  await t.test("a gateway booking creates a requires_payment intent in the payments service", async () => {
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

    const intent = fakeIntent(orderId);
    assert.ok(intent, "the intent crossed the boundary");
    assert.equal(intent.order_id, orderId);
    assert.equal(intent.status, "requires_payment");
  });

  await t.test("the monolith no longer owns the money tables", async () => {
    const names = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const table of ["payment_intents", "transactions", "provider_wallets", "webhook_events"]) {
      assert.ok(!names.includes(table), `monolith must not own ${table}`);
    }
  });

  await t.test("bad X-Webhook-Secret -> 401", async () => {
    const res = await call(webhook.POST, {
      body: { gateway_event_id: "evt-x", type: "payment_intent.succeeded", gateway_ref: gatewayRef },
      secret: "wrong-secret",
    });
    assert.equal(res.status, 401);
  });

  await t.test("first webhook settles the intent once and marks the order paid", async () => {
    const res = await call(webhook.POST, {
      body: { gateway_event_id: "evt-1", type: "payment_intent.succeeded", gateway_ref: gatewayRef },
      secret: config.webhookSecret,
    });
    assert.equal(res.status, 200);

    assert.equal(fakeIntent(orderId).status, "succeeded");
    const order = getDb().prepare("SELECT payment_status FROM orders WHERE id = ?").get(orderId);
    assert.equal(order.payment_status, "paid");

    const charges = fakeTransactions({ order_id: orderId, kind: "charge" });
    assert.equal(charges.length, 1);
    const ev = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'payment.succeeded' AND aggregate_id = ?").get(orderId).n;
    assert.equal(ev, 1);
  });

  await t.test("replaying the same gateway_event_id is a 200 no-op — no double credit or second event", async () => {
    const res = await call(webhook.POST, {
      body: { gateway_event_id: "evt-1", type: "payment_intent.succeeded", gateway_ref: gatewayRef },
      secret: config.webhookSecret,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.replayed, true);

    const charges = fakeTransactions({ order_id: orderId, kind: "charge" });
    assert.equal(charges.length, 1, "still exactly one charge transaction");
    const ev = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'payment.succeeded' AND aggregate_id = ?").get(orderId).n;
    assert.equal(ev, 1, "the order-side settlement is idempotent too");
  });

  await t.test("the internal order settlement endpoint rejects a missing internal key", async () => {
    const res = await call(markPayment.POST, {
      params: { id: String(orderId) },
      body: { payment_status: "paid" },
    });
    assert.equal(res.status, 401);
  });

  await t.test("the internal settlement endpoint accepts the payments service's snake_case body", async () => {
    const res = await call(markPayment.POST, {
      params: { id: String(orderId) },
      body: { payment_status: "paid", gateway_ref: gatewayRef },
      headers: { "x-internal-key": config.internalApiKey },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.payment_status, "paid");
    const ev = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'payment.succeeded' AND aggregate_id = ?").get(orderId).n;
    assert.equal(ev, 1, "the replayed settlement does not emit a second event");
  });

  await t.test("simulate requires the caller to be the customer on the booking", async () => {
    const other = await loginSeededCustomer("somchai@example.com");
    const res = await call(simulate.POST, { token: other.token, body: { order_id: orderId } });
    assert.equal(res.status, 403);
  });
});
