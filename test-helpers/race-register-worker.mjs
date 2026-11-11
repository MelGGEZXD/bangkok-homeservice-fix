// Worker for the Area D registration race. It opens its OWN connection to the shared file DB,
// waits for the go signal, then calls the real identity service. The test holds a write lock while
// both workers run their advisory "email is free?" check, so both enter the insert with the email
// still absent — the exact read-then-write window the pre-check leaves open.
process.env.NODE_ENV = "test";
process.env.DB_PATH = process.env.DB_PATH || "";
process.env.LOG_LEVEL = "silent";
process.env.BCRYPT_ROUNDS = "4";

import { parentPort, workerData } from "node:worker_threads";

process.env.DB_PATH = workerData.dbPath;

const { registerCustomer } = await import("../lib/modules/identity/service.js");

parentPort.postMessage({ ready: true });
parentPort.once("message", async () => {
  try {
    const customer = await registerCustomer(workerData.input);
    parentPort.postMessage({ ok: true, id: customer.id });
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      status: err.statusCode ?? null,
      code: err.code ?? null,
      message: err.message,
    });
  }
});
