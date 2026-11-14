# Bangkok Homeservice — architecture dossier

**Course:** DES428 Web Services and Service Architecture — capstone
**System:** Bangkok Homeservice (formerly eDemand), a multi-vendor home-services marketplace
**Starting point:** the supplied Next.js monolith, unmodified in language and framework
**Submission tag:** `capstone-final`
**Evidence:** every measurement, trace, test result and command output in this document comes from
our own runs on the checked-in stack. Commands are reproducible from the repository root.

This dossier is the seven-section architecture record required for the capstone, plus the four
artefacts the brief asks for inside it: the boundary map of the whole system, a three-part account
for every boundary on that map, a four-part defence for every seam we cut, and the industrial
landscape table.

---

## 1. System map

### 1.1 What the system does

Bangkok Homeservice is an on-demand home-services marketplace. A customer chooses a service
(cleaning, repair, beauty, appliance), picks a provider and a time slot, and places a booking. Some
jobs are fixed-price catalogue items; others are custom job requests that providers bid on. A
booking moves through an explicit status machine: placed, accepted, in progress, completed (gated by
a one-time code the customer gives the provider), or cancelled. Money enters through a simulated
payment gateway, is held as a payment intent, and settles into a provider wallet after commission.
Providers need admin approval before they can take work; reviews require a completed booking.

The supplied system is one deployable: a Next.js 14 App Router process, one SQLite file, UI and API
together. That is the correct starting point, because extraction is only meaningful when there is a
working monolith to extract from. We kept its language, framework, public addresses, demo data and
deterministic reseed.

### 1.2 The monolith after the migration

The monolith still owns most of the domain and all of the user-facing UI:

| Context | Tables still owned by the monolith |
|---|---|
| Identity | `customers`, `providers`, `admins` |
| Catalog / Provider profile | `categories`, `services`, `provider_profiles`, `provider_timings` |
| Booking | `orders`, `order_items`, `slot_holds`, `addresses` |
| Bidding | `job_requests`, `bids` |
| Reviews | `reviews` |
| Shared infrastructure | `events`, `sagas`, `idempotency_keys`, `ledger_commands` |

Two contexts have left:

| Extracted context | Own database | Service |
|---|---|---|
| Notifications | PostgreSQL `notifications_db` | Express on port 3001 |
| Payments & Wallet | PostgreSQL `payments_db` | Express on port 3002 |

The moved tables are physically absent from the monolith schema. `lib/db/schema.js` contains an
explicit comment where the money tables used to be, and the notifications table is not declared at
all. This is stronger than a naming convention: the monolith cannot read or write the moved data
because the tables do not exist. Any attempt fails loudly.

### 1.3 Runtime topology

```
                              browser / mobile / curl
                                        |
                                        |  http://localhost:3000  (the only published app port)
                                        v
                         +-----------------------------+
                         |  nginx gateway (1.27)       |
                         |  correlation id, routing    |
                         +----+-----------+------------+
                              |           |
        /api/notifications*   |           |  /api/provider/wallet
        /api/notifications/*  |           |  /api/customer/transactions
                              |           |  /api/payments/webhook
                              v           v
                   +----------------+  +----------------------+
                   | notifications  |  | payments             |
                   | Express :3001  |  | Express :3002        |
                   | RS256 JWKS     |  | RS256 JWKS           |
                   +-------+--------+  +----------+-----------+
                           |                      |
                    notifications_db        payments_db
                    (PostgreSQL 15)         (PostgreSQL 15)
                           ^                      ^
                           |  edemand.events      |  internal HTTP
                           |  (RabbitMQ topic)    |  + Idempotency-Key
                           |                      |
                   +-------+----------------------+-----------+
                   |  edemand monolith  (Next.js 14, :3000)    |
                   |  SQLite: orders, identity, catalog, ...   |
                   |  outbox, sagas, ledger_commands           |
                   +-------+----------------------+-----------+
                           |                      |
                           | OTLP/HTTP            | /metrics
                           v                      v
                    +-------------+        +--------------+
                    | Jaeger      |        | Prometheus   |
                    | :16686      |        | :9090        |
                    +-------------+        +------+-------+
                                                  |
                                           +------v-------+
                                           | Grafana      |
                                           | :3005        |
                                           +--------------+

                   Keycloak :8081 (realm edemand) issues RS256 tokens.
                   Every service fetches the realm JWKS and verifies tokens itself.
```

Only nginx publishes port 3000. The monolith, notifications and payments have no host ports.
Keycloak (8081), RabbitMQ (5672 / 15672), Jaeger (16686 / 4318), Prometheus (9090) and Grafana
(3005) are published because a human has to inspect them during the demo; they are not part of the
domain API surface. The two PostgreSQL instances are not published at all.

The whole graph is started by one command:

```bash
docker compose up -d --build --wait
```

`--wait` makes the command exit only when every health check is green. `docker compose down -v`
returns the system to first boot by deleting both extracted databases, RabbitMQ state and Grafana
state; the monolith's SQLite file is rebuilt and reseeded on every start.

### 1.4 The two seams and the observability seam

The migration cuts two service boundaries and leaves an asynchronous seam between them:
1. **Notifications.** Lowest risk: one owned table, no synchronous hot-path caller. It now runs as an
   Express service with its own database. The read side is reached through the gateway at the same
   public URLs. The write side is no longer an RPC: the monolith writes an outbox row in the
   transaction that changes state, a relay publishes the raw domain event to RabbitMQ, and the
   notifications service owns the event-to-notification projection.
2. **Payments & Wallet.** Extracted second because money has the clearest transaction boundary and
   the highest value from isolation. The monolith keeps `orders` and calls the service for intents,
   wallet reads, settlement and ledger writes. The webhook is authenticated and idempotent at the
   service.
3. **The asynchronous seam.** RabbitMQ carries `booking.status_changed`, `provider.approved` and
   `review.created` to Notifications, and carries `notification.created` / `notification.failed`
   back to the monolith's saga consumer. Delivery is at-least-once, so every consumer is idempotent.

Area E adds a cross-cutting seam that is not a service boundary but is a contract: the W3C
`traceparent` that crosses HTTP and RabbitMQ so one trace survives both.

---

## 2. Boundary decisions

### 2.1 Boundary map

The map below is authoritative. Every boundary is numbered, and section 2.2 gives the required
three-part account for each: name, what crosses it, and the one-sentence decision behind it.

```
 B1  client ──HTTP──> nginx gateway :3000
 B2  gateway ──HTTP──> monolith :3000          (everything not extracted)
 B3  gateway ──HTTP──> notifications :3001     (/api/notifications*)
 B4  gateway ──HTTP──> payments :3002          (wallet, transactions, webhook)
 B5  monolith ──HTTP──> notifications :3001    (internal command, tooling/tests only)
 B6  monolith ──HTTP──> payments :3002         (intents, ledger, simulate; internal key)
 B7  payments ──HTTP──> monolith :3000         (POST /api/internal/orders/:id/payment-status)
 B8  monolith ──AMQP──> notifications          (domain events via outbox + edemand.events)
 B9  notifications ──AMQP──> monolith          (saga outcomes: created / failed)
 B10 every service ──HTTPS──> Keycloak          (realm JWKS + issuer/audience trust)
 B11 services ──OTLP/HTTP──> Jaeger             (spans, trace context)
 B12 Prometheus ──HTTP──> every service        (/metrics scrape, internal only)
```

`B5` is marked "tooling/tests only": the production event path is `B8`. The HTTP command endpoint
still exists because it is the idempotent primitive the Area A verification script uses.

`B7` exists because Payments does not own `orders`. After settlement the money service tells the
order owner, which alone updates `orders.payment_status`. Neither service writes the other's table.

### 2.2 Three-part account for every boundary

| # | Boundary name | What crosses it | One-sentence decision |
|---|---|---|---|
| B1 | Public edge | HTTP requests, bearer tokens, `x-request-id`, JSON bodies; responses and `x-trace-id` / `traceparent` | One published entry point keeps every public address stable while the internals move. |
| B2 | Gateway → monolith | All non-extracted API and UI routes, the caller's `Authorization`, the correlation id | The monolith remains the default owner, so extraction changes only the routes that moved. |
| B3 | Gateway → Notifications | `GET /api/notifications`, `POST /api/notifications/:id/read`, the caller's token | Notifications is read through the service that owns the rows, so the monolith cannot leak another user's inbox. |
| B4 | Gateway → Payments | `GET /api/provider/wallet`, `GET /api/customer/transactions`, `POST /api/payments/webhook`, the token or webhook secret | Money reads and the gateway callback belong to the money service, at the same public URLs. |
| B5 | Monolith → Notifications (internal) | `POST /internal/notifications` with the internal key and an idempotent `source_event_id` | An idempotent command is kept for tooling and tests, but it is not the production event path. |
| B6 | Monolith → Payments (internal) | Intent create/read, wallet create/delete, completed/cancelled ledger commands, simulate; internal key, `Idempotency-Key`, `traceparent` | The monolith asks for money effects; it never writes money tables. |
| B7 | Payments → Monolith (callback) | `POST /api/internal/orders/:id/payment-status` with `kind`, `amount_cents`, `gateway_event_id`; internal key | The money service reports settlement to the order owner, which alone updates `orders.payment_status`. |
| B8 | Monolith → Notifications (events) | JSON event envelope (`event_uid`, `type`, aggregate, payload, `occurred_at`) with `traceparent` in AMQP headers | Events publish from the outbox after commit, so Notifications owns the projection and the hot path stays local. |
| B9 | Notifications → Monolith (saga) | `notification.created` / `notification.failed` envelopes with `saga_id` and `traceparent` | The saga needs a reply to complete or compensate, and only Notifications knows whether the welcome message was created. |
| B10 | Services → Keycloak | Realm JWKS, issuer, audience, client id; no user credentials | Keycloak is the only issuer; every process verifies RS256 independently instead of trusting a shared secret. |
| B11 | Services → Jaeger | OTLP/HTTP spans and resource attributes; W3C trace context as a header/field | One trace must cross both the HTTP and broker seams, so trace context is part of every boundary contract. |
| B12 | Prometheus → services | `GET /metrics` in Prometheus text format | Request rate, error rate and latency are scraped from every service with the same metric names, so one dashboard compares them. |

Two boundaries are easy to miss in a service diagram:

- **B7 is a boundary, not an implementation detail.** Payments could have written
  `orders.payment_status` with a second connection. We rejected that because it recreates the
  distributed monolith: two services sharing one table is not an extraction.
- **B10 is a runtime dependency.** All three processes wait for Keycloak and retry the JWKS fetch at
  boot; a missing realm is a red health check, not a stream of 500s.

### 2.3 Four-part defence for each seam we cut

The brief asks for a claim, the alternative we rejected (stated fairly), evidence from our own work,
and the tradeoff we accept. We cut five seams: the two service extractions, the asynchronous event
seam, the durable ledger seam introduced by Area D, and the trace-context seam. The first two are
organisational boundaries; the last three are consistency/observability boundaries that had to be
designed even though no process moved.

#### Seam 1 — Notifications

**Claim.** Notifications can leave the monolith without changing a single public URL or booking code
path, because it owns one table and has no synchronous writer on the booking hot path.

**Alternative rejected.** Keep notifications inside the monolith and only move the table to a second
database with a shared connection. That is faster, but it leaves two writers and no enforceable
boundary: the monolith could still join `notifications` to `orders`, so the extraction would be a
deployment diagram rather than an architecture. A synchronous RPC from every booking transition to
the service was also rejected: it puts a network call on the booking path and makes a notification
outage fail bookings.

**Evidence.** The monolith schema no longer declares `notifications`; the service owns it in
`notifications-service/db.js`. `GET /api/notifications` and mark-read are served by the service
through nginx, and `bash scripts/beat1-happy-path.sh` shows an unauthenticated request returning 401
**from the service** (the body has no monolith `requestId`) and a real token reading the provider's
notification. The service's `source_event_id` plus `(recipient_role, recipient_id, type)` UNIQUE
constraint makes a redelivered event a no-op; `scripts/verify-area-c.sh` proves duplicate delivery
has one effect. `scripts/verify-area-a.ps1` reports 32/32 assertions.

**Tradeoff accepted.** The read path is one network hop and can be unavailable while the monolith is
healthy. That is acceptable because the inbox is not on the booking write path; a down inbox is a
degraded feature, not a lost booking. The service also needs its own database lifecycle, migrations
and backup story.

#### Seam 2 — Payments & Wallet

**Claim.** Payments can be extracted with its own PostgreSQL database while the monolith keeps
`orders`, by making every money effect an idempotent command and every order-status change a
callback to the order owner.

**Alternative rejected.** Keep the money tables in the monolith and extract only a "wallet read"
service. That preserves the old code but leaves the most valuable write path, the webhook and the
commission split, inside the monolith. Letting the payments service write `orders.payment_status`
directly was also rejected: two services sharing one table is the distributed-monolith
anti-pattern, and it makes the boundary untestable.

**Evidence.** The monolith schema intentionally omits `payment_intents`, `transactions`,
`provider_wallets` and `webhook_events`. Every call goes through
`lib/modules/payments/client.js`; the service exposes the internal endpoints in B6 and the public
endpoints in B4. `scripts/verify-area-a.ps1` drives a real booking through payment, asserts exactly
one charge after a replayed webhook, and queries `payments_db` for the wallet row. The Pact consumer
test `test/pact/payments.pact.test.js` pins the intent write and the wallet read, including the
`Idempotency-Key` header.

**Tradeoff accepted.** The monolith now has a synchronous dependency for wallet reads, intents and
settlement; a payments outage makes those endpoints return 502/503. We removed that risk for ledger
writes with the durable command seam below, and accept it for reads because stale money data is
worse than an error.

#### Seam 3 — Asynchronous event seam (outbox → RabbitMQ)

**Claim.** The monolith can stop calling Notifications for domain events and publish from an outbox
instead, giving at-least-once delivery with a deduplicating consumer and no lost events when the
broker is briefly down.

**Alternative rejected.** Publish directly to RabbitMQ inside the request handler. It is simpler, but
it has a dual-write failure: the database commit can succeed and the publish can fail, leaving a
changed order with no event. Synchronous fan-out with retries was also rejected because it couples
availability and makes the booking transaction wait for a notification.

**Evidence.** `events` is written in the same SQLite transaction as the state change
(`lib/db/events.js`, used by booking, review, admin and saga code). The relay claims rows with a
conditional update, publishes with publisher confirms, and releases the claim on failure. Duplicate
delivery is proven by `test/area-c-events.test.js` and by `scripts/verify-area-c.sh`: redelivering
the same envelope creates one notification row. Beat 1 shows the whole chain (admin approval → saga
row → outbox → RabbitMQ → notification readable through the service); Beat 4 shows the publish and
consume spans in one trace.

**Tradeoff accepted.** Every consumer must be idempotent forever, the system gains a broker and a
polling relay, and events are eventually consistent: a notification can lag a booking by seconds.
That is acceptable because notifications are not transactional data, and the outbox is the standard
way to avoid the dual-write bug.

**Why RabbitMQ, not Kafka.** The workload is low-volume task dispatch with per-message
acknowledgement, few consumers and no need for replayable log retention. RabbitMQ's routing,
dead-lettering and per-message acks fit that shape and the course's operations budget. Kafka would
add partitions, consumer groups and a retention model we would not use. This is a "not at our size"
decision, not a claim that Kafka is worse.

#### Seam 4 — Durable ledger command seam (Area D)

**Claim.** Completing or cancelling a booking can survive a payments outage, a lost reply and a slow
reply with exactly one wallet effect, by writing a durable command in the same SQLite transaction as
the order change and retrying it with a stable idempotency key.

**Alternative rejected.** A synchronous call with client retries only. It handles a lost reply, but
it cannot survive an outage longer than the retry budget and can leave an order completed with no
wallet credit. A separate queue worker adds a process and a deployment unit for a two-step write the
monolith can own durably in SQLite.

**Evidence.** `ledger_commands` is written inside the booking transaction
(`lib/modules/booking/service.js` calls `enqueueLedgerCommand`), and
`lib/modules/payments/ledger-queue.js` tries the HTTP call immediately, records failures and lets
`startLedgerReconciler()` retry every 3 seconds. `scripts/beat2-failure-recovery.sh` injects the three
mandated faults through the payments service's internal control endpoint. Our final clean-boot run
passed all 20 assertions: lost reply survived with HTTP 200 after 162 ms; reply slower than the
client's 3 s timeout survived after 3230 ms; a 9 s payments outage survived with HTTP 200 after
616 ms. In every case the order remained completed, the durable command was marked done once, and
`payments_db` held exactly one ledger row for that order. The client
(`lib/modules/payments/client.js`) uses `AbortSignal.timeout(3000)`, three attempts,
`random() * min(4000, 250 * 2^(attempt-1))` (exponential backoff with full jitter), and retries only
transport, timeout and 5xx failures.

**Tradeoff accepted.** Recovery is seconds, not milliseconds, because the reconciler polls. A total
monolith outage pauses reconciliation until restart; the command is still durable, so it is delayed,
not lost. The in-process reconciler is not a general-purpose job system; if ledger work grew beyond
one command type we would move it to a real worker. The property we needed is durability before the
network call, and that is proven.

#### Seam 5 — Trace-context seam

**Claim.** One trace can cross both the HTTP and RabbitMQ boundaries if trace context is part of each
contract, stored with the outbox row and carried in AMQP headers, rather than generated independently
by each process.

**Alternative rejected.** Let each service start its own trace and correlate with timestamps and
request ids. That produces two or three unrelated traces per booking and makes the asynchronous half
impossible to join. Propagating only `x-request-id` identifies a request but not parent-child
relationships, so it cannot show where time went.

**Evidence.** `lib/telemetry.js` extracts a strict `00-<32hex>-<16hex>-<2hex>` `traceparent` and
ignores malformed or all-zero ids. `lib/http/handle.js` starts the server span and returns
`x-trace-id` and `traceparent`. `events.trace_parent` stores the producing request's context; the
relay starts a PRODUCER span parented to it and `lib/messaging/rabbit.js` puts the `traceparent` in
the message headers. The notifications consumer starts a CONSUMER span from the header. Beat 4 found
one trace with 9 spans across `edemand`, `payments` and `notifications` and `ORPHANS=0`; trace
`7b95577683956bd6366a2d9c24896f22` contains `POST /api/bookings`,
`POST /internal/payment-intents`, `publish booking.status_changed` and
`process booking.status_changed`.

**Tradeoff accepted.** Every boundary carries one more header or field, and a malformed `traceparent`
is dropped rather than trusted. Tracing is disabled unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so
tests and local development do not depend on Jaeger. The extra instrumentation and the batch
exporter's few-second delay are worth being able to answer "which service waited?" from evidence.

---

## 3. Contracts

### 3.1 The contract styles we use

A boundary is only real if its contract is written down and tested. We use four styles, each for a
different risk:

| Style | Where | What it protects |
|---|---|---|
| HTTP/JSON with zod validation | All public and internal endpoints | Shape, types, required fields and error semantics |
| Consumer-driven Pact contracts | Monolith → notifications; monolith → payments | The consumer's expectations, including headers, so a provider change breaks CI |
| Event envelope + projection rules | Outbox → RabbitMQ → consumers | Event identity, `event_uid`, `saga_id` and trace headers |
| Operational contracts | `/health`, `/metrics`, OTLP, JWKS | Health, scrape format, trace context, token verification |

### 3.2 HTTP contracts

Public routes keep their pre-extraction paths and shapes:

- `GET /api/notifications` and `POST /api/notifications/:id/read` → notifications service. Require a
  bearer token; ownership is enforced in the service.
- `GET /api/provider/wallet` and `GET /api/customer/transactions` → payments service. Require a
  provider or customer token.
- `POST /api/payments/webhook` → payments service. Requires `x-webhook-secret`; `gateway_event_id`
  is UNIQUE in `webhook_events`.
- `POST /api/internal/orders/:id/payment-status` → monolith. Internal key only; idempotent by
  `(order_id, gateway_event_id)`.

Internal commands are not public: nginx returns 404 for `/api/internal`, `/internal` and `/metrics`,
so an endpoint that exists only on the compose network cannot be called by a browser.

Error semantics are stable: 400 validation, 401 missing/invalid/expired token, 403 valid token
without ownership, 404 missing or hidden resource, 409 a domain duplicate, 502 an upstream failure.
The 401/403 distinction matters in Beat 3: an unrelated customer gets 403 on a job, not 401, because
the token is valid and the decision is authorisation.

### 3.3 Pact consumer contracts

`test/pact/notifications.pact.test.js` and `test/pact/payments.pact.test.js` drive the **real**
monolith client against a Pact mock provider. They write:

- `pacts/edemand-monolith-notifications-service.json`
- `pacts/edemand-monolith-payments-service.json`

The payments contract pins both the internal write (`POST /internal/payment-intents`, 201
`{intent:{...}}`, `x-internal-key`, `x-request-id`, `idempotency-key` matching
`payment-intent:\d+`) and the public read (`GET /api/provider/wallet`). The notifications contract
pins the inbox shape and confirms the forwarded bearer token. This is deliberately consumer-driven:
the provider is free to change internals as long as the consumer's expectations still hold.

`npm run test:pact` passes 2/2 locally. `.github/workflows/ci.yml` has a separate `contracts` job
that runs the same command and uploads `pacts/` as an artefact. We ran it locally with:

```bash
act pull_request -j contracts
```

The upload step is guarded with `if: ${{ env.ACT != 'true' }}` because act does not provide GitHub's
artefact service. The guard does not hide a contract failure: the Pact step itself still fails the
job. The `test` job runs the unit suite and the `build` job runs `next build`, so a change that
breaks the build, the concurrency tests or a consumer expectation cannot merge silently.

### 3.4 Event contracts

Every event is an envelope with a stable UUID, not the SQLite autoincrement id:

```json
{
  "event_uid": "0f0c...",
  "type": "booking.status_changed",
  "aggregate_type": "order",
  "aggregate_id": 8001,
  "payload": { "order_id": 8001, "status": "completed", "saga_id": null },
  "occurred_at": "2026-11-12T..."
}
```

The UUID is the dedupe key because the SQLite id restarts at 1 after a reseed. Notifications stores
`source_event_id` with a UNIQUE constraint on
`(source_event_id, recipient_role, recipient_id, type)`, so the same event delivered twice produces
one row. Saga outcomes add `saga_id`, which lets the monolith complete or compensate the right
workflow.

The broker topology is a durable topic exchange `edemand.events` with durable queues
`edemand.notifications` and `edemand.sagas`. The relay uses publisher confirms; consumers ack only
after the local transaction commits and nack/requeue on failure. That is the contract that makes
"at-least-once delivery, idempotent effect" true rather than aspirational.

### 3.5 Operational contracts

- `GET /health` on each service returns 200 when the process can serve and, for the extracted
  services, when the JWKS is loaded. Compose uses it for `depends_on` and `--wait`.
- `GET /metrics` returns Prometheus text format with the shared metric names and a `service` label.
- OTLP/HTTP goes to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`; if the variable is absent, tracing is
  a no-op.
- Keycloak's realm JWKS is fetched at `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`.
  Tokens must have the configured issuer and audience; the signing algorithm is RS256.

---

## 4. Security model

### 4.1 Identity and token issuance

Keycloak is the only production token issuer. The realm `edemand` is imported from
`keycloak/realm-edemand.json` on every boot, with deterministic clients, roles, users and protocol
mappers. The monolith does not mint demo tokens; it obtains them from Keycloak. This replaces the
original monolith's locally signed HS256 tokens.

Tokens are RS256 and carry `iss=http://localhost:8081/realms/edemand` and audience `edemand-api`.
The fixed hostname matters: the same token must verify whether it was requested from the host or from
inside the compose network, so `KC_HOSTNAME` pins the issuer rather than letting the container's
internal name leak into `iss`.

### 4.2 Verification at every boundary

Each process verifies tokens independently: the monolith uses the realm JWKS (with a test-only HS256
path when `KEYCLOAK_URL` is absent, so `node --test` works without Keycloak); the notifications and
payments services verify the forwarded token themselves. No service trusts a header such as
`x-user-id` from the gateway. The gateway forwards `Authorization`; it does not authenticate. That is
the difference between a gateway and a security boundary: nginx routes, the services decide.

Beat 3 proves the model with 17 assertions: a real Keycloak token is accepted by the monolith and an
extracted service; forged, wrong-audience and expired tokens are rejected with 401 by both; another
user cannot mark the provider's notification read; an unrelated customer cannot read a job they do
not own (403) while the owner can; a provider may still browse an open job, which is a legitimate
marketplace rule.

### 4.3 Ownership and the inherited BOLA

The supplied monolith had a broken object-level authorisation on `GET /api/jobs/{id}`: any
authenticated user could read any job. Ownership was implicit in the UI, not enforced in the API.
The fix requires the caller to be the job's customer, the assigned provider, or a provider looking
at an open job. Beat 3 shows the attack now returns 403 where it used to return 200, and the
legitimate owner still gets 200. The extracted services enforce the same rule internally:
notifications queries by the verified token's `recipient_role` and `recipient_id`; payments queries
the wallet by the verified token's `provider_id`, never by a query string.

### 4.4 Internal boundaries

Service-to-service endpoints use a shared `INTERNAL_API_KEY` and are unreachable through the
gateway. That is not a substitute for network policy; a real deployment would use a private network
and mTLS or workload identity. At this size the key plus "no published port" is proportionate, and
the demo proves nginx returns 404 for `/internal` and `/api/internal`. The webhook has its own
`x-webhook-secret` and is idempotent by `gateway_event_id`; it is called by the gateway, not a user.

### 4.5 Secrets

All secrets and settings come from environment variables. `.env.example` documents them; no real
secret is committed. The compose defaults are demo values and are labelled as such
(`dev-internal-key-change-me`, `edemand-webhook-secret`). The course requirement is that values are
injectable and not hard-coded, which they are.

### 4.6 What we did not build

We did not build fine-grained scopes, revocation lists, rate limiting, WAF rules or mTLS. Those are
real production concerns, but adding them would hide the boundary behaviour behind infrastructure.
The security model we defend is the one the brief asks for: Keycloak-issued tokens, independent
verification, ownership checks, one inherited BOLA fixed, and internal endpoints closed at the edge.

---

## 5. Consistency model

### 5.1 The rule: one writer per table

The migration's central consistency rule is that each table has exactly one owning service. The
monolith owns `orders`; payments owns the money tables; notifications owns the inbox. No service
opens a second connection to another service's database. This is what makes the boundaries
enforceable and what lets each service choose its own transaction model.

The cost is that cross-context operations are no longer one ACID transaction. We handle that with
three patterns, each matched to the risk:

1. **Outbox + at-least-once events** for state changes that other contexts need to observe
   (booking status, provider approval, review created).
2. **Idempotent commands** for writes that must happen exactly once in effect (payment intent,
   ledger credit, webhook settlement).
3. **Sagas with compensation** for a multi-step workflow with a reversible local step (provider
   approval).

### 5.2 Outbox

The outbox row is written in the same SQLite transaction as the state change. A relay claims
unprocessed rows with a conditional update, publishes to RabbitMQ with confirms, then marks the row
processed; if the publish fails, it releases the claim and the next pass retries. The consumer
dedupes on `event_uid` (and on the notification's natural key), so a redelivery after a crash is
harmless. This is **at-least-once delivery with an idempotent effect**, not exactly-once delivery:
exactly-once over a network is a property of the effect, not of the transport. The evidence is
`test/area-c-events.test.js` and `scripts/verify-area-c.sh`: the same envelope delivered twice
creates one notification row.

### 5.3 Idempotency

There are two layers, deliberately:

- **Transport idempotency.** Every logical write carries a stable `Idempotency-Key`
  (`payment-intent:<order>`, `booking-completed:<order>`, `booking-cancelled:<order>`,
  `webhook:<gateway_event_id>`, `wallet:<provider>`). The payments service stores the key and the
  response in `idempotency_keys`; a replay returns the stored response instead of writing again.
  The monolith keeps the same key across retries and reconciler replays.
- **Domain idempotency.** The money tables keep their own UNIQUE keys: `payment_intents.order_id`,
  `transactions (order_id, kind)` and `webhook_events.gateway_event_id`. Even two different keys that
  race cannot double-credit, because the database refuses the second row.

The second layer matters because the first can be bypassed by a bug or a new caller. The database is
the last line of defence.

### 5.4 Durable ledger commands

Completing a booking does three things in one SQLite transaction: update `orders` and set
`completed_at`; insert the `booking.status_changed` outbox event; insert a `ledger_commands` row for
the payout/commission command. After commit, the monolith tries the payments service immediately.
If that fails, the row stays pending and the reconciler retries every 3 seconds with the same
idempotency key, so a retry after a lost reply is observed once. `ledger_commands` has UNIQUE
`(order_id, kind)`, so the same logical command cannot be queued twice. This is the answer to "what
if the service is down for a time window": the order and the money command are already durable, and
the network is just a retryable delivery mechanism.

### 5.5 Saga with compensation

Provider approval is orchestrated by the monolith. In one transaction it flips the provider to
approved, inserts a `sagas` row in `awaiting_notification`, and writes the `provider.approved`
outbox event. Notifications consumes the event, creates the welcome notification, and publishes
`notification.created` or `notification.failed`. The monolith's saga consumer completes or
compensates: `notification.created` marks the saga completed; `notification.failed` marks it
compensated, unapproves the provider and writes `provider.approval_reverted` in the same
transaction. The compensation is a real business action, not a log line: the provider returns to the
unapproved state so the admin can retry. A duplicate outcome matches the conditional update zero
times and changes nothing.

**Orchestration vs choreography.** We chose orchestration. Approval is a short, fixed sequence with
one clear owner and one compensating action; putting it in one place makes it readable and testable
and avoids every participant inferring the flow from an event stream. Choreography is better for a
long-lived workflow with many participants that changes often, not for a three-step onboarding flow.

### 5.6 What is eventually consistent, and why that is acceptable

- A booking's notification appears after the relay publishes and the consumer projects: seconds, not
  milliseconds.
- The provider's wallet after completion is updated by the ledger command; the order is completed
  immediately and the wallet catches up.
- A saga outcome can arrive after the admin's HTTP response; the admin sees `awaiting_notification`
  until it lands.

None of these lose a booking or money. The durable business fact (the order change) commits first;
derived facts (notification, wallet, saga state) converge. A derived fact that must not be lost is
written durably before the network call.

---

## 6. Failure model

### 6.1 The three mandated failures

The brief names three failures for Area D. We implemented each as an internal fault switch in
`payments-service/faults.js`, reachable only through `POST /internal/faults` with the internal key:

| Switch | What it does | What the caller should observe |
|---|---|---|
| `lost_reply` | Commits the write, then destroys the socket before responding | Transport error; the retry with the same key returns the stored result; one effect |
| `slow_reply_ms` | Commits the write, then delays the response past the 3 s client timeout | Timeout; the retry with the same key returns the stored result; one effect |
| `outage_ms` | Fails every request with 503 for a window, before any write | Order commits; the durable command stays pending; the reconciler drains it after the window; one effect |

`lost_reply` and `slow_reply_ms` are one-shot so the retry sees a normal service and proves the retry
path. The outage is time-based because that is what an outage is.

Our final clean-boot run of `scripts/beat2-failure-recovery.sh` passed 20 assertions:

```
lost reply:      HTTP 200 after 162 ms,  order completed, 1 ledger row, command done
slow reply:      HTTP 200 after 3230 ms, order completed, 1 ledger row, command done
9 s outage:      HTTP 200 after 616 ms,  order completed, 1 ledger row, command done
```

The slow-reply number is the useful one: the client's timeout is 3000 ms, so a 3230 ms request is
evidence that the first attempt timed out and the retry succeeded, not that the service answered
quickly. The outage number is less than the 9 s window because the order write does not wait for the
payments service; the response is the booking completion, and the wallet converges later.

### 6.2 Timeouts, retries and jitter

`lib/modules/payments/client.js` applies:

- a 3000 ms timeout via `AbortSignal.timeout`;
- at most 3 attempts (`PAYMENTS_MAX_ATTEMPTS`);
- retry only for transport errors, timeouts and 5xx responses; a 4xx is a decision and escapes
  immediately;
- exponential backoff with full jitter:
  `delay = random() * min(4000, 250 * 2^(attempt-1))`.

Full jitter is not decoration. If a fleet of clients retries in lockstep after an outage, the retry
wave recreates the outage. Jitter spreads the retries over the backoff window; full jitter costs
nothing at this workload size.

### 6.3 Crash and redelivery

- **Monolith crash after commit, before publish.** The outbox row is committed, so the relay
  publishes on restart. At-least-once.
- **Monolith crash after enqueueing a ledger command.** The row is committed, so the reconciler
  retries on restart. At-least-once.
- **Notifications crash after writing, before ack.** RabbitMQ redelivers; the UNIQUE
  `source_event_id` key makes the second write a no-op.
- **Saga consumer crash after completing, before ack.** Redelivery matches the conditional update
  zero times; the state stays completed.
- **Payments crash after commit, before response.** The idempotency record commits with the effect;
  the retry returns the stored response.

### 6.4 Dependency failure and health

Compose `depends_on` uses health checks, not just start order. The monolith waits for RabbitMQ to be
healthy and Keycloak to be started, then retries the JWKS fetch until the realm is available.
Notifications and payments wait for their databases, Keycloak and (for payments) the monolith.
`docker compose up --wait` therefore means "the system can serve", not "the containers exist".

At runtime the behaviour is explicit: payments unreachable for a read gives 502 at the monolith
edge; unreachable for a ledger write still completes the order and retries the command;
notifications unreachable for a read gives 502 and bookings continue; RabbitMQ unreachable leaves
events pending in the outbox; Keycloak unreachable at boot keeps health red and the gateway sends no
traffic.

### 6.5 The race we fixed

Customer/provider registration was a read-then-insert: `findCustomerByEmail()` followed by `INSERT`.
Two simultaneous requests both read null, both inserted, and the second received a raw
`SQLITE_CONSTRAINT_UNIQUE`, which the HTTP layer turned into a 500. The sequential path returned 409,
so the API was inconsistent under concurrency.

The fix in `lib/modules/identity/repository.js` lets the index be the arbiter and translates
`SQLITE_CONSTRAINT_UNIQUE` into `ConflictError` (409). `test/identity-race.test.js` opens two worker
threads on the same file database, holds `BEGIN IMMEDIATE` while both pass the advisory check, then
releases the lock. The result is exactly one 201, one clean 409 and one row. We ran the test with the
translation disabled to confirm it fails with `sqlite constraint failed: customers.email` before the
fix, then passes with it. Both requests are genuinely in flight at the same moment.

### 6.6 Residual risks we accept

- The reconciler is in-process; a long monolith outage delays ledger convergence until restart.
- The outbox relay is a poller; a very high event rate would need batching or a dedicated publisher.
- The internal key is a shared secret, not per-service identity.
- RabbitMQ is a single broker; there is no mirrored cluster.
- There is no dead-letter replay UI; a poison message is visible in the logs and the management
  console.

None of these silently loses a booking or double-credits a wallet; the failure modes are delay and
operator work, which is the correct trade at this scale.

---

## 7. How to operate and run it

### 7.1 First boot and reset

```bash
# one command, from the repository root
docker compose up -d --build --wait

# reset to first boot
docker compose down -v
```

`down -v` removes `notifications-db-data`, `payments-db-data`, `rabbitmq-data` and `grafana-data`.
The monolith's SQLite database is deleted and reseeded on every start, so booking ids return to
8001. The extracted databases persist across a normal `up` (that is the point of owning them), and
only `down -v` clears them. That asymmetry is the most common source of a confusing demo, so it is
documented in the README.

### 7.2 URLs and logins

| URL | Purpose |
|---|---|
| `http://localhost:3000` | The application, through nginx |
| `http://localhost:8081` | Keycloak admin console (`admin` / `admin`) |
| `http://localhost:15672` | RabbitMQ management (`edemand` / `edemand-demo-pass`) |
| `http://localhost:16686` | Jaeger trace UI |
| `http://localhost:9090` | Prometheus |
| `http://localhost:3005` | Grafana, anonymous admin, dashboard pre-provisioned |

Seeded users use the password `eDemand-2026!`: `nong@example.com` (customer),
`sparkle@example.com` (provider), and the admin account described in the README. The Keycloak realm
is deterministic, so these logins survive a clean boot.

### 7.3 The four demo beats

The README lists the exact expected output. On our run:

| Script | Result |
|---|---|
| `scripts/beat1-happy-path.sh` | 11 assertions, all pass |
| `scripts/beat2-failure-recovery.sh` | 20 assertions, all pass |
| `scripts/beat3-auth-rejection.sh` | 17 assertions, all pass |
| `scripts/beat4-find-the-trace.sh` | 12 assertions, all pass, 9 spans, `ORPHANS=0` |

Beat 1 walks one request across every boundary: the notifications service refuses an anonymous call,
admin approval drives the saga and the RabbitMQ projection, a gateway booking creates a payment
intent, "Pay now" settles it, and OTP completion writes exactly one payout row in Payments. Beat 2
injects the three faults and checks one order/one wallet effect each time. Beat 3 proves the token
and ownership model. Beat 4 makes one booking, reads the `x-trace-id`, waits for the asynchronous
half, and shows the monolith, payments and notifications spans in one Jaeger trace.

### 7.4 Observability

- **Traces.** OpenTelemetry in all three processes. One trace per request, continued across HTTP via
  `traceparent` and across RabbitMQ via the message headers and `events.trace_parent`. Tracing is
  off when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, so tests emit no spans. Jaeger's batch exporter
  means a trace can take a few seconds to appear; the beat script polls.
- **Metrics.** `http_requests_total` and `http_request_duration_seconds` with
  `service, method, route, status` labels, plus `notifications_events_projected_total` for consumer
  progress. Route labels are normalised (`/api/bookings/8001` → `/api/bookings/:id`) so ids do not
  explode the series count. Prometheus scrapes every 5 s; Grafana's **eDemand — services at a
  glance** dashboard shows request rate, error rate and p95 latency per service.
- **Logs.** pino JSON logs carry the request id and trace id. The gateway preserves a caller-supplied
  `x-request-id` or mints one, so a log line can be followed from nginx into the monolith and the
  extracted services.
- **Health.** `/health` is the compose check; the gateway publishes when all three are healthy.

`/metrics`, `/internal` and `/api/internal` are refused by nginx with 404, so the observability and
control surfaces are not public.

### 7.5 Tests and CI

- `npm test` / `node --test`: 78 tests pass (76 functional + 2 Pact files). The suite imports the
  real App Router handlers against per-file in-memory SQLite databases and needs no running server.
  It includes the booking slot race, the bid accept race, exactly-once credit, outbox and
  duplicate-delivery tests, saga compensation, and the Area D identity race.
- `npm run test:pact`: 2/2 consumer contracts, writes `pacts/*.json`.
- `npm run build` / `next build`: production build passes.
- `docker compose run --rm --build test`: the same unit suite inside the build image.
- `scripts/verify-area-a.ps1`: 32/32; `scripts/verify-area-c.sh`: 18/18. These run against the
  compose stack and are the deeper proofs for Areas A and C.
- `.github/workflows/ci.yml`: `test`, `contracts` and `build`. The `contracts` job was executed
  locally with `act pull_request -j contracts`.

The Docker `test` service is in a profile and is not started by `up --build`; `docker compose run
--rm --build test` is the supported command. The marker's one command should start the demo stack,
not a test container that exits.

### 7.6 Clean clone

The cold-boot rehearsal is part of the final check. The repository is cloned into a fresh directory,
`docker compose up -d --build --wait` is run with no pre-existing images for the project, and the
four beats are run in order. The only prerequisite is Docker Desktop with at least 8 GB available.
No cloud account, credit card or sign-up is needed.

Configuration is entirely environment-driven; `.env.example` is the reference. Compose defaults are
demo values; a real deployment overrides them.

---

## Industrial landscape table

The brief asks for every cross-cutting concern in our system, the technology that carries it at
scale, and the cost of adopting that technology. "At our size" is a judgement, not a compliment:
we name the industrial tool and say whether we would adopt it now.

| Cross-cutting concern | What we run | What carries it at scale | Cost of adopting at scale | At our size? |
|---|---|---|---|---|
| Identity and tokens | Keycloak 26, realm import, RS256 + JWKS | Keycloak or managed OIDC (Auth0, Entra ID) with rotation, federation, MFA, per-service clients | Runbook, key rotation, realm backup, user migration, licence or per-MAU fee, introspection latency | **Yes.** Real issuer/verifier separation at zero vendor cost; managed OIDC adds a bill without teaching more. |
| Edge routing | nginx 1.27, path routing, correlation id | Kong or Envoy with rate limits, mTLS, retries, circuit breaking, canaries; a cloud LB in front | Control-plane learning curve, plugin licensing, certificate management, policy testing, an extra hop | **nginx now.** We need path routing and one port, not a policy engine. Kong is for rate limits and canaries. |
| Synchronous service calls | `fetch` with timeout, retries, full jitter, `Idempotency-Key` | gRPC with deadlines and interceptors, or a service mesh (Istio/Linkerd) with mTLS, retries and circuit breaking | Protobuf toolchain, mesh sidecars (memory and CPU per pod), control-plane operations, harder debugging | **No mesh.** Three services and one hot call do not justify sidecars; we already have a deadline and an idempotent retry. |
| Asynchronous messaging | RabbitMQ 3.13, durable topic exchange, publisher confirms, consumer acks | Kafka with partitions and replayable retention; or SNS/SQS with managed scaling | Partition and consumer-group design, retention storage, schema registry, rebalance operations, higher baseline memory | **RabbitMQ.** Task dispatch, not a replayable log; Kafka's cost buys nothing we need. This is the brief's Kafka defence. |
| Transactional outbox | SQLite `events` + polling relay + conditional claim | Debezium/CDC from the database log, or a high-throughput outbox relay | Connector operations, schema-change coupling, another cluster, exactly-once still not free | **Polling relay.** Invisible at our rate; CDC is for when polling is a bottleneck. |
| Idempotency | `idempotency_keys` table, stable keys, stored responses; domain UNIQUE constraints | Redis/DynamoDB idempotency store with TTL and per-tenant keys, or a gateway idempotency filter | Extra datastore, expiry policy, key design, consistency between store and database | **Database table.** Transactional with the effect, stronger than a cache; Redis adds a consistency window. |
| Durability of cross-service commands | `ledger_commands` in SQLite + in-process reconciler every 3 s | Temporal, Camunda or a durable queue worker with visibility timeouts and dead-letter queues | Workflow engine to operate, versioning, a new programming model, cluster cost | **In-process reconciler.** One command type does not need an engine; Temporal is for many long-lived workflows. |
| Sagas and compensation | Hand-written orchestration, `sagas` table, conditional updates | Temporal/Camunda for durable execution; choreography with a schema registry and event contracts | Engine operations, workflow versioning, testing strategy, team learning | **Hand-written.** Three steps and one compensation; an engine would be more to operate than to replace. |
| Service databases | PostgreSQL 15 per service; SQLite for the monolith | Managed PostgreSQL (RDS/Cloud SQL) with replicas, PITR, PgBouncer | Monthly instance cost, backup/restore drills, failover, pooling, migration tooling | **Local PostgreSQL.** Production semantics without a bill; managed replicas and PITR come first later. |
| Schema migration | Idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER` at boot | Flyway, Liquibase, Atlas or Prisma Migrate with versioned migrations and review | Migration review, rollback strategy, drift detection, CI checks | **Boot-time DDL.** Deterministic for a demo but our weakest choice; versioned migrations are needed before a destructive change. |
| Tracing | OpenTelemetry SDK, OTLP/HTTP, Jaeger all-in-one | OTel Collector fleet, Tempo/Jaeger with object storage, tail-based sampling, trace-to-log correlation | Collector operations, storage cost, sampling policy, cardinality control | **Jaeger all-in-one.** One trace across three services is the goal; sampling matters when volume does. |
| Metrics | prom-client, `/metrics`, Prometheus 2.55 | Prometheus with remote write or Mimir/Thanos, recording rules, long-term storage | Storage and compaction, HA pairs, remote-write pipeline, cardinality governance | **Single Prometheus.** A 5 s scrape of three targets is trivial; long-term storage adds a second system. |
| Dashboards and alerting | Grafana 11, provisioned dashboard | Grafana with folders, alert rules, on-call routing (PagerDuty/Opsgenie), SLOs | Alert tuning, on-call cost, dashboard ownership, noise | **One dashboard.** It shows exactly rate, errors and latency per service; alerting is a human process. |
| Contract testing | Pact 13 consumer tests, two contracts, CI job | Pact Broker or PactFlow with can-i-deploy, provider verification in every pipeline, version tags | Broker hosting, webhook plumbing, provider harness, versioning discipline | **Local Pact files + CI.** Two consumers and two providers do not need a broker. |
| CI | GitHub Actions, `act` locally | Actions matrix, reusable workflows, self-hosted runners, SLSA provenance | Runner cost, cache management, secret distribution, build minutes | **Three jobs.** Unit, contracts and build are the three risks; a matrix would be noise. |
| Secrets | Environment variables, `.env.example`, demo defaults | Vault, AWS Secrets Manager, sealed secrets, workload identity | Vault operations/unsealing, rotation, audit, IAM design | **Env vars.** Injectable and not committed, as the brief requires; Vault comes with real credentials. |
| Service discovery | Compose DNS (`payments`, `notifications`) | Kubernetes DNS + services, Consul, or a mesh | Control plane, health integration, network policy, debugging | **Compose DNS.** Enough for one host; Kubernetes is a platform, not a missing library. |
| Rate limiting and abuse | Not implemented; nginx `client_max_body_size` | Gateway rate limits, token buckets, WAF, bot detection | Policy design, false positives, per-tenant quotas, edge cost | **Not now.** No hostile traffic in the demo; a known gap, listed honestly. |
| Log aggregation | pino JSON to stdout, `docker compose logs` | Loki/ELK with retention, indexing and trace correlation | Storage cost, index tuning, retention policy, PII handling | **stdout.** No log cluster for three services; the trace id in every line is what matters. |
| Deployment | `docker compose up` on one laptop | Kubernetes/ECS with rolling deploys, probes, autoscaling, blue/green | Cluster cost, manifests/Helm, ingress, observability integration, on-call | **Compose.** The brief demands one command within 8 GB; Kubernetes would fail that constraint. |
| Backup and recovery | `down -v` resets; volumes persist otherwise | Managed PITR, cross-region replicas, restore drills | Storage and replication cost, RPO/RTO design, drill time | **Volume persistence.** No production data; the demo needs deterministic reset, and `down -v` gives it. |

The pattern is deliberate: we adopt the industrial tool where it teaches or protects something real
(Keycloak, RabbitMQ, PostgreSQL, OpenTelemetry, Prometheus, Grafana, Pact), and decline it where the
cost is operational and the benefit is not yet present (Kafka, a service mesh, Temporal, Kubernetes,
Vault, a log cluster). Declining is also a decision with a cost; section 6.6 lists the residual risks
we accept.

---

## Closing note

The migration is finished when the system still works at the same addresses, the moved data is
physically out of the monolith, the new boundaries reject bad tokens and bad ownership, events cross
without duplication, the three named failures are survived with one effect, and one trace shows the
whole request. The four demo scripts are the reproducible proof; the README records their output,
and this dossier records the decisions and tradeoffs behind them.

**AI assistant disclosure.** We used an AI assistant to help draft and edit prose, review consistency
between this dossier, the README and the scripts, and suggest test and instrumentation structure.
All code was reviewed and run by the team; all numbers, traces and test results cited here come from
our own runs, and the four-part defences are our own reasoning.
