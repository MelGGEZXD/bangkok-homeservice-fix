// The whole schema as a single embedded SQL string (not a .sql file read via fs) so Next's
// `output: "standalone"` build traces it without extra file-tracing config. Applied on every boot
// with DROP TABLE IF EXISTS first, which is what keeps a fresh `docker compose up` deterministic.
//
// Build order matters: orders.job_request_id forward-references job_requests(id), so job_requests
// is created before orders. DROP runs in the reverse of CREATE (children before parents) so
// foreign_keys=ON never blocks a drop.
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS sagas;
DROP TABLE IF EXISTS events;
-- Area A cleanup: the notifications table moved to the notifications service's own Postgres DB.
-- Dropping it here (without recreating it below) removes the legacy table from an existing SQLite
-- file on the next boot, so the monolith physically cannot read or write it any more.
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS reviews;
-- Area A cleanup (second extraction): Payments & Wallet moved to its own service + PostgreSQL DB.
-- Dropping without recreating removes the legacy tables from an existing SQLite file on next boot,
-- so the monolith physically cannot read or write money rows any more.
DROP TABLE IF EXISTS webhook_events;
DROP TABLE IF EXISTS provider_wallets;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS payment_intents;
DROP TABLE IF EXISTS bids;
DROP TABLE IF EXISTS slot_holds;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS job_requests;
DROP TABLE IF EXISTS addresses;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS provider_timings;
DROP TABLE IF EXISTS provider_profiles;
DROP TABLE IF EXISTS admins;
DROP TABLE IF EXISTS providers;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS categories;

-- ========== Catalog (categories referenced by services + job_requests) ==========
CREATE TABLE categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  status INTEGER NOT NULL DEFAULT 1 CHECK (status IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ========== Identity ==========
CREATE TABLE customers (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  name TEXT NOT NULL, phone TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE providers (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  name TEXT NOT NULL, phone TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE admins (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ========== Provider Profile ==========
CREATE TABLE provider_profiles (
  provider_id INTEGER PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  company_name TEXT, about TEXT NOT NULL DEFAULT '',
  is_approved INTEGER NOT NULL DEFAULT 0 CHECK (is_approved IN (0,1)),
  commission_pct REAL NOT NULL DEFAULT 15.0,
  service_radius_km REAL NOT NULL DEFAULT 10.0,
  is_accepting_custom_jobs INTEGER NOT NULL DEFAULT 1 CHECK (is_accepting_custom_jobs IN (0,1)),
  rating_avg REAL NOT NULL DEFAULT 0, rating_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE provider_timings (
  id INTEGER PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opening_time TEXT NOT NULL,
  closing_time TEXT NOT NULL,
  is_open INTEGER NOT NULL DEFAULT 1 CHECK (is_open IN (0,1)),
  UNIQUE (provider_id, weekday)
);

-- ========== Catalog (services) ==========
CREATE TABLE services (
  id INTEGER PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  title TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  duration_min INTEGER NOT NULL CHECK (duration_min > 0 AND duration_min % 30 = 0),
  tax_percent REAL NOT NULL DEFAULT 7.0,
  status INTEGER NOT NULL DEFAULT 1 CHECK (status IN (0,1)),
  rating_avg REAL NOT NULL DEFAULT 0, rating_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_services_category ON services(category_id);
CREATE INDEX idx_services_provider ON services(provider_id);

-- ========== Booking ==========
CREATE TABLE addresses (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label TEXT NOT NULL, line1 TEXT NOT NULL, area TEXT, city TEXT NOT NULL,
  lat REAL, lng REAL, is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_addresses_customer ON addresses(customer_id);

-- ========== Bidding (job_requests before orders — orders forward-references it) ==========
CREATE TABLE job_requests (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  min_price_cents INTEGER NOT NULL, max_price_cents INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','booked','cancelled','expired')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_job_requests_status ON job_requests(status);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  address_id INTEGER REFERENCES addresses(id),
  service_date TEXT NOT NULL,
  starting_time TEXT NOT NULL,
  ending_time TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  commission_pct REAL NOT NULL,
  commission_cents INTEGER,
  provider_earnings_cents INTEGER,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cod','gateway')),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','refunded')),
  status TEXT NOT NULL DEFAULT 'awaiting'
        CHECK (status IN ('awaiting','confirmed','started','completed','cancelled','rescheduled')),
  otp INTEGER NOT NULL,
  job_request_id INTEGER REFERENCES job_requests(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_provider ON orders(provider_id);
CREATE INDEX idx_orders_status ON orders(status);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id),
  service_title TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL, tax_percent REAL NOT NULL,
  tax_cents INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK (quantity > 0),
  subtotal_cents INTEGER NOT NULL
);
CREATE INDEX idx_order_items_order ON order_items(order_id);

-- THE slot guard: one row per 30-min slot a booking occupies. UNIQUE makes a double-book
-- physically impossible at the storage layer.
CREATE TABLE slot_holds (
  id INTEGER PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  service_date TEXT NOT NULL,
  slot_time TEXT NOT NULL,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (provider_id, service_date, slot_time)
);
CREATE INDEX idx_slot_holds_lookup ON slot_holds(provider_id, service_date);

CREATE TABLE bids (
  id INTEGER PRIMARY KEY,
  job_request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  counter_price_cents INTEGER NOT NULL, note TEXT, duration_min INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','accepted','rejected','withdrawn')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (job_request_id, provider_id)
);
CREATE INDEX idx_bids_job ON bids(job_request_id);

-- ========== Payments & Wallet ==========
-- Intentionally absent: payment_intents, transactions, provider_wallets and webhook_events live in
-- the payments service's PostgreSQL database after the second Area A extraction. The DROP block at
-- the top removes any legacy copies; adding a CREATE here again would break the ownership proof.

-- ========== Reviews ==========
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  provider_id INTEGER NOT NULL REFERENCES providers(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_reviews_service ON reviews(service_id);

-- ========== Notifications (EXTRACTED) ==========
-- The notifications table is no longer part of the monolith schema. It lives in the notifications
-- service's own PostgreSQL database (notifications-service/db.js). Keeping it out of this file is
-- deliberate: the monolith physically cannot read or write the moved table.

-- ========== Shared infra ==========
-- Outbox: domain events written in the SAME tx as the state change; drained by the relay.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  -- Stable identity across reseeds/retries. The notifications service dedupes on this UUID, not on
  -- the SQLite autoincrement id (which restarts at 1 after a fresh boot).
  event_uid TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
);
CREATE INDEX idx_events_unprocessed ON events(processed_at) WHERE processed_at IS NULL;

-- ========== Sagas (Area C) ==========
-- One row per cross-service workflow. The orchestrator (the monolith) records every step and its
-- compensating action here, so a notification failure can revert the approval instead of leaving a
-- half-finished onboarding. State transitions are conditional UPDATEs, which makes a duplicate
-- notification.created / notification.failed message a no-op.
CREATE TABLE sagas (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('awaiting_notification','completed','compensated','failed')),
  aggregate_type TEXT NOT NULL,
  aggregate_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sagas_aggregate ON sagas(aggregate_type, aggregate_id);
CREATE INDEX idx_sagas_state ON sagas(state);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY, endpoint TEXT NOT NULL,
  response_json TEXT NOT NULL, status_code INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;
