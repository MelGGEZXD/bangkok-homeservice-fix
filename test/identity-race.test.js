// Area D: the unsafe race the inherited identity path left open.
//
// Registering a customer is a read-then-write: `findCustomerByEmail` (advisory) followed by an
// INSERT. Two requests that arrive together can both read "no such email", then both insert. The
// UNIQUE(email) index still stops the second row, but without translation that surface is a raw
// SQLite constraint and the HTTP layer returns 500. The fix is to let the unique index be the
// arbiter and map its violation to the same 409 the sequential path already returns.
//
// This test proves it with real concurrency: two worker threads open separate connections to one
// file-backed SQLite database. The main thread holds BEGIN IMMEDIATE while both workers run the
// advisory check, so they both reach the INSERT before either can commit. Then the lock is
// released and exactly one registration must win.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Worker } from "node:worker_threads";

const dbPath = path.join(os.tmpdir(), `edemand-register-race-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = "test";
process.env.DB_PATH = dbPath;
process.env.LOG_LEVEL = "silent";
process.env.BCRYPT_ROUNDS = "4";

const { freshBoot, getDb, closeDb } = await import("../test-helpers/boot.js");

function runWorker(email) {
  const worker = new Worker(new URL("../test-helpers/race-register-worker.mjs", import.meta.url), {
    workerData: {
      dbPath,
      input: { email, password: "RacePass123!", name: "Race Tester" },
    },
  });
  const ready = new Promise((resolve, reject) => {
    worker.once("message", (msg) => (msg.ready ? resolve() : reject(new Error("worker did not become ready"))));
    worker.once("error", reject);
  });
  const result = new Promise((resolve, reject) => {
    worker.on("message", (msg) => {
      if (msg.ready) return;
      resolve(msg);
    });
    worker.once("error", reject);
  });
  return { worker, ready, result };
}

test("concurrent registrations for one email: exactly one 201, one 409", async () => {
  freshBoot();
  const email = `race-${Date.now()}@example.com`;

  // A separate connection holds the write lock. WAL lets both workers read, but neither can insert
  // until this commits — so both advisory checks see the email as free.
  const locker = new Database(dbPath);
  locker.pragma("journal_mode = WAL");
  locker.pragma("busy_timeout = 5000");
  locker.exec("BEGIN IMMEDIATE");

  const a = runWorker(email);
  const b = runWorker(email);
  await Promise.all([a.ready, b.ready]);

  a.worker.postMessage("go");
  b.worker.postMessage("go");
  // Give both workers time to hash the password, pass the advisory check and block on the write
  // lock. The lock is the barrier; the sleep only makes the window observable.
  await new Promise((resolve) => setTimeout(resolve, 400));
  locker.exec("COMMIT");

  const results = await Promise.all([a.result, b.result]);
  await Promise.all([a.worker.terminate(), b.worker.terminate()]);
  locker.close();

  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok);
  assert.equal(winners.length, 1, `expected exactly one winner, got ${JSON.stringify(results)}`);
  assert.equal(losers.length, 1, "expected exactly one loser");
  assert.equal(losers[0].status, 409, `loser must be a clean 409, got ${JSON.stringify(losers[0])}`);

  const rows = getDb().prepare("SELECT COUNT(*) AS n FROM customers WHERE email = ?").get(email).n;
  assert.equal(rows, 1, "the unique index and the translated error leave exactly one customer row");

  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // best effort; the OS cleans the temp directory anyway
    }
  }
});
