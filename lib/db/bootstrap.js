// Compose preserves Booking state. Test and standalone callers can still start with fresh seed data.
import { getDb } from "./index.js";
import { migrate } from "./migrate.js";
import { seed } from "./seed.js";
import { logger } from "../logger.js";

export function bootstrapDb({ preserve = false, includeLegacyPayments = true } = {}) {
  const db = getDb();
  db.transaction(() => {
    const initialized = preserve && db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orders'"
    ).get();
    if (!initialized) {
      migrate(db, { includeLegacyPayments });
      seed(db, { includeLegacyPayments });
      logger.info("database migrated and seeded");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS booking_payment_setup (
        order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
        booking_ref TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','rejected')),
        gateway_ref TEXT UNIQUE,
        intent_json TEXT
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS booking_finance_operations (
        ref TEXT PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        path TEXT NOT NULL,
        body TEXT NOT NULL,
        next_attempt_at INTEGER NOT NULL DEFAULT 0
      )
    `);
  }).immediate();
  return db;
}
