// The notifications service owns its own PostgreSQL database. The schema is applied idempotently at
// boot (CREATE IF NOT EXISTS), so a fresh `docker compose up` is deterministic and a restart does
// not wipe notifications.
const { Pool } = require("pg");
const config = require("./config");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  -- The outbox event UUID that caused this notification. Together with the recipient/type it is
  -- the dedupe key: re-delivering the same event is a no-op, never a duplicate row.
  source_event_id TEXT,
  recipient_role TEXT NOT NULL CHECK (recipient_role IN ('customer','provider','admin')),
  recipient_id BIGINT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  order_id BIGINT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_event_id, recipient_role, recipient_id, type)
);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient
  ON notifications (recipient_role, recipient_id, id DESC);
`;

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
    pool.on("error", (err) => {
      console.error(JSON.stringify({ level: "error", service: "notifications", err: err.message }));
    });
  }
  return pool;
}

async function initDb() {
  await getPool().query(SCHEMA_SQL);
  // Migration from the first Area-A draft, which used the SQLite autoincrement id (BIGINT).
  // Idempotent: converting TEXT to TEXT is a no-op.
  await getPool().query(
    "ALTER TABLE notifications ALTER COLUMN source_event_id TYPE TEXT USING source_event_id::text"
  );
}

async function closeDb() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = { getPool, initDb, closeDb };
