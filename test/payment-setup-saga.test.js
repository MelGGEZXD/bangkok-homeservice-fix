import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

test("online booking payment setup across an HTTP boundary", async (t) => {
  const intents = new Map();
  let nextOutcome = "ready";
  let lastRequest;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const request = JSON.parse(body);
    lastRequest = request;
    const outcome = nextOutcome;
    nextOutcome = "ready";
    if (outcome === "reject") {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "payment_setup_rejected" }));
      return;
    }
    if (!intents.has(request.booking_ref)) {
      intents.set(request.booking_ref, {
        id: intents.size + 1, booking_ref: request.booking_ref,
        amount_cents: request.amount_cents, gateway_ref: `SIM-PI-${request.booking_ref}`,
        status: "requires_payment",
      });
    }
    if (outcome === "lose-reply") {
      res.destroy();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(intents.get(request.booking_ref)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  process.env.PAYMENTS_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;

  const { freshBoot, getDb } = await import("../test-helpers/boot.js");
  const { call } = await import("../test-helpers/call.js");
  const { loginSeededCustomer, loginSeededProvider, futureWeekday } = await import("../test-helpers/auth.js");
  const bookings = await import("../app/api/bookings/route.js");
  const confirm = await import("../app/api/bookings/[id]/confirm/route.js");
  const simulate = await import("../app/api/payments/simulate/route.js");
  freshBoot();

  const customer = await loginSeededCustomer("nong@example.com");
  const provider = await loginSeededProvider("sparkle@example.com");
  const db = getDb();
  const date = futureWeekday(3);
  const place = (time, key) => call(bookings.POST, {
    token: customer.token,
    headers: { "idempotency-key": key },
    body: { provider_id: provider.id, service_date: date, starting_time: time,
      items: [{ service_id: 2, quantity: 1 }], payment_method: "gateway" },
  });
  const setupFor = (id) => db.prepare("SELECT * FROM booking_payment_setup WHERE order_id = ?").get(id);
  const held = (id) => db.prepare("SELECT COUNT(*) AS n FROM slot_holds WHERE order_id = ?").get(id).n;

  await t.test("creates the remote intent and preserves the simulated checkout", async () => {
    const placed = await place("09:00", "success");
    assert.equal(placed.status, 201);
    const id = placed.body.order.id;
    assert.equal(placed.body.payment_intent.order_id, id);
    assert.equal(placed.body.payment_intent.status, "requires_payment");
    assert.equal(placed.body.payment_intent.amount_cents, placed.body.order.total_cents);
    assert.equal(setupFor(id).state, "ready");
    assert.equal(held(id), 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payment_intents").get().n, 0);

    for (let attempt = 0; attempt < 2; attempt++) {
      const paid = await call(simulate.POST, { token: customer.token, body: { order_id: id } });
      assert.equal(paid.status, 200);
    }
    assert.equal(db.prepare("SELECT payment_status FROM orders WHERE id = ?").get(id).payment_status, "paid");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE order_id = ? AND kind = 'charge'").get(id).n, 1);
  });

  await t.test("compensates an explicit rejection and makes the same slot bookable again", async () => {
    nextOutcome = "reject";
    const rejected = await place("11:00", "rejected");
    assert.equal(rejected.status, 409);
    const rejectedRef = lastRequest.booking_ref;
    assert.equal(intents.has(rejectedRef), false);
    const setup = db.prepare("SELECT * FROM booking_payment_setup WHERE booking_ref = ?").get(rejectedRef);
    assert.equal(rejected.body.details.order_id, setup.order_id);
    assert.equal(setup.state, "rejected");
    assert.equal(db.prepare("SELECT status FROM orders WHERE id = ?").get(setup.order_id).status, "cancelled");
    assert.equal(held(setup.order_id), 0);
    assert.equal((await place("11:00", "rebook")).status, 201);
  });

  await t.test("a lost reply keeps the hold and retry reuses the original intent", async () => {
    nextOutcome = "lose-reply";
    const pending = await place("13:00", "lost-reply");
    assert.equal(pending.status, 202);
    assert.equal(pending.body.payment_setup, "pending");
    const id = pending.body.order.id;
    const ref = lastRequest.booking_ref;
    assert.equal(held(id), 3);
    const storedIntent = intents.get(ref);
    assert.ok(storedIntent);

    const blocked = await call(confirm.POST, {
      token: provider.token, params: { id: String(id) }, method: "POST",
    });
    assert.equal(blocked.status, 409);

    const count = intents.size;
    const retried = await place("13:00", "lost-reply");
    assert.equal(retried.status, 201);
    assert.equal(retried.body.order.id, id);
    assert.equal(retried.body.payment_intent.id, storedIntent.id);
    assert.equal(lastRequest.booking_ref, ref);
    assert.equal(intents.size, count);
    assert.equal(setupFor(id).state, "ready");
    assert.equal(held(id), 3);
  });
});
