# Bangkok Homeservice — a home-services marketplace monolith

> Formerly **eDemand**. Only the course-facing name changed: inside the code the service, the
> database file, the seed logins and the password below still say `edemand` / `eDemand`.

A production-grade, **self-contained full-stack Next.js monolith** for the DES428 course
(*Web Services and Service Architecture*). One process, one SQLite file, UI + API together. It is
the sibling of `bangkok-ride`: same production bar (typed errors, zod validation, JWT auth, pino
logging, idempotency, atomic conditional writes, real transactions, an outbox, deterministic
reseed, `node:test` rigor) — but a **multi-vendor on-demand services marketplace** (cleaning,
repair, beauty, appliance) instead of ride-hailing.

Students run this as a monolith, feel where it strains, and use it as the system they migrate
toward microservices. The bounded-context boundaries below **are** the future service seams.

---

## What it is

- **The monolith is one deployable.** Next.js 14 App Router. UI pages are Server Components that
  call the service layer **directly, in-process** (the honest monolith read path). Mutations POST to
  **route handlers** under `app/api/**`. Notifications and Payments & Wallet have their own
  services and PostgreSQL databases. Booking uses the Payments API for financial operations.
- **The monolith owns one database.** `better-sqlite3`, one file `data/edemand.db` (`:memory:`
  under test). WAL, `foreign_keys=ON`. Compose keeps the file across ordinary restarts and seeds
  an empty database. `sqlite_sequence` for `orders` is primed to 8000, so the
  **first booking on a fresh database is id 8001**. The extracted notifications service owns a
  **separate PostgreSQL database**; the monolith has no `notifications` table at all.
- **Layered.** `route handler → service → repository → db`. No SQL outside repositories; no business
  logic in route files. Every route is zod-validated, typed-error-mapped, JWT+role-gated where
  required, and request-id + pino logged.

### Run it

The public entry point is the **nginx gateway on `:3000`**, and it
keeps the addresses the app already had. Keycloak is the only token issuer; it is an identity
dependency, not part of the domain API surface.

| Public URL | Routed to |
|---|---|
| `http://localhost:3000/api/notifications*` | Notifications service (`:3001`, own PostgreSQL DB) |
| `http://localhost:3000/api/provider/wallet` and `/api/customer/transactions` | Payments service (`:3002`, own PostgreSQL DB) |
| `http://localhost:3000/*` | Next.js monolith (`:3000`, internal only — no published port) |
| `http://localhost:8081` | Keycloak (realm `edemand`; admin console for the demo) |

```bash
# Full stack: monolith, Notifications and Payments with PostgreSQL, Keycloak, RabbitMQ and nginx
docker compose up -d --build --wait      # http://localhost:3000
docker compose run --rm --build test     # in-memory suite; no running stack needed
docker compose down -v                   # reset all project data volumes, including bookings and payments

# App-only local dev (monolith on :3000). The notifications API/UI returns 502 until the extracted
# service is running; `docker compose up -d notifications notifications-db` gives you one on :3001.
npm install
npm run dev
# or: npm run build && npm start

# Notifications service by itself (needs a PostgreSQL DATABASE_URL and KEYCLOAK_URL)
cd notifications-service && npm install && DATABASE_URL=postgres://... KEYCLOAK_URL=... npm start
```

### Payments & Wallet and the booking saga

Online booking now commits the booking and slot holds in SQLite before asking the private
Payments service to create one intent in its own PostgreSQL database. Cash bookings still
skip intent creation. A definitive rejection cancels the booking and releases its slots.
An unknown outcome returns `202` with `payment_setup: "pending"`. The Booking worker keeps
trying with the original booking reference, so a committed intent with a lost response is
reused. The customer can open the booking detail page and pay once setup succeeds.

The Compose stack keeps Booking data in `edemand-data` across restarts and seeds a fresh
database once. It also preserves Keycloak's data so registered accounts stay paired with the
local Booking database. An earlier Compose stack did not use these volumes, so the new volumes
start with demo data. Run `docker compose run --rm --build --no-deps test node --test test/payment-setup-saga.test.js`
to exercise success, rejection and rebooking, and a committed intent with a lost reply.

Booking orchestrates the saga because it owns the booking lifecycle and can release its slot holds
in one local transaction. Payments owns intent status, charge and refund records, webhook dedupe,
and wallet balances. Booking owns its `orders.payment_status` projection. The existing callback
and Pay Now routes forward settlement to Payments and apply the returned outcome in Booking.

Booking durably records settlement, cancellation, and Wallet delivery work before sending it.
Payments uses stable references and a local PostgreSQL transaction to apply each financial effect
once. An online booking must be paid before completion can credit the provider. Cash bookings
post commission owed at completion. A fresh provider's Wallet reads as zero until its first credit.

Payments independently verifies Keycloak access tokens. Wallet and transaction history are scoped
to the requesting user's role and ID, and internal writes require the Booking service account.
On the first upgrade of a persisted SQLite volume, Booking imports the old ledger into PostgreSQL
and removes the old finance tables only after the import commits. Standalone development and the
in-memory test suite can run with their local ledger.

For an isolated Docker demo, set `PAYMENTS_DEMO_REJECT_INTENTS=true` to reject new intents
before writing, or `PAYMENTS_DEMO_DELAY_FIRST_REPLY=true` to delay the first reply until
after Booking's default timeout, after the intent has committed. Recreate only `payments`
with `docker compose up -d --wait --no-deps payments` when changing these settings.
Both settings default to false.

With an isolated Compose stack running on port 3000, run
`pwsh -File ./scripts/verify-payments.ps1 -ComposeProject <project>` to exercise the public URLs,
webhook replay, Wallet, refunds, and ownership of the four finance tables. Use a new `-DaysAhead`
value on subsequent runs so the test bookings use free slots.

Secrets are environment variables. The compose defaults are **demo-only**; override
`KEYCLOAK_ADMIN_PASSWORD`, `INTERNAL_API_KEY`, and `PAYMENTS_CLIENT_SECRET` (see `.env.example`). `JWT_SECRET` remains only for
the isolated `node:test` suite, which runs without Keycloak; production tokens are always RS256
tokens signed by Keycloak and verified through its JWKS.

> **Node version for local tests:** use **Node 20** (`.nvmrc`). `better-sqlite3@11.10.0` ships no
> prebuilt binary for Node 24, and building it from source needs Visual Studio C++ tools on Windows.
> `docker compose run --rm test` always uses the Node 20 image and is the safest way to run the suite.

**Seed logins** (password for all: `eDemand-2026!`):
`nong@example.com` / `somchai@example.com` / `aom@example.com` (customers),
`sparkle@example.com` / `fixit@example.com` (approved providers), `glow@example.com` (pending),
`admin@edemand.test` (admin). The same accounts are imported into the Keycloak realm, so the login
endpoints and `http://localhost:8081` both accept them. Keycloak admin console: `admin` / `admin`
(demo only).

---

## The eight bounded contexts

Each context **owns its tables** — that ownership is the seam. Nothing reads another context's
tables through its own repository; it goes through the owning context's service/repository.

| # | Context | Owns (tables) | Responsibility |
|---|---------|---------------|----------------|
| 1 | **Identity** | `customers`, `providers`, `admins` | Registration, login (bcrypt), JWT issuance, `/me`. |
| 2 | **Catalog** | `categories`, `services` | Provider-owned services, browse/search, rating aggregate (recomputed by the relay). |
| 3 | **Provider Profile** | `provider_profiles`, `provider_timings` | Approval, commission, 30-min weekly availability. |
| 4 | **Booking** | `orders`, `order_items`, `slot_holds`, `addresses` | The place-booking transaction, the status machine, OTP-gated completion, slots. |
| 5 | **Bidding** | `job_requests`, `bids` | Custom jobs + provider bids; the bid-accept race that spins up a booking. |
| 6 | **Payments & Wallet** | `payment_intents`, `transactions`, `provider_wallets`, `webhook_events` in its **own PostgreSQL DB** (extracted) | Gateway intents, the idempotent webhook, refunds, and the commission split. |
| 7 | **Reviews** | `reviews` | One review per completed booking; emits `review.created`. |
| 8 | **Notifications** | `notifications` in its **own PostgreSQL DB** (extracted) | Read side + ownership check in the service. The monolith's outbox relay still drains `events` and delivers commands across the boundary. |

Shared infra (under `lib/db`, not a context): `events` (the outbox) and `idempotency_keys`.

Directory shape:

```
app/                 UI pages ((customer) (provider) (admin) groups) + api/** route handlers
lib/
  config.js logger.js errors.js
  http/              handle, respond, auth, validate, pagination, requestId, session
  db/                index, schema, migrate, seed, bootstrap, idempotency, events
  modules/<context>/ repository.js + service.js  (+ booking/slots.js, booking/availability.js,
                                                   payments/gateway.js, notifications/relay.js,
                                                   notifications/client.js)
notifications-service/  extracted Express service: server.js, app.js, db.js (PostgreSQL), auth.js
payments-service/       extracted FastAPI service: app.py, auth.py, ledger.py (PostgreSQL)
gateway/nginx.conf      routes Notifications, Wallet and transaction history to their owning services
test/ test-helpers/     node:test suite driving the real route handlers in-process
```

### Area A — Notifications extracted (working-alone scope)

| The four boundary questions | Answer |
|---|---|
| **Name** | Notifications |
| **What crosses** | *Inbound:* the monolith's relay `POST /internal/notifications` (shared `X-Internal-Key`, one command per outbox event). *Outbound:* the browser/API `GET /api/notifications` and `POST /api/notifications/:id/read`, carrying the caller's JWT. |
| **Ownership** | The service owns `notifications` in its **own PostgreSQL database**. The monolith schema drops the legacy SQLite table and no longer has a notifications repository. |
| **Decision** | Extract the lowest-risk context first: it is asynchronous, has one small table, and nothing calls it synchronously on a request's hot path. |

**Why this seam, not Providers/Booking?** The assignment table names Providers and Booking, but this
repository's own seam analysis ranks Notifications first: it owns one table and has no synchronous
hot-path caller. Booking and Bidding share the `slot_holds` UNIQUE guard, so splitting them first
turns a free single-DB invariant into distributed reservation. The dossier should state this
tradeoff explicitly if the marker expects the table's suggestion.

What makes the cut real rather than a stub:

- **Same public addresses.** nginx publishes `:3000` and routes `/api/notifications*` to the service;
  the monolith keeps no host port. The UI page `/notifications` still lives at the same URL and
  fetches the service with the browser's httpOnly JWT.
- **Idempotent delivery.** Every notification command carries `source_event_id`. The service has a
  unique key on `(source_event_id, recipient_role, recipient_id, type)` and inserts with
  `ON CONFLICT DO NOTHING`. The relay releases a failed event claim and retries — at-least-once
  delivery, exactly-one effect.
- **The service checks the token itself.** `notifications-service/auth.js` verifies the Keycloak
  RS256 token against the realm JWKS and derives the recipient from it, never from a query string.
  Mark-read also checks ownership (`403 not your notification`). See Area B below.
- **Approval is still atomic.** `approveProvider` writes a `provider.approved` outbox event in the
  same SQLite transaction as the flag flip; the relay delivers the notification afterwards. The
  monolith never writes the moved table.

Proof from the running stack (`jq` for token extraction):

```bash
docker compose up -d --build --wait

# 1. The gateway routes /api/notifications to the extracted service. This 401 body has no
#    monolith-style requestId, which is one quick way to see which process answered.
curl -i http://localhost:3000/api/notifications

# 2. Log in as admin and approve the seeded pending provider Glow (id 3).
ADMIN=$(curl -s -X POST http://localhost:3000/api/auth/admin/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@edemand.test","password":"eDemand-2026!"}' | jq -r .token)
curl -s -X POST http://localhost:3000/api/admin/providers/3/approve \
  -H "authorization: Bearer $ADMIN"

# 3. Wait one relay tick, then read Glow's inbox through the same public address.
sleep 2
GLOW=$(curl -s -X POST http://localhost:3000/api/auth/provider/login \
  -H 'content-type: application/json' \
  -d '{"email":"glow@example.com","password":"eDemand-2026!"}' | jq -r .token)
curl -s -H "authorization: Bearer $GLOW" http://localhost:3000/api/notifications
```

Expected: one `provider_approved` notification, served from PostgreSQL by the extracted service.
The monolith's SQLite file has no `notifications` table.

### Area B — Keycloak tokens, ownership, and the BOLA fix

| Question | Answer |
|---|---|
| **Who issues tokens?** | Keycloak 26.0, realm `edemand`, imported from `keycloak/realm-edemand.json` on every clean boot. The monolith never signs a production token. |
| **What is in the token?** | RS256 access token with `iss=http://localhost:8081/realms/edemand`, `aud` containing `edemand-api`, and two custom claims mapped from Keycloak user attributes: `local_id` (the monolith's numeric user id) and `role` (`customer` / `provider` / `admin`). |
| **Who verifies it?** | Both services, independently. The monolith (`lib/http/keycloak.js`) and the notifications service (`notifications-service/keycloak.js`) fetch the realm JWKS at boot with retries, cache keys by `kid`, and verify signature + issuer + audience + expiry locally. There is no shared signing secret. |
| **What about ownership?** | The notifications service derives the recipient from the verified token (`local_id`, `role`) and never from a path/query parameter. Mark-read checks `recipient_id`/`recipient_role` and returns 403 for anyone else. |

**Clients in the realm** (all public, password grant enabled, so the demo can request real tokens):

| Client | Purpose |
|---|---|
| `edemand-web` | The normal client. Adds the `edemand-api` audience and the `local_id` / `role` claims. |
| `edemand-short` | Same claims, but a **5-second** access-token lifespan, so the demo can show a genuine Keycloak token that has expired. |
| `edemand-other` | A valid client whose tokens deliberately **omit** the `edemand-api` audience. |
| `edemand-api` | Bearer-only audience/resource identifier. |

**Login and registration.** `POST /api/auth/{customer,provider,admin}/login` still takes
`{email, password}` and still returns `{token}` plus the httpOnly `edemand_token` cookie, but the
monolith now forwards the credentials to Keycloak (password grant on `edemand-web`) and returns
Keycloak's access token. Registration inserts the local row and provisions the matching Keycloak
user through the Admin API with `local_id`, `role`, first/last name, and the password; if
provisioning fails, a compensating delete removes the local row (or the orphaned Keycloak user).
`JWT_SECRET` is used only by the isolated `node:test` suite, which has no Keycloak.

**Three negative cases — 401 at both boundaries.** Because verification happens twice, each attack
is rejected by the monolith and again by the extracted service when the gateway forwards directly to
it:

| Token | Why it is rejected |
|---|---|
| Forged | Signature does not match any realm key → 401 |
| Expired | `exp` is in the past (the 5-second `edemand-short` token) → 401 |
| Wrong audience | Validly signed by Keycloak, but `aud` does not include `edemand-api` → 401 |

**The inherited object-level authorization flaw and its fix.** `GET /api/jobs/{id}` accepted any
authenticated caller and returned any job. The policy is now: the owning customer always; an admin
always; a provider while the job is `open` (it is a marketplace listing) or if that provider
actually bid; everyone else `403`. The fix is one guard in
`lib/modules/bidding/service.js#getJob`, with regression tests in `test/bidding.test.js` covering a
stranger customer, a non-bidding provider on a booked job, the owner, and a bidding provider.

Run the whole Area B proof (real token, forged, expired, wrong audience, service-side ownership, and
the BOLA attack before/after semantics):

```bash
bash scripts/beat3-auth-rejection.sh
```

Expected: every check passes, including

```
PASS  the extracted service verifies the same token itself
PASS  extracted service rejects a forged signature
PASS  extracted service rejects a token for the wrong audience
PASS  extracted service rejects an expired token
PASS  another user cannot mark Glow's notification read
PASS  an unrelated customer cannot read the job (was 200 before the fix)
```

---

## Seam analysis — what extracts first, and why

The boundaries are drawn so a context can be lifted into its own service with a known, small set of
cross-context calls to replace with network calls. Ranked by *how cleanly it detaches today*:

1. **Notifications (extract first — done in Area A).** It already behaved like a separate service:
   one owned table, no synchronous hot-path caller. It now runs as an Express service with its own
   PostgreSQL DB behind the gateway. The remaining monolith coupling is the **publisher** — the
   in-process relay still drains `events` and calls the service. Area C replaces that hop with
   RabbitMQ; the service's `source_event_id` dedupe already assumes at-least-once delivery.
   Lowest-risk, highest-teaching-value first cut.
2. **Payments & Wallet (extract second).** The webhook is already an async, idempotent,
   secret-authenticated boundary — exactly what a payments service exposes. Its one inward coupling is
   writing `orders.payment_status='paid'` at settlement (a Booking-owned column). That single
   cross-context write becomes a `booking.mark_paid` call or a `payment.succeeded` event Booking
   subscribes to. Clear seam, one wire to cut.
3. **Catalog / Provider Profile (extract together).** Read-heavy, mostly independent. The catch is
   the rating aggregate on `services`/`provider_profiles` is recomputed by the **relay** on
   `review.created` — so extraction means Catalog subscribes to that event instead of sharing the
   table. The outbox already models this dependency, which is the point.
4. **Booking + Bidding (extract last / together).** The hardest, because they share the physical
   double-book guard: **both** the place-booking path and the bid-accept path insert into
   `slot_holds` (the `UNIQUE(provider_id, service_date, slot_time)` index). In one database that
   uniqueness is free; split them and the availability/slot-hold invariant becomes a distributed
   concurrency problem (a reservation service, or sagas). Extract these last, and only once you have a
   deliberate answer for cross-service slot reservation. Identity is a shared dependency of everything
   and is best pulled out early as an IdP, but it has no owned business logic worth arguing about.

---

## The teaching hooks (all real, all tested)

Each is a genuine mechanism, not a stub, and each has a test proving it.

- **Place-booking = ONE transaction** (`booking/service.js#placeBooking`, `test/booking.test.js`).
  Order + items + `slot_holds` + optional payment intent + outbox event commit or roll back as a
  single `BEGIN IMMEDIATE` transaction. A slot clash leaves **zero** partial rows.
- **Slot double-book guard** — `UNIQUE(provider_id, service_date, slot_time)` on `slot_holds`. Two
  concurrent bookings for the same slot ⇒ **one 201, one 409** (`slot no longer available`). The
  read-side `get_available_slots` is advisory; the *write* is what makes a double-book physically
  impossible. (Contrast: the real product does an unguarded read-then-insert — two customers both pass.)
- **Bid-accept race** (`bidding/service.js#acceptBid`). `UPDATE job_requests SET status='booked'
  WHERE status='open'` then `UPDATE bids SET status='accepted' WHERE status='pending'` — both
  conditional. Two concurrent accepts ⇒ exactly one winner; accept-vs-withdraw ⇒ exactly one succeeds.
  No read-then-write gap.
- **OTP-gated completion** (`booking/service.js#completeBooking`). The provider closes a job only by
  entering the **6-digit OTP the customer holds** (proof of presence). The wallet credit lives inside
  the `UPDATE ... WHERE status='started' AND otp=?` — so a replay (or a second provider) matches zero
  rows and **the balance is credited exactly once**. Commission split: gateway → provider balance;
  COD → commission owed to the platform (`total*pct/100`).
- **Payment-webhook idempotency** (`payments/service.js#handleWebhook`). The gateway's
  `gateway_event_id` is the dedupe key (`webhook_events.gateway_event_id UNIQUE`). A replayed callback
  short-circuits and credits nothing twice. (Contrast: the real product has no idempotency and
  double-processes retries.)
- **Outbox + relay** (`db/events.js`, `notifications/relay.js`). Every state change writes an `events`
  row **in the same transaction**. A relay drains it (`setInterval` in `instrumentation.js`, or
  `runRelayOnce()` in tests), claiming each event via `processed_at` so it applies **exactly once**.
- **Eventual consistency of ratings.** The service/provider rating aggregate is recomputed **in the
  relay**, driven by `review.created` — *not inline* in the review handler. So a fresh review leaves
  the aggregate momentarily stale until the relay runs. This is the deliberate contrast with Ride
  (which updates the aggregate inline) and the whole reason the outbox exists here.
- **Idempotency-Key** (`db/idempotency.js`). `POST /api/bookings` replays the stored `{status, body}`
  for a repeated key; the `idempotency_keys.key` PRIMARY KEY makes two racing writes on one key
  impossible.

---

## Known monolith pains (deliberately left in — this is the migration target)

- **One database, shared by all eight contexts.** Cross-context writes are just function calls
  (Payments writes `orders.payment_status`; the relay writes `services.rating_avg`). Cheap and atomic
  now; each one becomes a network call + a consistency decision after extraction.
- **The relay is in-process.** `setInterval(runRelayOnce, 1000)` shares the connection and dies with
  the process. Real deployments need a durable broker + at-least-once delivery + a dead-letter path.
  The `events` table + `processed_at` claim is the seam that makes swapping it in mechanical.
- **Shared deploy + blast radius.** A migration, a slow query, or a crash in any context stops all of
  them. There is no independent scaling: the read-heavy Catalog scales with the write-heavy Booking.
  (Notifications is now the exception: it has its own deploy and DB, and a notifications outage no
  longer stops bookings — the relay retries.)
- **`slot_holds` is a single-DB invariant.** The strongest coupling. It is free in one SQLite file and
  becomes distributed reservation the moment Booking and Bidding live apart — which is exactly why
  they are the *last* thing to split.
- **Auth is no longer process-local.** Area B moved issuance to Keycloak and verification to realm
  JWKS, so an extracted fleet shares one identity source. The remaining pain is operational: the
  realm is imported from a committed JSON file, and the demo uses a published hostname
  (`localhost:8081`) rather than a production ingress with TLS.

Payment settlement and Wallet extraction, the full resilience checks, and tracing/metrics remain
separate migration work. The payment gateway used in this repo is simulated.

---

## Tests

`node --test`, no socket — the suite imports the real App Router route handlers and drives them
in-process against per-file in-memory databases. The payment setup suite also drives an HTTP test
server to simulate a Payments rejection or a dropped reply. The suites cover:

`health` · `identity` (auth, 401/403/400/409) · `catalog` (pagination, ownership) · `booking`
(id 8001, the slot double-book race, idempotency, the full status machine, OTP-gated complete +
exactly-once credit, cancel/refund, reschedule) · `slots` · `bidding` (accept race, accept-vs-withdraw)
· `payments-webhook` (replay = single credit) · `reviews-outbox` (stale-then-relay-recomputed,
relay idempotent, exactly one notification delivered across the boundary) · `admin` (approval writes
`provider.approved` atomically, the monolith owns no notifications table, relay delivers once).
