// Next.js boot hook. Runs once when the server process starts (dev and production alike). This is
// where the monolith gets its deterministic behaviour: a fresh, migrated, seeded database on every
// boot, and the outbox relay draining domain events in the background.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Area E: register the tracer provider before the first request can create a span.
    const { startTelemetry } = await import("./lib/telemetry.js");
    startTelemetry("edemand");

    const { bootstrapDb } = await import("./lib/db/bootstrap.js");
    bootstrapDb();
    // Area B: load the realm's signing keys before serving traffic, so the first authenticated
    // request can be verified locally. No-op when Keycloak is not configured (tests/dev).
    const { initKeycloak } = await import("./lib/http/keycloak.js");
    await initKeycloak();
    const { startRelay } = await import("./lib/modules/notifications/relay.js");
    startRelay();
    // Area C: the monolith orchestrates provider approval, so it also consumes the outcome events
    // (notification.created / notification.failed) from its own durable RabbitMQ queue.
    const { startSagaConsumer } = await import("./lib/modules/sagas/consumer.js");
    await startSagaConsumer();
    // Area D: retry ledger commands the payments service did not acknowledge, with backoff.
    const { startLedgerReconciler } = await import("./lib/modules/payments/ledger-queue.js");
    startLedgerReconciler();
  }
}
