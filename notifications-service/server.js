// Entry point for the extracted Notifications service.
const { createApp } = require("./app");
const { getPool, initDb, closeDb } = require("./db");
const { initKeycloak } = require("./keycloak");
const { startBroker, stopBroker } = require("./broker");
const { startTelemetry } = require("./telemetry");
const config = require("./config");

async function main() {
  // Area E: register the tracer provider before serving or consuming anything.
  startTelemetry("notifications");
  // Area B: fail closed if Keycloak is not configured or its keys cannot be loaded.
  await initKeycloak();
  await initDb();
  // Area C: consume domain events from RabbitMQ. Retries while the broker is still starting; a
  // missing RABBITMQ_URL is a warning, not a crash, so the service still runs standalone.
  await startBroker();
  const app = createApp(getPool());

  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(JSON.stringify({ level: "info", service: "notifications", msg: `listening on :${config.port}` }));
  });

  const shutdown = async (signal) => {
    console.log(JSON.stringify({ level: "info", service: "notifications", msg: `${signal} received, shutting down` }));
    server.close(async () => {
      await stopBroker();
      await closeDb();
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", service: "notifications", err: err.stack || err.message }));
  process.exit(1);
});
