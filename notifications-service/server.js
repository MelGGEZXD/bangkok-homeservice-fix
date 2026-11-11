// Entry point for the extracted Notifications service.
const { createApp } = require("./app");
const { getPool, initDb, closeDb } = require("./db");
const { initKeycloak } = require("./keycloak");
const config = require("./config");
const { startNotificationConsumer } = require("./consumer");

async function main() {
  // Area B: fail closed if Keycloak is not configured or its keys cannot be loaded.
  await initKeycloak();
  await initDb();
      const rabbitUrl = process.env.RABBITMQ_URL;
  const consumerConnection = rabbitUrl
    ? await startNotificationConsumer(rabbitUrl, getPool())
    : null;
  const app = createApp(getPool());

  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(JSON.stringify({ level: "info", service: "notifications", msg: `listening on :${config.port}` }));
  });

  const shutdown = async (signal) => {
    console.log(JSON.stringify({ level: "info", service: "notifications", msg: `${signal} received, shutting down` }));
    server.close(async () => {
      if (consumerConnection) await consumerConnection.close().catch(() => {});
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
