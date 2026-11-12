// Next.js boot hook. Prepare the database, then start the outbox and payment setup workers.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrapDb } = await import("./lib/db/bootstrap.js");
    const { config } = await import("./lib/config.js");
    bootstrapDb({ preserve: Boolean(config.paymentsServiceUrl), includeLegacyPayments: !config.paymentsOwnsLedger });
    // Area B: load the realm's signing keys before serving traffic, so the first authenticated
    // request can be verified locally. No-op when Keycloak is not configured (tests/dev).
    const { initKeycloak, initPaymentsWorkerIdentity } = await import("./lib/http/keycloak.js");
    await initKeycloak();
    if (config.paymentsOwnsLedger) {
      await initPaymentsWorkerIdentity();
      const { migrateLegacyPayments } = await import("./lib/modules/booking/payment-migration.js");
      await migrateLegacyPayments();
      const { startBookingFinanceWorker } = await import("./lib/modules/booking/finance.js");
      startBookingFinanceWorker();
    }
    const { startRelay } = await import("./lib/modules/notifications/relay.js");
    startRelay();
    if (config.paymentsServiceUrl) {
      const { startPaymentSetupWorker } = await import("./lib/modules/booking/payment-setup.js");
      startPaymentSetupWorker();
    }
  }
}
