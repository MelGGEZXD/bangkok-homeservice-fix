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

// One idempotent write used by BOTH ingest paths (the internal HTTP command endpoint and the Area C
// RabbitMQ consumer). The unique key is the whole exactly-once proof: re-delivering the same event
// returns `{duplicate: true, notification: null}` and writes no second row.
async function insertNotification(notification) {
  const { rows } = await getPool().query(
    `INSERT INTO notifications
       (source_event_id, recipient_role, recipient_id, type, title, body, order_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source_event_id, recipient_role, recipient_id, type) DO NOTHING
     RETURNING *`,
    [
      notification.source_event_id,
      notification.recipient_role,
      notification.recipient_id,
      notification.type,
      notification.title,
      notification.body,
      notification.order_id ?? null,
    ]
  );
  return rows.length === 0
    ? { duplicate: true, notification: null }
    : { duplicate: false, notification: rows[0] };
}

async function closeDb() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = { getPool, initDb, insertNotification, closeDb };
