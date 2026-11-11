// Area E: consumer-driven contract for the monolith -> Payments & Wallet boundary.
//
// The monolith is the consumer; the extracted payments service is the provider. This test drives
// the real client (lib/modules/payments/client.js) against Pact's mock provider and writes
// pacts/edemand-monolith-payments-service.json.
//
// The contract pins the internal write and the public read that the monolith depends on:
//   * POST /internal/payment-intents is idempotent and answers 201 { intent: {...} }
//   * GET  /api/provider/wallet answers the wallet + ledger shape
// It also pins the Idempotency-Key header: Area D's retry safety depends on the provider seeing it.
//
// Both interactions live on ONE mock server because lib/config.js captures the service URL at
// module load. node --test runs each file in its own process, so the notifications contract (a
// different file) gets a fresh mock URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PactV3, MatchersV3 } from "@pact-foundation/pact";

const { like, integer, string, regex } = MatchersV3;

const provider = new PactV3({
  consumer: "edemand-monolith",
  provider: "payments-service",
  dir: path.resolve("pacts"),
  logLevel: "warn",
});

test("monolith talks to payments: idempotent intent write and wallet read", async () => {
  provider
    .given("booking 8001 is awaiting a gateway payment")
    .uponReceiving("an idempotent create-intent command")
    .withRequest({
      method: "POST",
      path: "/internal/payment-intents",
      headers: {
        "content-type": "application/json",
        "x-internal-key": like("test-internal-key", "test-internal-key"),
        "x-request-id": like("req-1", "req-1"),
        "idempotency-key": regex("payment-intent:\\d+", "payment-intent:8001"),
      },
      body: {
        order_id: integer(8001),
        amount_cents: integer(128400),
        gateway_ref: string("PI-8001"),
      },
    })
    .willRespondWith({
      status: 201,
      headers: { "content-type": "application/json" },
      body: {
        intent: {
          id: integer(1),
          order_id: integer(8001),
          amount_cents: integer(128400),
          gateway_ref: string("PI-8001"),
          status: string("requires_payment"),
        },
      },
    })
    .given("provider 1 has a wallet with one payout")
    .uponReceiving("a request for the provider's wallet")
    .withRequest({
      method: "GET",
      path: "/api/provider/wallet",
      headers: {
        authorization: like("Bearer test-token", "Bearer test-token"),
        "x-request-id": like("req-2", "req-2"),
      },
    })
    .willRespondWith({
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        provider_id: integer(1),
        balance_cents: integer(109140),
        commission_owed_cents: integer(19260),
        transactions: [
          {
            id: integer(1),
            order_id: integer(8001),
            kind: string("payout_credit"),
            amount_cents: integer(109140),
            method: string("gateway"),
            gateway_ref: string("PI-8001"),
            status: string("succeeded"),
            created_at: string("2026-01-01T00:00:00.000Z"),
          },
        ],
      },
    });

  await provider.executeTest(async (mockServer) => {
    process.env.PAYMENTS_SERVICE_URL = mockServer.url;
    const client = await import("../../lib/modules/payments/client.js");

    const intent = await client.ensureIntent({
      orderId: 8001,
      amountCents: 128400,
      gatewayRef: "PI-8001",
      requestId: "req-1",
    });
    assert.equal(intent.order_id, 8001);
    assert.equal(intent.status, "requires_payment");

    const wallet = await client.getWallet("test-token", "req-2");
    assert.equal(wallet.provider_id, 1);
    assert.equal(wallet.transactions[0].kind, "payout_credit");
  });
});
