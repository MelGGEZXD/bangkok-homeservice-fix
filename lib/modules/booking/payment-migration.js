import { randomUUID } from "node:crypto";
import { getDb } from "../../db/index.js";
import { logger } from "../../logger.js";
import { callPayments } from "../payments/client.js";

// Keep the old ledger until PostgreSQL acknowledges a committed, retryable import.
export async function migrateLegacyPayments() {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transactions'").get()) return;

  const snapshot = db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS payment_migration (ref TEXT PRIMARY KEY)");
    let ref = db.prepare("SELECT ref FROM payment_migration").get()?.ref;
    if (!ref) {
      ref = randomUUID();
      db.prepare("INSERT INTO payment_migration VALUES (?)").run(ref);
    }

    const addSetup = db.prepare(`INSERT INTO booking_payment_setup
      (order_id, booking_ref, state, gateway_ref, intent_json) VALUES (?, ?, 'ready', ?, ?)`);
    const olderIntents = db.prepare(`SELECT i.* FROM payment_intents i
      WHERE NOT EXISTS (SELECT 1 FROM booking_payment_setup s WHERE s.order_id = i.order_id)`).all();
    for (const intent of olderIntents) {
      addSetup.run(intent.order_id, randomUUID(), intent.gateway_ref, JSON.stringify(intent));
    }

    return {
      migration_ref: ref,
      intents: db.prepare(`SELECT s.booking_ref, s.gateway_ref, o.id AS order_id, o.customer_id,
        o.provider_id, o.total_cents AS amount_cents, CASE
          WHEN o.payment_status = 'refunded' THEN 'refunded'
          WHEN o.payment_status = 'paid' THEN 'succeeded'
          WHEN o.status = 'cancelled' THEN 'cancelled'
          ELSE 'requires_payment' END AS status
        FROM booking_payment_setup s JOIN orders o ON o.id = s.order_id WHERE s.state = 'ready'`).all(),
      transactions: db.prepare("SELECT * FROM transactions ORDER BY id").all(),
      wallets: db.prepare("SELECT * FROM provider_wallets").all(),
      events: db.prepare("SELECT gateway_event_id, type, json_extract(payload_json, '$.gateway_ref') AS gateway_ref FROM webhook_events").all(),
    };
  }).immediate();

  const result = await callPayments("/internal/legacy-import", { body: snapshot, timeout: 30_000 });
  if (result.migration_ref !== snapshot.migration_ref) throw new Error("Payments did not acknowledge the ledger import");
  db.transaction(() => db.exec(`
    DROP TABLE payment_intents;
    DROP TABLE transactions;
    DROP TABLE provider_wallets;
    DROP TABLE webhook_events;
    DROP TABLE payment_migration;
  `)).immediate();
  logger.info({ intents: snapshot.intents.length, transactions: snapshot.transactions.length }, "legacy ledger moved to Payments");
}
