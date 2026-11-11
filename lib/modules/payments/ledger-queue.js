// Durable ledger commands (Area D).
//
// Completing or cancelling a booking changes an order the monolith owns and money the payments
// service owns. The order change commits first; the ledger command is written in the SAME SQLite
// transaction into `ledger_commands`. A direct HTTP call is attempted immediately for low latency,
// but if the payments service is down — or the reply is lost after a committed write — the row stays
// pending and the background reconciler replays it with the same Idempotency-Key.
//
// This is at-least-once delivery with an idempotent receiver: the payments service stores the key
// and is UNIQUE on (order_id, kind), so repeated delivery still produces one wallet effect.
import { getDb } from "../../db/index.js";
import { logger } from "../../logger.js";
import * as payments from "./client.js";

const RECONCILER = Symbol.for("edemand.ledger.reconciler");

export function enqueueLedgerCommand(kind, payload) {
  getDb()
    .prepare(
      `INSERT INTO ledger_commands (order_id, kind, payload_json)
       VALUES (?, ?, ?)
       ON CONFLICT (order_id, kind) DO NOTHING`
    )
    .run(payload.order_id, kind, JSON.stringify(payload));
}

export function markLedgerCommandDone(orderId, kind, client = getDb()) {
  client
    .prepare(
      `UPDATE ledger_commands
       SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_error = NULL
       WHERE order_id = ? AND kind = ? AND completed_at IS NULL`
    )
    .run(orderId, kind);
}

export function recordLedgerFailure(orderId, kind, message) {
  getDb()
    .prepare(
      `UPDATE ledger_commands
       SET attempts = attempts + 1, last_error = ?
       WHERE order_id = ? AND kind = ? AND completed_at IS NULL`
    )
    .run(message ?? null, orderId, kind);
}

export function findPendingLedgerCommands(limit = 20) {
  return getDb()
    .prepare(
      `SELECT * FROM ledger_commands
       WHERE completed_at IS NULL
       ORDER BY created_at
       LIMIT ?`
    )
    .all(limit);
}

export function parseLedgerPayload(row) {
  return JSON.parse(row.payload_json);
}

export async function deliverLedgerCommand(row) {
  const payload = parseLedgerPayload(row);
  if (row.kind === "completed") return payments.applyBookingCompleted(payload);
  if (row.kind === "cancelled") return payments.applyBookingCancelled(payload);
  throw new Error(`unknown ledger command kind '${row.kind}'`);
}

// Try to deliver one command immediately. Success clears the pending row; failure records the
// reason and leaves it for the reconciler. This never throws: the order change is already durable.
export async function flushLedgerCommand(orderId, kind) {
  const row = getDb()
    .prepare("SELECT * FROM ledger_commands WHERE order_id = ? AND kind = ? AND completed_at IS NULL")
    .get(orderId, kind);
  if (!row) return false;
  try {
    await deliverLedgerCommand(row);
    markLedgerCommandDone(orderId, kind);
    return true;
  } catch (err) {
    recordLedgerFailure(orderId, kind, err.message);
    logger.warn({ err: err.message, orderId, kind }, "ledger command deferred; reconciler will retry");
    return false;
  }
}

export async function drainLedgerCommands() {
  const rows = findPendingLedgerCommands(20);
  let delivered = 0;
  for (const row of rows) {
    try {
      await deliverLedgerCommand(row);
      markLedgerCommandDone(row.order_id, row.kind);
      delivered += 1;
      logger.info({ orderId: row.order_id, kind: row.kind }, "ledger command reconciled");
    } catch (err) {
      recordLedgerFailure(row.order_id, row.kind, err.message);
      logger.warn(
        { err: err.message, orderId: row.order_id, kind: row.kind },
        "ledger reconciliation attempt failed"
      );
    }
  }
  return delivered;
}

export function startLedgerReconciler(intervalMs = 3000) {
  if (globalThis[RECONCILER]) return;
  const handle = setInterval(() => {
    drainLedgerCommands().catch((err) => {
      logger.error({ err: err.message }, "ledger reconciler pass failed");
    });
  }, intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  globalThis[RECONCILER] = handle;
  logger.info({ intervalMs }, "ledger reconciler started");
}

export function stopLedgerReconciler() {
  if (globalThis[RECONCILER]) {
    clearInterval(globalThis[RECONCILER]);
    globalThis[RECONCILER] = undefined;
  }
}
