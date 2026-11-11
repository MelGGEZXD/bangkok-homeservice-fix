// Area E: consumer-driven contract for the monolith -> Notifications boundary.
//
// The monolith is the consumer; the extracted Notifications service is the provider. This test
// starts Pact's mock provider, drives the REAL client module (lib/modules/notifications/client.js)
// against it, and writes pacts/edemand-monolith-notifications-service.json.
//
// The contract pins the two things the caller actually depends on:
//   * GET /api/notifications returns a JSON array of notification objects with these fields
//   * the caller's bearer token is forwarded unchanged (the service, not the monolith, authorises)
//
// Run with: npm run test:pact
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PactV3, MatchersV3 } from "@pact-foundation/pact";

const { like, eachLike, integer, string } = MatchersV3;

const provider = new PactV3({
  consumer: "edemand-monolith",
  provider: "notifications-service",
  dir: path.resolve("pacts"),
  logLevel: "warn",
});

test("monolith reads the caller's inbox through the notifications contract", async () => {
  provider
    .given("customer 1 has at least one notification")
    .uponReceiving("a request for the caller's notifications")
    .withRequest({
      method: "GET",
      path: "/api/notifications",
      headers: {
        authorization: like("Bearer test-token", "Bearer test-token"),
        "x-request-id": like("req-1", "req-1"),
      },
    })
    .willRespondWith({
      status: 200,
      headers: { "content-type": "application/json" },
      body: eachLike({
        id: integer(1),
        type: string("provider_approved"),
        title: string("You are approved"),
        body: string("You can now accept jobs."),
        order_id: integer(8001),
        read_at: null,
        created_at: string("2026-01-01T00:00:00Z"),
      }),
    });

  await provider.executeTest(async (mockServer) => {
    // lib/config.js reads this at module load, so set it before importing the client.
    process.env.NOTIFICATIONS_SERVICE_URL = mockServer.url;
    const client = await import("../../lib/modules/notifications/client.js");

    const rows = await client.listForUser("test-token", "req-1");
    assert.ok(Array.isArray(rows), "the inbox is an array");
    assert.equal(rows[0].type, "provider_approved");
    assert.equal(typeof rows[0].created_at, "string");
  });
});
