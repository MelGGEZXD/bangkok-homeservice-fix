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

**Capstone deliverables:** [`docs/dossier.md`](docs/dossier.md) (architecture dossier and industrial
landscape), [`OWNERS.md`](OWNERS.md) (area ownership and commits), and the four demo scripts under
`scripts/` with their expected output in [Demo scripts — the four beats](#demo-scripts--the-four-beats).
Submission tag: `capstone-final`.

---

## What it is

- **The monolith is one deployable.** Next.js 14 App Router. UI pages are Server Components that
  call the service layer **directly, in-process** (the honest monolith read path). Mutations POST to
  **route handlers** under `app/api/**`. The same code, one `node server.js`. Area A adds **two**
  extracted services beside it (Notifications and Payments & Wallet) behind the gateway.
- **The monolith owns one database.** `better-sqlite3`, one file `data/edemand.db` (`:memory:`
  under test). WAL, `foreign_keys=ON`. Dropped, migrated and **reseeded on every boot** — a fresh
  `docker compose up` is always identical. `sqlite_sequence` for `orders` is primed to 8000, so the
  **first booking on a fresh boot is always id 8001**. The extracted services own **separate
  PostgreSQL databases**; the monolith has no `notifications` table and none of the four money
  tables (`payment_intents`, `transactions`, `provider_wallets`, `webhook_events`).
- **Layered.** `route handler → service → repository → db`. No SQL outside repositories; no business
  logic in route files. Every route is zod-validated, typed-error-mapped, JWT+role-gated where
  required, and request-id + pino logged.

### Run it

**Areas A and B are in place:** the public entry point is the **nginx gateway on `:3000`**, and it
keeps the addresses the app already had. Keycloak is the only token issuer; it is an identity
dependency, not part of the domain API surface.

| Public URL | Routed to |
|---|---|
| `http://localhost:3000/api/notifications*` | Notifications service (`:3001`, own PostgreSQL DB) |
| `http://localhost:3000/api/provider/wallet` | Payments & Wallet service (`:3002`, own PostgreSQL DB) |
| `http://localhost:3000/api/customer/transactions` | Payments & Wallet service (`:3002`, own PostgreSQL DB) |
| `http://localhost:3000/api/payments/webhook` | Payments & Wallet service (`:3002`, own PostgreSQL DB) |
| `http://localhost:3000/*` | Next.js monolith (`:3000`, internal only — no published port) |
| `http://localhost:8081` | Keycloak (realm `edemand`; admin console for the demo) |
| `http://localhost:15672` | RabbitMQ management console (`edemand` / `edemand-demo-pass`) |
| `http://localhost:16686` | Jaeger trace UI (Area E) |
| `http://localhost:9090` | Prometheus (Area E; scrapes all three services) |
| `http://localhost:3005` | Grafana (Area E; anonymous admin, dashboard pre-provisioned) |

`/api/internal/*`, `/internal/*` and `/metrics` are refused by the gateway: those endpoints exist
only on the compose network.

```bash
# Full stack: monolith + two extracted services + two PostgreSQL DBs + Keycloak + RabbitMQ +
# Jaeger + Prometheus + Grafana + gateway
docker compose up -d --build --wait      # http://localhost:3000
docker compose run --rm test             # 76 unit/concurrency tests, in-memory, no server needed
docker compose down -v                   # first boot: drops both extracted DBs, RabbitMQ and Grafana
```

# App-only local dev (monolith on :3000). Extracted-service calls return 502 until they run. Start
# the dependencies, then export RABBITMQ_URL and the service URLs:
docker compose up -d rabbitmq notifications notifications-db payments payments-db
export RABBITMQ_URL=amqp://edemand:edemand-demo-pass@localhost:5672
export NOTIFICATIONS_SERVICE_URL=http://localhost:3001 PAYMENTS_SERVICE_URL=http://localhost:3002
npm install
npm run dev
# or: npm run build && npm start

# Each extracted service by itself (needs DATABASE_URL + KEYCLOAK_URL; notifications also RABBITMQ_URL)
cd notifications-service && npm install && DATABASE_URL=postgres://... KEYCLOAK_URL=... RABBITMQ_URL=... npm start
cd payments-service      && npm install && DATABASE_URL=postgres://... KEYCLOAK_URL=... npm start
```

Secrets are environment variables. The compose defaults are **demo-only**; override
`KEYCLOAK_ADMIN_PASSWORD` and `INTERNAL_API_KEY` (see `.env.example`). `JWT_SECRET` remains only for
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
| 6 | **Payments & Wallet** | `payment_intents`, `transactions`, `provider_wallets`, `webhook_events` in its **own PostgreSQL DB** (extracted) | Gateway intents, the idempotent webhook, the commission split. Money writes are idempotent by order and kind. |
| 7 | **Reviews** | `reviews` | One review per completed booking; emits `review.created`. |
| 8 | **Notifications** | `notifications` in its **own PostgreSQL DB** (extracted) | Read side + ownership check in the service. Consumes domain events from RabbitMQ and owns the event → notification projection. |

Shared infra (under `lib/db`, not a context): `events` (the outbox) and `idempotency_keys`.

Directory shape:

```
app/                 UI pages ((customer) (provider) (admin) groups) + api/** route handlers
lib/
  config.js logger.js errors.js
  http/              handle, respond, auth, validate, pagination, requestId, session
  db/                index, schema, migrate, seed, bootstrap, idempotency, events
  messaging/         rabbit.js (connection + confirms), publisher.js (outbox -> broker)
  modules/<context>/ repository.js + service.js  (+ booking/slots.js, booking/availability.js,
                                                   payments/client.js, notifications/relay.js,
                                                   notifications/client.js, sagas/*)
notifications-service/  extracted Express service: server.js, app.js, db.js (PostgreSQL), auth.js,
                        broker.js (RabbitMQ consumer), notification-rules.cjs, faults.js
payments-service/       extracted Express service: server.js, app.js, db.js (PostgreSQL), auth.js,
                        keycloak.js (JWKS verifier), config.js
gateway/nginx.conf      the Area A gateway: each extracted prefix -> its service, else -> monolith
test/ test-helpers/     node:test suite driving the real route handlers in-process
```

### Area A — two extractions (team scope)

A team of 4–5 must move **two** parts, each into its own service with its own database, and at
least one must change data rather than only read it. This repository ships both:

| Extracted service | Public prefix | Own database | Writes data? |
|---|---|---|---|
| Notifications | `/api/notifications*` | `notifications_db` | yes: creates and marks notifications |
| Payments & Wallet | `/api/provider/wallet`, `/api/customer/transactions`, `/api/payments/webhook` | `payments_db` | yes: payment intents, ledger entries, wallet balances, webhook dedupe |

#### Area A.1 — Notifications

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
- **Idempotent delivery.** Every domain event carries the outbox UUID (`source_event_id`). The
  service has a unique key on `(source_event_id, recipient_role, recipient_id, type)` and inserts
  with `ON CONFLICT DO NOTHING`. The relay releases a failed publish claim and retries —
  at-least-once delivery, exactly-one effect. Area C moves this hop onto RabbitMQ; the dedupe key
  is unchanged.
- **The service checks the token itself.** `notifications-service/auth.js` verifies the Keycloak
  RS256 token against the realm JWKS and derives the recipient from it, never from a query string.
  Mark-read also checks ownership (`403 not your notification`). See Area B below.
- **Approval is still atomic.** `approveProvider` writes the flag flip, the `provider_approval`
  saga row and the `provider.approved` outbox event in the same SQLite transaction; the relay
  publishes afterwards. The monolith never writes the moved table.

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

#### Area A.2 — Payments & Wallet

| The four boundary questions | Answer |
|---|---|
| **Name** | Payments & Wallet |
| **What crosses** | *Inbound from the monolith:* `POST /internal/payment-intents`, `POST /internal/wallets`, `POST /internal/ledger/booking-completed`, `POST /internal/ledger/booking-cancelled`, `POST /internal/simulate` (shared `X-Internal-Key`). *Inbound from clients:* `GET /api/provider/wallet`, `GET /api/customer/transactions` (JWT, verified by the service) and `POST /api/payments/webhook` (shared `X-Webhook-Secret`). *Outbound:* `POST /api/internal/orders/:id/payment-status` so the order owner learns the money settled. |
| **Ownership** | The service owns `payment_intents`, `transactions`, `provider_wallets` and `webhook_events` in **`payments_db`**. The monolith schema drops all four and has no payments repository. |
| **Decision** | Second extraction because it is the highest-write context with a genuinely separate aggregate: money rows never need a join back into `orders`. It also gives Area D a real idempotency target and Area C a real participant. |

Why this one, not Catalog/Provider? Provider data is joined by `services`, `orders`, `bids` and
`job_requests`; extracting it first forces cross-service reads into the hot booking path. Money
rows are referenced only by `order_id`, so the seam is narrow and the write volume justifies the
split.

What makes the cut real:

- **Same public addresses.** The wallet, ledger and webhook URLs are unchanged; nginx routes those
  prefixes to `payments:3002`. `/api/payments/simulate` deliberately stays on the monolith, because
  only the monolith owns `orders` and can prove the caller is the customer before money moves.
- **The monolith really cannot touch the rows.** `lib/db/schema.js` drops and does not recreate the
  four tables, and `lib/modules/payments/` contains only an HTTP client — no SQL. Provider
  registration calls `POST /internal/wallets`; booking completion calls the ledger endpoint.
- **Exactly-once money writes.** `payment_intents.order_id` is `UNIQUE` (a retried booking cannot
  create two intents) and `transactions(order_id, kind)` is `UNIQUE` (a redelivered webhook or a
  retried completion cannot double-credit). `webhook_events.gateway_event_id` is the replay key.
- **The service checks the token itself.** `payments-service/auth.js` verifies the Keycloak RS256
  token against the realm JWKS, derives the provider/customer id from `local_id`, and returns 403
  when the role does not match the route.
- **Order state stays with the order owner.** After the money transaction commits, the service calls
  the monolith's internal, idempotent settlement endpoint. The `orders.payment_status` update is
  conditional, and the `payment.succeeded` outbox event is emitted only on the first transition.

Proof from the running stack:

```bash
docker compose up -d --build --wait

# 1. The payments service answers this 401 itself (no monolith requestId in the body).
curl -i http://localhost:3000/api/provider/wallet

# 2. A provider token reads its own wallet from PostgreSQL.
SPARKLE=$(curl -s -X POST http://localhost:3000/api/auth/provider/login \
  -H 'content-type: application/json' \
  -d '{"email":"sparkle@example.com","password":"eDemand-2026!"}' | jq -r .token)
curl -s -H "authorization: Bearer $SPARKLE" http://localhost:3000/api/provider/wallet

# 3. A gateway webhook settles a booking once; the same event id again is a 200 no-op.
curl -s -X POST http://localhost:3000/api/payments/webhook \
  -H 'content-type: application/json' -H 'x-webhook-secret: edemand-webhook-secret' \
  -d '{"gateway_event_id":"evt-1","type":"payment_intent.succeeded","gateway_ref":"SIM-PI-..."}'
```

The full proof — including one-charge-after-replay and the wallet row appearing in `payments_db` —
is `scripts/verify-area-a.ps1`. Reset with `docker compose down -v`, which drops both extracted
databases as well as RabbitMQ.

### Area B — Keycloak tokens, ownership, and the BOLA fix

| Question | Answer |
|---|---|
| **Who issues tokens?** | Keycloak 26.0, realm `edemand`, imported from `keycloak/realm-edemand.json` on every clean boot. The monolith never signs a production token. |
| **What is in the token?** | RS256 access token with `iss=http://localhost:8081/realms/edemand`, `aud` containing `edemand-api`, and two custom claims mapped from Keycloak user attributes: `local_id` (the monolith's numeric user id) and `role` (`customer` / `provider` / `admin`). |
| **Who verifies it?** | All three processes, independently. The monolith (`lib/http/keycloak.js`), the notifications service (`notifications-service/keycloak.js`) and the payments service (`payments-service/keycloak.js`) fetch the realm JWKS at boot with retries, cache keys by `kid`, and verify signature + issuer + audience + expiry locally. There is no shared signing secret. |
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

### Area C — events on RabbitMQ, duplicate delivery, and a saga

| The four boundary questions | Answer |
|---|---|
| **What crosses** | Domain **events**, not commands: `provider.approved`, `provider.approval_reverted`, `booking.status_changed`, `booking.completed`, `review.created`, `bid.accepted`, `payment.succeeded`. The message is the raw event (`event_uid`, `type`, `aggregate_*`, `payload`, `occurred_at`). |
| **Ownership** | The monolith owns the outbox (`events`) and the saga table (`sagas`). The Notifications service owns the event → notification projection (`notification-rules.cjs`) and its PostgreSQL rows. |
| **Transport** | RabbitMQ topic exchange `edemand.events`; durable queues `edemand.notifications` (consumer: Notifications) and `edemand.sagas` (consumer: the orchestrator). Publisher confirms; at-least-once delivery. |
| **Decision** | Publish from the outbox in the same transaction as the state change, then let each consumer own its projection. Provider approval is the cross-service workflow, run as an **orchestrated saga**. |

**Outbox, not dual writes.** `approveProvider`, every booking transition, `review.created`, bid
acceptance and payment settlement insert their `events` row inside the same SQLite transaction as
the state change. Either both commit or neither does. The in-process relay (`setInterval` in
`instrumentation.js`) claims a row, publishes it to `edemand.events`, and only then stamps
`processed_at`. If the broker is down the claim is released and the next pass retries. This is the
transactional-outbox pattern, not “write the DB then publish and hope”.

**Duplicate delivery still has one effect.** Delivery is at-least-once by design: a broker can
redeliver after a crash, and the relay can republish after a failed confirm. The Notifications
service inserts with a unique key `(source_event_id, recipient_role, recipient_id, type)` and
`ON CONFLICT DO NOTHING`, where `source_event_id` is the outbox UUID. A duplicate message therefore
creates **no second row**. The saga outcomes use the same trick: `notification.created` /
`notification.failed` are handled by conditional `UPDATE ... WHERE state='awaiting_notification'`,
so a duplicate outcome cannot finish or compensate a saga twice.

**Two events are demonstrated.** `provider.approved` is the event that drives the saga below.
`booking.status_changed` is the ordinary event path: placing a booking writes it, the relay publishes
it, and the projection notifies the counterparty. Both are proven on the live stack and in
`test/area-c-events.test.js`.

**The saga: provider approval.** Approving a provider has a local step (set `is_approved`) and a
remote step (create the welcome notification in another service/database). The sequence is:

1. **local** — in one SQLite transaction: flip `is_approved`, insert the `sagas` row
   (`awaiting_notification`), insert `provider.approved` with its `saga_id` in the payload;
2. **remote** — Notifications consumes the event, writes the notification idempotently, and
   publishes `notification.created` (or `notification.failed`);
3. **local** — the orchestrator consumes the outcome: `notification.created` moves the saga to
   `completed`; `notification.failed` runs the **compensating action**, which unapproves the provider
   and writes `provider.approval_reverted` in the same transaction as `state='compensated'`.

The admin can follow the workflow at `GET /api/admin/sagas/{id}` (and list it at
`GET /api/admin/sagas`). A failed approval can be retried; a retry is a fresh saga.

**Why orchestration, not choreography.** The approval is one admin action with a clear owner, a
short fixed sequence (two steps), and exactly one compensating action. Putting that sequence in one
place makes it easy to read, test and operate: the monolith can answer “what happened to this
approval?” from one `sagas` row, and the remote participant stays dumb — it only reports whether the
notification was created. Choreography would spread the sequence across Notifications (which would
have to know that its failure means “unapprove”) and make ownership of the compensation ambiguous.
Choreography is the better fit for long, loosely-coupled, many-consumer flows; a two-step onboarding
with one owner is not that.

**Deterministic failure demo.** `POST /internal/faults` on the Notifications service (shared internal
key, never routed through the gateway) turns on `notification_failure`. The consumer then publishes
`notification.failed` instead of writing a row, which triggers the real compensation. The switch is
in-memory and resets on restart.

```bash
bash scripts/verify-area-c.sh
```

Expected (after `docker compose up -d --build --wait`):

```
PASS  notifications queue exists on RabbitMQ
PASS  Notifications service is consuming edemand.notifications (1 consumer)
PASS  topic exchange exists
PASS  approval returned saga <uuid>
PASS  saga <uuid> completed after notification.created
PASS  the relay published event <uuid> to RabbitMQ (outbox row processed)
PASS  re-publishing the same event created no second notification
PASS  PostgreSQL holds exactly one row for source_event_id <uuid>
PASS  booking.status_changed was published from the outbox
PASS  FixIt received exactly one booking_status notification for order ...
PASS  notification.failed compensated saga <uuid>
PASS  compensating action unapproved Glow
PASS  Glow received provider_approval_reverted
PASS  retry completed the saga and Glow is approved again
AREA C PASSED (18 assertions)
```

**Reset.** `docker compose down -v` drops both the notifications PostgreSQL volume and the RabbitMQ
volume. RabbitMQ also recreates the exchange/queues from the assert-on-boot code, so the topology is
deterministic. The broker is not a second source of truth: the outbox is.

---

### Area D — timeouts, retries, idempotency, and one repaired race

Area D makes the **monolith → Payments & Wallet** seam survive the three failures the brief names.
The seam is used by booking completion (payout/commission) and cancellation (refund); the demo uses
completion because it changes money and is easy to observe.

| Injected failure | What happens at the seam | Why the caller survives |
|---|---|---|
| **Reply lost after the write** (`lost_reply`) | Payments commits the ledger row and the idempotency record, then destroys the socket before the response is written. | The client sees a transport error, backs off and retries with the **same** `Idempotency-Key`. Payments finds the stored response and replays it. One effect. |
| **Reply slower than the timeout** (`slow_reply_ms`) | Payments commits, then holds the response past the client's 3s timeout. | The client times out, retries with the same key; the stored response is returned immediately. The first, late response writes to a dead socket and is ignored. One effect. |
| **Service unavailable for a window** (`outage_ms`) | Every request fails with 503 before any write. | The order commit is already durable and includes a `ledger_commands` row. The response does not fail; the background reconciler replays the command after the outage ends. One effect. |

**Timeout + retry + jitter** live in `lib/modules/payments/client.js`:

```js
AbortSignal.timeout(config.paymentsTimeoutMs)              // 3000 ms
config.paymentsMaxAttempts                                  // 3 attempts
delay = random() * min(4000, 250 * 2^(attempt-1))           // exponential, full jitter
```

Only transport failures, timeouts and 5xx are retried; a 4xx is a decision and escapes at once.
Full jitter is deliberate: a fleet that retries in lockstep after an outage creates the next
outage. Jitter spreads the retries over the backoff window.

**Two layers of idempotency, on purpose.**

1. *Transport* — every logical write gets one key (`payment-intent:<order>`,
   `booking-completed:<order>`, `webhook:<gateway_event_id>`, …). Payments stores it in
   `idempotency_keys(key PRIMARY KEY)` together with the response and returns that response on a
   replay. Retries and reconciliation attempts are therefore observed once.
2. *Domain* — the money tables keep their own UNIQUE keys: `payment_intents.order_id`,
   `transactions(order_id, kind)` and `webhook_events.gateway_event_id`. Even two different keys
   that race cannot double-credit, because the database refuses the second row.

**Durability before the network call.** Completing or cancelling a booking writes the order change,
the outbox event and a `ledger_commands` row in the **same SQLite transaction**
(`lib/modules/booking/service.js`, `lib/modules/payments/ledger-queue.js`). The direct HTTP call is
only the low-latency path; if it fails, the row stays pending and
`startLedgerReconciler()` (started in `instrumentation.js`) retries it every 3 seconds until the
payments service acknowledges it. A payments outage delays the wallet update but cannot lose it.

**The unsafe race that was fixed.** Registering a customer or provider was a read-then-write:
`findCustomerByEmail()` followed by `INSERT`. Two requests arriving together both read “no such
email”, both insert, and the UNIQUE(email) index rejects the second — but the raw
`SQLITE_CONSTRAINT_UNIQUE` became a **500** instead of the 409 the sequential path returns.
The fix in `lib/modules/identity/repository.js` lets the index be the arbiter and translates the
constraint into `ConflictError` (409). It is proven by `test/identity-race.test.js`, which opens two
worker threads on the same file database, holds `BEGIN IMMEDIATE` while both pass the advisory
check, then releases the lock: exactly one registration wins, the other is a clean 409, and one row
exists. The test was run with the translation disabled to confirm it fails with the raw SQLite
error before the fix.

**Proof.** `scripts/beat2-failure-recovery.sh` arms each switch through the internal-only control
endpoint, completes a real booking, and asserts the order stays completed, the wallet has exactly
one ledger row for that order, and the durable command is marked done. It passes 20 assertions on
a clean boot. The race proof is part of `npm test` and CI.

**Tradeoff accepted.** The reconciler is in-process and polls every 3 seconds, so a recovery is
“seconds, not milliseconds”, and a total monolith outage pauses reconciliation until it restarts.
The alternative — a separate queue worker/CDC — is more moving parts than a two-step money write
needs at this size. What matters is that the command is durable first and retried later, not that
the retry is instantaneous.

### Area E — traces, metrics, dashboard, and contract tests

**One trace across both seams.** OpenTelemetry is wired in all three processes:

- `lib/telemetry.js`, `payments-service/telemetry.js`, `notifications-service/telemetry.js`
- the monolith starts a SERVER span in `lib/http/handle.js` and returns `x-trace-id` plus a W3C
  `traceparent` header;
- the payments client injects the current `traceparent` on every outbound HTTP call, so the
  payments SERVER span is a child of the monolith route span;
- `events.trace_parent` stores the trace of the request that wrote the outbox row. The relay starts
  a PRODUCER span parented to it, and `lib/messaging/rabbit.js` puts that `traceparent` in the
  RabbitMQ message headers;
- the notifications consumer starts a CONSUMER span from the header, and carries the trace into
  `notification.created` / `notification.failed`; the monolith's saga consumer continues it.

The result is visible in Jaeger: one trace containing `POST /api/bookings` (edemand),
`POST /internal/payment-intents` (payments), `publish booking.status_changed` (edemand) and
`process booking.status_changed` (notifications). `scripts/beat4-find-the-trace.sh` asserts the
three services are present and that every child span points at a parent in the same trace.

Tracing is **off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set**, so `node --test` and a bare
`npm run dev` do not emit spans. Compose points all three services at `http://jaeger:4318`; the UI
is `http://localhost:16686`.

**Metrics and dashboard.** Each service exposes `/metrics` in Prometheus format. `nginx` returns
404 for `/metrics` and `/internal`, so they are reachable only on the compose network. The shared
metric names are:

| Metric | Labels | Used for |
|---|---|---|
| `http_requests_total` | `service`, `method`, `route`, `status` | request rate and 5xx ratio |
| `http_request_duration_seconds` | `service`, `method`, `route`, `status` | p95 response time |
| `notifications_events_projected_total` | `service`, `event_type`, `outcome` | consumer progress and injected failures |

Route labels are normalised (`/api/bookings/8001` → `/api/bookings/:id`), so ids do not explode the
time-series count. Prometheus scrapes all three targets every 5s; Grafana is provisioned from
`observability/` with one dashboard, **eDemand — services at a glance**, containing request rate,
error rate and p95 latency per service. Open `http://localhost:3005`.

**Contract tests.** Pact consumer tests live in `test/pact/`:

- `notifications.pact.test.js` drives the real monolith client against a Pact mock and pins the
  inbox response shape and the forwarded bearer token;
- `payments.pact.test.js` pins `POST /internal/payment-intents` (including the
  `Idempotency-Key` header) and `GET /api/provider/wallet`.

They write `pacts/edemand-monolith-{notifications,payments}-service.json`. Run them with
`npm run test:pact`. `.github/workflows/ci.yml` runs the unit suite, the contract job and a
production build; the contract job was executed locally with:

```bash
act pull_request -j contracts
```

`act` does not provide GitHub's artifact service, so the upload step is guarded with
`if: ${{ env.ACT != 'true' }}`; the job still fails the run if a contract breaks.

---

## Demo scripts — the four beats

Run them in order on a clean boot (`docker compose down -v && docker compose up -d --build --wait`).
Each script waits for health, prints one `PASS` line per assertion, and exits non-zero on a
mismatch. They use only `curl`, `node` and the compose stack.

### 1. `scripts/beat1-happy-path.sh`

One request path across every boundary: the notifications service refuses an anonymous call, admin
approval drives the saga and the RabbitMQ projection, a gateway booking creates a payment intent,
“Pay now” settles it, and OTP completion writes one payout row in Payments.

```bash
bash scripts/beat1-happy-path.sh
```

Expected (ids differ per boot):

```
PASS  stack healthy at http://localhost:3000/api/health
PASS  unauthenticated inbox is 401 at the service
PASS  401 body came from the notifications service, not the monolith
PASS  admin approved provider Glow (id 3)
PASS  saga <uuid> completed after notification.created
PASS  Glow's provider_approved notification is readable through the extracted service
PASS  placed gateway booking 8001 (HTTP seam to payments)
PASS  pay-now settled the intent through the payments service
PASS  the order owner sees payment_status=paid
PASS  provider completed booking 8001 with the OTP
PASS  payments holds exactly one payout_credit row for order 8001
PASS  the wallet row carries the order's provider earnings (109140 cents)

BEAT 1 PASSED (12 assertions)
```

On a second run without a reset, Glow is already approved; the script says so and still proves the
inbox and the remaining beats.

### 2. `scripts/beat2-failure-recovery.sh`

The three Area D failures, each survived with exactly one wallet effect. The switches are internal
and reset automatically when the script exits.

```bash
bash scripts/beat2-failure-recovery.sh
```

Expected:

```
== lost reply after the write: order 8002 ==
PASS  completion survived 'lost reply after the write' (HTTP 200 after 162ms)
PASS  order 8002 is completed, not rolled back
PASS  payments holds exactly one ledger row for order 8002 after recovery
PASS  the durable ledger command is marked done once

== reply slower than the timeout: order 8003 ==
PASS  completion survived 'reply slower than the timeout' (HTTP 200 after 3230ms)
PASS  the client waited for the 5000ms response and then retried
PASS  payments holds exactly one ledger row for order 8003 after recovery

== payments fails for a time window: order 8004 ==
PASS  completion survived 'payments fails for a time window' (HTTP 200 after 616ms)
PASS  payments holds exactly one ledger row for order 8004 after recovery

BEAT 2 PASSED (20 assertions)
One order, one wallet effect, in every failure mode.
```

### 3. `scripts/beat3-auth-rejection.sh`

Real Keycloak token accepted by both boundaries; forged, expired and wrong-audience tokens rejected
with 401 by the monolith **and** the extracted services; ownership enforced; and the inherited
`GET /api/jobs/{id}` BOLA attack returns 403 where it used to return 200.

```bash
bash scripts/beat3-auth-rejection.sh
```

Expected:

```
PASS  token issuer is Keycloak
PASS  the monolith accepts the real token
PASS  the extracted service verifies the same token itself
PASS  monolith rejects a forged signature
PASS  extracted service rejects a forged signature
PASS  monolith rejects a token for the wrong audience
PASS  extracted service rejects a token for the wrong audience
PASS  monolith rejects an expired token
PASS  extracted service rejects an expired token
PASS  another user cannot mark Glow's notification read
PASS  an unrelated customer cannot read the job (was 200 before the fix)
PASS  the owner still reads the job

AREA B PASSED (17 assertions)
```

### 4. `scripts/beat4-find-the-trace.sh`

Makes one gateway booking and finds the same request in Jaeger after the asynchronous half has run.
A marker can open the printed URL and see all three services in one trace.

```bash
bash scripts/beat4-find-the-trace.sh
```

Expected:

```
PASS  response carries a 32-hex x-trace-id (<trace-id>)
PASS  the same response carries a W3C traceparent (00-<trace-id>-<span-id>-01)
PASS  the monolith contributed spans
PASS  the payments service continued the HTTP trace
PASS  the notifications service continued the RabbitMQ trace
ORPHANS=0
SPANS
  edemand        POST /api/bookings (...ms)
  edemand        fetch POST http://payments:3002/internal/payment-intents (...ms)
  payments       POST /internal/payment-intents (...ms)
  edemand        publish booking.status_changed (...ms)
  notifications  process booking.status_changed (...ms)
PASS  every child span points at a parent in the same trace

BEAT 4 PASSED (12 assertions)
Open the trace: http://localhost:16686/trace/<trace-id>
Grafana (request rate, error rate, p95 latency per service): http://localhost:3005
```

**Reset between runs.** `docker compose down -v` is the canonical first boot: it drops
`notifications-db-data`, `payments-db-data`, `rabbitmq-data` and `grafana-data`. The monolith reseeds
SQLite on every start, so booking ids return to 8001.

---

## Seam analysis — what extracts first, and why

The boundaries are drawn so a context can be lifted into its own service with a known, small set of
cross-context calls to replace with network calls. Ranked by *how cleanly it detaches today*:

1. **Notifications (extract first — done in Area A).** It already behaved like a separate service:
   one owned table, no synchronous hot-path caller. It now runs as an Express service with its own
   PostgreSQL DB behind the gateway. **Area C closed the remaining coupling**: the relay publishes
   raw domain events to RabbitMQ, and the service owns the event → notification projection. The
   service's `source_event_id` dedupe still assumes at-least-once delivery.
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
- **Payment-webhook idempotency** (`payments-service/app.js#settleWebhook`). The gateway's
  `gateway_event_id` is the dedupe key (`webhook_events.gateway_event_id UNIQUE`). A replayed callback
  short-circuits and credits nothing twice. (Contrast: the real product has no idempotency and
  double-processes retries.)
- **Outbox + relay + broker** (`db/events.js`, `notifications/relay.js`, `lib/messaging/rabbit.js`).
  Every state change writes an `events` row **in the same transaction**. A relay drains it
  (`setInterval` in `instrumentation.js`, or `runRelayOnce()` in tests), claiming each event via
  `processed_at` and publishing it to RabbitMQ with publisher confirms. Consumers dedupe on the
  outbox UUID, so a redelivery has exactly one effect. The live proof is
  `scripts/verify-area-c.sh`.
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
  the process. The broker makes delivery durable across service restarts, but the *publisher* is
  still the monolith's own timer (a relay container, Debezium/CDC, or a transactional queue would
  be the next step). The `events` table + `processed_at` claim is the seam that makes that swap
  mechanical.
- **Sagas are single-orchestrator.** `sagas` lives in the monolith's SQLite file and the orchestrator
  is the monolith. That is the right amount of process for one two-step workflow; a second
  orchestrator instance would need a lease/claim on `sagas` rows (the conditional UPDATEs already
  make duplicate *messages* safe, but not duplicate pollers).
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

Out of scope by design (course adds later): real payment gateways, chat, cart, subscriptions,
multi-region deployment. `SOAP`/`WSDL` appear nowhere.

---

## Tests

`node --test`, no socket — the suite imports the real App Router route handlers and drives them
in-process against per-file in-memory databases. **78 tests** (76 functional + the 2 Pact contract
files) across:

`health` · `identity` (auth, 401/403/400/409) · `catalog` (pagination, ownership) · `booking`
(id 8001, the slot double-book race, idempotency, the full status machine, OTP-gated complete +
exactly-once credit, cancel/refund, reschedule) · `slots` · `bidding` (accept race, accept-vs-withdraw)
· `payments-webhook` (replay = single credit) · `reviews-outbox` (stale-then-relay-recomputed,
relay idempotent, exactly one notification delivered across the boundary) · `admin` (approval writes
`provider.approved` atomically, the monolith owns no notifications table, relay delivers once) ·
`area-c-events` (outbox + publisher, duplicate delivery has one effect, `notification.created`
completes the saga, `booking.status_changed` as a second event, `notification.failed` compensates by
unapproving the provider, retry succeeds) · `identity-race` (two worker threads race one email through
a held `BEGIN IMMEDIATE` lock: one 201, one clean 409, one row — the Area D race fix) ·
`notifications` / `payments` Pact consumer contracts (`test/pact/`, `npm run test:pact` — also a
separate `contracts` CI job run locally with `act`).

The Area D retry/timeout/durability behaviour is proven end-to-end on the compose stack by
`scripts/beat2-failure-recovery.sh`: three real injected failures, and in each one exactly one
ledger row and one completed order. Unit tests do not fake the payments service for this, because
the interesting part is the wire.

The broker itself is not started by `node:test`; `test-helpers/notifications.js` installs an
in-process publisher that runs the **same** projection rules as the service
(`notifications-service/notification-rules.cjs`). RabbitMQ, real queues and duplicate redelivery are
proven by `scripts/verify-area-c.sh` on the compose stack.
