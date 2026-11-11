// The Payments & Wallet service owns its own PostgreSQL database. The schema is applied
// idempotently at boot (CREATE IF NOT EXISTS), so a fresh `docker compose up` is deterministic and a
// restart does not wipe money history.
//
// The two unique keys are the exactly-once proofs:
//   - payment_intents.order_id UNIQUE  -> one intent per booking, even if the monolith retries.
//   - transactions(order_id, kind)     -> one charge / payout_credit / commission_owed / refund per
//                                         booking, even if a webhook or a saga step is redelivered.
const { Pool } = require("pg");
const config = require("./config");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS payment_intents (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL UNIQUE,
  amount_cents BIGINT NOT NULL,
  gateway_ref TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'requires_payment'
         CHECK (status IN ('requires_payment','succeeded','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT,
  customer_id BIGINT,
  provider_id BIGINT,
  kind TEXT NOT NULL CHECK (kind IN ('charge','payout_credit','commission_owed','refund')),
  amount_cents BIGINT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cod','gateway')),
  gateway_ref TEXT,
  status TEXT NOT NULL DEFAULT 'succeeded' CHECK (status IN ('pending','succeeded','failed','refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_transactions_provider ON transactions (provider_id);
CREATE INDEX IF NOT EXISTS idx_transactions_customer ON transactions (customer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_order ON transactions (order_id);

CREATE TABLE IF NOT EXISTS provider_wallets (
  provider_id BIGINT PRIMARY KEY,
  balance_cents BIGINT NOT NULL DEFAULT 0,
  commission_owed_cents BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Webhook idempotency: the gateway's event id is the dedupe key. UNIQUE = a replay cannot
-- double-credit even if two deliveries race.
CREATE TABLE IF NOT EXISTS webhook_events (
  id BIGSERIAL PRIMARY KEY,
  gateway_event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- Area D: transport-level idempotency. The monolith sends one key per logical write and reuses it
-- on every retry (and on a later reconciliation replay). The stored response is returned verbatim,
-- so a retried request is observed once. The domain UNIQUE keys remain the last line of defence.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
    pool.on("error", (err) => {
      console.error(JSON.stringify({ level: "error", service: "payments", err: err.message }));
    });
  }
  return pool;
}

async function initDb() {
  await getPool().query(SCHEMA_SQL);
}

// ---- wallets -------------------------------------------------------------------------------
// A wallet row is created on provider registration, but every credit also upserts, so a provider
// that predates the extraction (or a lost wallet row) still ends up with a correct balance.
async function createWallet(providerId, client = getPool()) {
  await client.query(
    "INSERT INTO provider_wallets (provider_id, balance_cents, commission_owed_cents) VALUES ($1, 0, 0) ON CONFLICT (provider_id) DO NOTHING",
    [providerId]
  );
}

async function deleteWallet(providerId, client = getPool()) {
  await client.query("DELETE FROM provider_wallets WHERE provider_id = $1", [providerId]);
}

async function findWallet(providerId, client = getPool()) {
  const { rows } = await client.query("SELECT * FROM provider_wallets WHERE provider_id = $1", [providerId]);
  return rows[0] || null;
}

async function applyWalletDelta(providerId, { balanceDelta = 0, commissionDelta = 0 }, client) {
  await client.query(
    `INSERT INTO provider_wallets (provider_id, balance_cents, commission_owed_cents)
     VALUES ($1, $2, $3)
     ON CONFLICT (provider_id) DO UPDATE
       SET balance_cents = provider_wallets.balance_cents + EXCLUDED.balance_cents,
           commission_owed_cents = provider_wallets.commission_owed_cents + EXCLUDED.commission_owed_cents,
           updated_at = now()`,
    [providerId, balanceDelta, commissionDelta]
  );
}

// ---- payment intents -----------------------------------------------------------------------
async function ensureIntent({ orderId, amountCents, gatewayRef }, client = getPool()) {
  await client.query(
    `INSERT INTO payment_intents (order_id, amount_cents, gateway_ref)
     VALUES ($1, $2, $3)
     ON CONFLICT (order_id) DO NOTHING`,
    [orderId, amountCents, gatewayRef]
  );
  return findIntentByOrder(orderId, client);
}

async function findIntentByOrder(orderId, client = getPool()) {
  const { rows } = await client.query("SELECT * FROM payment_intents WHERE order_id = $1", [orderId]);
  return rows[0] || null;
}

async function findIntentByGatewayRef(gatewayRef, client = getPool()) {
  const { rows } = await client.query("SELECT * FROM payment_intents WHERE gateway_ref = $1", [gatewayRef]);
  return rows[0] || null;
}

async function markIntentSucceeded(intentId, client = getPool()) {
  const { rowCount } = await client.query(
    "UPDATE payment_intents SET status = 'succeeded' WHERE id = $1 AND status = 'requires_payment'",
    [intentId]
  );
  return rowCount;
}

// ---- ledger --------------------------------------------------------------------------------
// Returns true only when this call inserted the row. A duplicate delivery returns false and the
// caller skips the wallet delta, so the replay has no second effect.
async function insertLedgerEntry(t, client = getPool()) {
  const { rowCount } = await client.query(
    `INSERT INTO transactions (order_id, customer_id, provider_id, kind, amount_cents, method, gateway_ref, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (order_id, kind) DO NOTHING`,
    [
      t.orderId ?? null,
      t.customerId ?? null,
      t.providerId ?? null,
      t.kind,
      t.amountCents,
      t.method,
      t.gatewayRef ?? null,
      t.status ?? "succeeded",
    ]
  );
  return rowCount > 0;
}

async function listTransactionsForProvider(providerId) {
  const { rows } = await getPool().query(
    "SELECT * FROM transactions WHERE provider_id = $1 ORDER BY id DESC",
    [providerId]
  );
  return rows;
}

async function listTransactionsForCustomer(customerId) {
  const { rows } = await getPool().query(
    "SELECT * FROM transactions WHERE customer_id = $1 ORDER BY id DESC",
    [customerId]
  );
  return rows;
}

// ---- webhook dedupe ------------------------------------------------------------------------
async function recordWebhookEvent(gatewayEventId, type, payload, client = getPool()) {
  const { rowCount } = await client.query(
    `INSERT INTO webhook_events (gateway_event_id, type, payload_json)
     VALUES ($1, $2, $3)
     ON CONFLICT (gateway_event_id) DO NOTHING`,
    [gatewayEventId, type, JSON.stringify(payload)]
  );
  return rowCount > 0;
}

async function markWebhookProcessed(gatewayEventId, client = getPool()) {
  await client.query(
    "UPDATE webhook_events SET processed_at = now() WHERE gateway_event_id = $1 AND processed_at IS NULL",
    [gatewayEventId]
  );
}

// ---- transport idempotency ------------------------------------------------------------------
async function findIdempotencyKey(key, client = getPool()) {
  const { rows } = await client.query(
    "SELECT key, endpoint, status_code, response_json FROM idempotency_keys WHERE key = $1",
    [key]
  );
  return rows[0] || null;
}

async function saveIdempotencyKey(key, endpoint, statusCode, body, client = getPool()) {
  await client.query(
    `INSERT INTO idempotency_keys (key, endpoint, status_code, response_json)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO NOTHING`,
    [key, endpoint, statusCode, JSON.stringify(body)]
  );
}

async function closeDb() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = {
  getPool,
  initDb,
  closeDb,
  createWallet,
  deleteWallet,
  findWallet,
  applyWalletDelta,
  ensureIntent,
  findIntentByOrder,
  findIntentByGatewayRef,
  markIntentSucceeded,
  insertLedgerEntry,
  listTransactionsForProvider,
  listTransactionsForCustomer,
  recordWebhookEvent,
  markWebhookProcessed,
  findIdempotencyKey,
  saveIdempotencyKey,
};
