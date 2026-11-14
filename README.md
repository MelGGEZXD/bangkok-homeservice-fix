# Bangkok Homeservice (eDemand) — DES428 capstone

An on-demand home-services marketplace that started as the supplied **Next.js monolith** and now
runs as a monolith **plus two extracted services**, each with its **own PostgreSQL database**, behind
one nginx gateway.

The monolith still owns the product: identity, catalog, provider profiles, booking, bidding, reviews
and the UI. Two bounded contexts moved out without changing a single public URL:

| Extracted context | Service | Own database | Public paths (unchanged) |
|---|---|---|---|
| Notifications | Express on `:3001` | `notifications_db` | `/api/notifications*` |
| Payments & Wallet | Express on `:3002` | `payments_db` | `/api/provider/wallet`, `/api/customer/transactions`, `/api/payments/webhook` |

Everything else in this repository is what makes those seams **defensible**: Keycloak-issued RS256
tokens verified independently by all three processes, a transactional outbox feeding RabbitMQ, a
compensating saga, three injected failures survived with exactly one money effect, one OpenTelemetry
trace across both seams, Prometheus/Grafana, and Pact consumer contracts.

---

## Submission at a glance

| Item | Value |
|---|---|
| Course | DES428 — Web Services and Service Architecture |
| System | Bangkok Homeservice (formerly **eDemand**; code identifiers keep the old name) |
| Baseline | Supplied Next.js 14 monolith, one process, one SQLite file |
| Final runtime | 11 Docker containers (monolith + 2 services + 2 DBs + gateway + Keycloak + RabbitMQ + Jaeger + Prometheus + Grafana) |
| Submission branch | `main` (development branch: `area-a-second`) |
| Submission tag | `capstone-final` |
| Repository | <https://github.com/MelGGEZXD/bangkok-homeservice-fix> |
| Team | 4 members, areas A–E — see [`OWNERS.md`](OWNERS.md) |
| Architecture dossier | [`docs/dossier.md`](docs/dossier.md) |
| API contract | [`openapi.yaml`](openapi.yaml) |
| Demo video | [capstone-demo.mp4](https://drive.google.com/file/d/1Jy2vS7yMZjrMLCkc5R1lBBx23fDAR02E/view?usp=sharing) — screen recording on Google Drive |

---

## Contents

1. [What changed, and what stayed](#what-changed-and-what-stayed)
2. [Prerequisites](#prerequisites)
3. [Quick start](#quick-start)
4. [URLs and logins](#urls-and-logins)
5. [Architecture](#architecture)
6. [Area A — two extractions](#area-a--two-extractions)
7. [Area B — security](#area-b--security)
8. [Area C — events, duplicate delivery, saga](#area-c--events-duplicate-delivery-and-the-saga)
9. [Area D — failures and idempotency](#area-d--timeouts-retries-idempotency-and-one-repaired-race)
10. [Area E — traces, metrics, contracts](#area-e--traces-metrics-dashboard-and-contract-tests)
11. [The four demo beats](#the-four-demo-beats)
12. [Verification matrix](#verification-matrix)
13. [Troubleshooting](#troubleshooting)
14. [Security notes](#security-notes)
15. [Design decisions and tradeoffs](#design-decisions-and-tradeoffs)
16. [Known limitations](#known-limitations)
17. [Team and ownership](#team-and-ownership)

---

## What changed, and what stayed

| Concern | Before (supplied monolith) | After |
|---|---|---|
| Public entry point | Next.js on `:3000` | **nginx gateway on `:3000`** |
| Notifications | SQLite table inside the monolith | Express service + `notifications_db` |
| Payments & Wallet | SQLite tables inside the monolith | Express service + `payments_db` |
| Identity | Monolith minted HS256 tokens with a local secret | **Keycloak** issues RS256 tokens; every process verifies JWKS locally |
| Domain events | Polled table / in-process delivery | Transactional **outbox → RabbitMQ** with publisher confirms |
| Provider approval | One local write | Orchestrated **saga** with a compensating action |
| Money under failure | Not exercised | Timeout + retry + full jitter, durable ledger commands, idempotency keys |
| Observability | Logs only | OpenTelemetry → Jaeger, Prometheus → Grafana |
| Contracts | None | **Pact** consumer contracts for both new boundaries |
| UI and public API | — | **Unchanged**; the app still opens at `http://localhost:3000` |

What deliberately **did not** change:

- The Next.js App Router UI, pages and route handlers that were not on the seam.
- The database engine for the monolith (SQLite, `better-sqlite3`) and its deterministic reseed.
- The public API shape, status codes and error envelope.
- Seed users, booking ids (first booking on a clean boot is always **8001**) and the demo flow.

The brief says to change the monolith only as much as the migration requires. We kept its language,
its UI and its public contract, removed the moved tables, and replaced the old in-process calls with
HTTP clients and an internal settlement callback.

---

## Prerequisites

### Required

| Requirement | Why |
|---|---|
| **Docker Desktop 4.x** with **Compose v2** (`docker compose version`) | Everything runs in containers; no cloud account, no local database install |
| **8 GB RAM** free for Docker | 11 containers, two PostgreSQL instances, Keycloak and the JVM-free observability stack |
| **~6 GB disk** | Images plus four named volumes |
| **Git** | Clone the tagged submission |
| Ports `3000`, `3005`, `5672`, `8081`, `9090`, `15672`, `16686`, `4318` free | Published host ports |

### Optional

| Requirement | Why |
|---|---|
| **Node.js 20** (`.nvmrc`) | Only for running `npm test` / `npm run dev` outside Docker. `better-sqlite3@11.10.0` has no prebuilt binary for Node 24 on Windows |
| **PowerShell** (Windows built-in, or PowerShell 7) | Run `scripts/verify-area-a.ps1`; the script is written for Windows PowerShell 5.1 and also runs under `pwsh` |
| **Git Bash** (Windows) | To run the four `scripts/beat*.sh` scripts locally |

> **Windows note.** In PowerShell, `bash` may resolve to `C:\Windows\System32\bash.exe` (WSL), which
> fails with `execvpe(/bin/bash): No such file or directory` when the WSL distro has no `/bin/bash`.
> Use Git Bash explicitly:
>
> ```powershell
> & "C:\Program Files\Git\bin\bash.exe" scripts/beat1-happy-path.sh
> ```
>
> Or run the same command from a Git Bash window. This affects only the demo scripts, not the stack.

### Published host ports

| Host port | Container | Purpose |
|---|---|---|
| `3000` | `gateway` (nginx) | **The only application entry point** |
| `3005` | `grafana` | Dashboards |
| `5672` | `rabbitmq` | AMQP (optional tooling) |
| `8081` | `keycloak` | Realm issuer, token endpoint, admin console |
| `9090` | `prometheus` | Metrics query UI |
| `15672` | `rabbitmq` | Management console |
| `16686` | `jaeger` | Trace UI |
| `4318` | `jaeger` | OTLP/HTTP collector |

The monolith, both Express services and both PostgreSQL databases publish **no host ports**. They are
reachable only on the compose network.

---

## Quick start

This is the whole setup. There is no database to install and no migration to run.

```bash
git clone https://github.com/MelGGEZXD/bangkok-homeservice-fix.git
cd bangkok-homeservice-fix
git checkout capstone-final

docker compose up -d --build --wait
docker compose ps
```

`--wait` returns only when every container with a healthcheck is healthy. A **clean first boot takes
2–4 minutes** because Keycloak imports the realm and both services wait for its JWKS before they
listen. Subsequent boots are faster.

Expected: **11 containers running**, with the nine healthchecked services `healthy`.

```text
gateway          running        edemand          healthy
notifications    healthy        payments         healthy
notifications-db healthy        payments-db      healthy
rabbitmq         healthy        keycloak         running
jaeger           healthy        prometheus       healthy
grafana          running
```

The two without a healthcheck are surfaced in the browser anyway: Keycloak's realm page and the
Grafana dashboard.

### Health check

```bash
curl -s http://localhost:3000/api/health
```

```json
{"status":"ok","service":"edemand","database":"up"}
```

### Reset to first boot

```bash
docker compose down -v
docker compose up -d --build --wait
```

`down -v` drops both extracted PostgreSQL volumes, the RabbitMQ volume and the Grafana volume. The
monolith reseeds SQLite on every start, so booking ids return to `8001` and the ecosystem is
byte-for-byte deterministic.

### Stop without losing data

```bash
docker compose down
```

### Run the tests (no running stack required)

```bash
docker compose run --rm test
```

Expected: **78 tests, 78 pass, 0 fail** (76 functional + 2 Pact contract files). The functional suite
boots its own in-memory SQLite databases and needs no running stack; the two Pact files start a local
mock provider and also need no external service.

### Configuration

Everything is environment variables, and [`.env.example`](.env.example) documents every knob with its
demo default. The compose file supplies working values without a `.env`, so a clean clone boots with
no configuration. Copy `.env.example` to `.env` only when you want to override something; the
comments explain which values must change for a real deployment.

---

## URLs and logins

### Open these for the demo

| # | URL | What it shows | Area |
|---|---|---|---|
| 1 | <http://localhost:3000> | The app through the gateway | A |
| 2 | <http://localhost:8081> | Keycloak realm, users, clients, RS256 keys | B |
| 3 | <http://localhost:16686> | One trace across all three services | E |
| 4 | <http://localhost:3005> | Request rate, error rate, p95 per service | E |
| 5 | <http://localhost:15672> | Exchange `edemand.events`, queues, consumers | C |
| 6 | <http://localhost:9090> | Scrape targets for all three services | E |

**Minimum for an individual defence: 4 tabs.** Add 5 and 6 for the full team.

### Seed accounts

Password for **every** application user: **`eDemand-2026!`**

| Email | Role | Notes |
|---|---|---|
| `nong@example.com` | customer | Main demo customer |
| `somchai@example.com` | customer | Used for the BOLA "unrelated customer" case |
| `aom@example.com` | customer | Third customer |
| `sparkle@example.com` | provider | Approved; wallet demo |
| `fixit@example.com` | provider | Approved; bidding demo |
| `glow@example.com` | provider | Starts **pending**; the approval saga approves it |
| `admin@edemand.test` | admin | Approves providers, reads sagas |

Login pages:

- Customer: <http://localhost:3000/login>
- Provider: <http://localhost:3000/provider/login>
- Admin: <http://localhost:3000/admin/login>

Keycloak admin console (inspect only): <http://localhost:8081/admin> → **`admin` / `admin`**.
RabbitMQ management: **`edemand` / `edemand-demo-pass`**. Both are demo defaults; see
[Security notes](#security-notes).

> The app does **not** log in through the Keycloak UI. The app's own forms forward credentials to
> Keycloak's token endpoint and store the returned token in an httpOnly cookie. Port `8081` is for
> inspecting the realm.

---

## Architecture

```text
                             browser / curl
                                   |
                                   v
                    +-------------------------------+
                    |   nginx gateway   :3000        |
                    |   the only app host port       |
                    +----+--------------+-----------+
                         |              |
     /api/notifications  |              |  /api/provider/wallet
                         |              |  /api/customer/transactions
                         |              |  /api/payments/webhook
                         v              v
              +------------------+   +----------------------+
              | notifications    |   | payments             |
              | Express :3001    |   | Express :3002       |
              +--------+---------+   +----------+-----------+
                       |                        |
              notifications_db            payments_db
                       ^                        ^
                       |    RabbitMQ            |
                       |    edemand.events      |
                       |    edemand.notifications
                       |    edemand.sagas
              +--------+------------------------+-----------+
              |  Next.js monolith :3000 (internal)            |
              |  SQLite + outbox + sagas + ledger_commands     |
              |  Keycloak JWKS verifier                        |
              +-----------------------------------------------+

  All three processes --OTLP/HTTP--> Jaeger :4318
  Prometheus :9090 --scrape /metrics--> monolith, notifications, payments
  Grafana :3005 --> Prometheus
```

### Runtime topology

| Service | Kind | Internal port | Host port | Owns | Area |
|---|---|---|---|---|---|
| `gateway` | nginx | 80 | **3000** | Routing, correlation id, internal-path denial | A |
| `edemand` | Next.js 14 | 3000 | none | UI, API, SQLite, outbox, sagas | — |
| `notifications` | Express | 3001 | none | `notifications_db` | A |
| `payments` | Express | 3002 | none | `payments_db` | A |
| `notifications-db` | PostgreSQL 15 | 5432 | none | `notifications` table | A |
| `payments-db` | PostgreSQL 15 | 5432 | none | Money tables | A |
| `keycloak` | Keycloak 26 | 8080 | 8081 | Realm, users, signing keys | B |
| `rabbitmq` | RabbitMQ 3.13 | 5672 / 15672 | 5672 / 15672 | Exchange and durable queues | C |
| `jaeger` | Jaeger all-in-one | 16686 / 4318 | 16686 / 4318 | Trace storage and UI | E |
| `prometheus` | Prometheus | 9090 | 9090 | Metrics scrape and storage | E |
| `grafana` | Grafana | 3000 | 3005 | Dashboards | E |

### One writer per table

This is the rule that makes the seams real, not cosmetic.

| Database | Tables | Owner |
|---|---|---|
| Monolith SQLite (`data/edemand.db`) | `categories`, `customers`, `providers`, `admins`, `provider_profiles`, `provider_timings`, `services`, `addresses`, `job_requests`, `orders`, `order_items`, `slot_holds`, `bids`, `reviews`, `events`, `sagas`, `idempotency_keys`, `ledger_commands` | Monolith |
| `notifications_db` | `notifications` | Notifications service |
| `payments_db` | `payment_intents`, `transactions`, `provider_wallets`, `webhook_events`, `idempotency_keys` | Payments service |

The monolith schema **does not create** `notifications`, `payment_intents`, `transactions`,
`provider_wallets` or `webhook_events`. If old code tried to read them, it would fail at SQLite. The
only way to reach that data is across the seam.

### The eight bounded contexts

Each context owns its tables. Nothing reads another context's tables through its own repository; it
goes through the owning context.

| # | Context | Owns | Responsibility |
|---|---|---|---|
| 1 | **Identity** | `customers`, `providers`, `admins` | Registration, login, Keycloak provisioning, `/me` |
| 2 | **Catalog** | `categories`, `services` | Provider services, browse/search, rating aggregate |
| 3 | **Provider Profile** | `provider_profiles`, `provider_timings` | Approval, commission, weekly availability |
| 4 | **Booking** | `orders`, `order_items`, `slot_holds`, `addresses` | Place-booking transaction, status machine, OTP completion |
| 5 | **Bidding** | `job_requests`, `bids` | Custom jobs, bids, the accept race |
| 6 | **Payments & Wallet** | `payment_intents`, `transactions`, `provider_wallets`, `webhook_events`, `idempotency_keys` in **`payments_db`** | Intents, idempotent webhook, commission split |
| 7 | **Reviews** | `reviews` | One review per completed booking; emits `review.created` |
| 8 | **Notifications** | `notifications` in **`notifications_db`** | Inbox, ownership check, event → notification projection |

Shared infrastructure (not a context): `events` (outbox), `sagas`, `ledger_commands`, monolith
`idempotency_keys`.

### Directory map

```text
app/                      UI pages ((customer) (provider) (admin)) + api/** route handlers
lib/
  http/                   handle, respond, auth, keycloak (JWKS), validate, session
  db/                     index, schema, migrate, seed, bootstrap, events, idempotency
  messaging/              rabbit.js (connection + confirms), publisher.js (outbox -> broker)
  modules/<context>/      repository.js + service.js
                          booking/slots.js, payments/client.js, payments/ledger-queue.js,
                          notifications/relay.js, notifications/client.js, sagas/*
  telemetry.js            OpenTelemetry bootstrap
notifications-service/    Express service: app.js, db.js (Postgres), auth.js, keycloak.js,
                          broker.js (RabbitMQ consumer), notification-rules.cjs, faults.js
payments-service/         Express service: app.js, db.js (Postgres), auth.js, keycloak.js
gateway/nginx.conf        public prefixes -> extracted services, everything else -> monolith
keycloak/                 realm-edemand.json (users, roles, clients, mappers)
observability/            prometheus.yml + Grafana provisioning and dashboard
test/, test-helpers/      node:test suite driving the real route handlers in-process
test/pact/                Pact consumer contracts
scripts/                  four beats + Area A and Area C verification
docs/                     dossier.md
```

---

## Area A — two extractions

**Claim:** two bounded contexts can leave the monolith without changing a public address or leaving a
moved table behind, because each has one owner, its own database, and a contract at the boundary.

The brief requires **two** parts moved, each into its own service with its own database, and at least
one must **change data**. Both extractions write:

| Extracted service | Public prefix | Own database | Writes data? |
|---|---|---|---|
| Notifications | `/api/notifications*` | `notifications_db` | Yes: creates and marks notifications |
| Payments & Wallet | `/api/provider/wallet`, `/api/customer/transactions`, `/api/payments/webhook` | `payments_db` | Yes: intents, ledger entries, wallet balances, webhook dedupe |

### A.1 — Notifications

| The four boundary questions | Answer |
|---|---|
| **Name** | Notifications |
| **What crosses** | *Inbound:* domain events from RabbitMQ (Area C), plus the legacy internal command `POST /internal/notifications` (shared `X-Internal-Key`). *Outbound:* `GET /api/notifications`, `POST /api/notifications/:id/read`, carrying the caller's JWT. |
| **Ownership** | The service owns `notifications` in its own PostgreSQL database. The monolith schema drops the legacy SQLite table and has no notifications repository. |
| **Decision** | Extract the lowest-risk context first: asynchronous, one small table, no synchronous caller on the booking hot path. |

Why this seam, not Providers or Booking? The assignment table suggests Providers and Booking, but
this system's own analysis ranks Notifications first: it owns one table and has no synchronous
hot-path caller. Booking and Bidding share the `slot_holds` UNIQUE guard, so splitting them first
turns a free single-database invariant into distributed reservation. The dossier records that
tradeoff explicitly.

What makes the cut real:

- **Same public address.** nginx publishes `:3000` and routes `/api/notifications*` to the service.
  The UI page `/notifications` is still at the same URL and fetches the service with the browser's
  httpOnly JWT.
- **Idempotent delivery.** Every event carries the outbox UUID (`source_event_id`). The table has
  `UNIQUE (source_event_id, recipient_role, recipient_id, type)` and inserts with
  `ON CONFLICT DO NOTHING`, so at-least-once delivery has exactly one effect.
- **The service checks the token itself.** `notifications-service/auth.js` verifies the Keycloak
  RS256 token against the realm JWKS and derives the recipient from the token, never from a query
  string. Mark-read also checks ownership and returns `403` for someone else's row.
- **Approval is still atomic.** `approveProvider` writes the flag flip, the `provider_approval` saga
  row and the `provider.approved` outbox event in one SQLite transaction. The monolith never writes
  the moved table.

Proof:

```bash
# Anonymous call answered by the extracted service, not the monolith: no requestId in the body.
curl -i http://localhost:3000/api/notifications

ADMIN=$(curl -s -X POST http://localhost:3000/api/auth/admin/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@edemand.test","password":"eDemand-2026!"}' | jq -r .token)
curl -s -X POST http://localhost:3000/api/admin/providers/3/approve \
  -H "authorization: Bearer $ADMIN"

sleep 2
GLOW=$(curl -s -X POST http://localhost:3000/api/auth/provider/login \
  -H 'content-type: application/json' \
  -d '{"email":"glow@example.com","password":"eDemand-2026!"}' | jq -r .token)
curl -s -H "authorization: Bearer $GLOW" http://localhost:3000/api/notifications
```

Expected: one `provider_approved` notification, served from PostgreSQL. The monolith SQLite file has
no `notifications` table. (The snippets use `jq` to pick tokens; the beat scripts avoid that
dependency by parsing with Node.)

### A.2 — Payments & Wallet

| The four boundary questions | Answer |
|---|---|
| **Name** | Payments & Wallet |
| **What crosses** | *Inbound from the monolith:* `POST /internal/payment-intents`, `POST /internal/wallets`, `POST /internal/ledger/booking-completed`, `POST /internal/ledger/booking-cancelled`, `POST /internal/simulate` (shared `X-Internal-Key`). *Inbound from clients:* `GET /api/provider/wallet`, `GET /api/customer/transactions` (JWT, verified by the service) and `POST /api/payments/webhook` (`X-Webhook-Secret`). *Outbound:* `POST /api/internal/orders/:id/payment-status`, so the order owner learns the money settled. |
| **Ownership** | `payment_intents`, `transactions`, `provider_wallets`, `webhook_events` and `idempotency_keys` live in **`payments_db`**. The monolith schema drops all four money tables and has no payments repository. |
| **Decision** | Second extraction because it is the highest-write context with a genuinely separate aggregate: money rows never need a join back into `orders`. It also gives Area D a real idempotency target and Area C a real participant. |

Why this one, not Catalog or Provider? Provider data is joined by `services`, `orders`, `bids` and
`job_requests`; extracting it first forces cross-service reads into the hot booking path. Money rows
are referenced only by `order_id`, so the seam is narrow and the write volume justifies the split.

What makes the cut real:

- **Same public addresses.** Wallet, ledger and webhook URLs are unchanged. `/api/payments/simulate`
  deliberately stays on the monolith, because only the monolith owns `orders` and can prove the
  caller is the customer before money moves.
- **The monolith cannot touch the rows.** `lib/db/schema.js` does not recreate the four tables, and
  `lib/modules/payments/` contains only an HTTP client — no SQL. Provider registration calls
  `POST /internal/wallets`; booking completion calls the ledger endpoint.
- **Exactly-once money writes.** `payment_intents.order_id` is `UNIQUE`; `transactions(order_id, kind)`
  is `UNIQUE`; `webhook_events.gateway_event_id` is the replay key.
- **The service checks the token itself.** `payments-service/auth.js` verifies the Keycloak RS256
  token, derives the provider/customer id from `local_id`, and returns `403` when the role does not
  match the route.
- **Order state stays with the order owner.** After the money transaction commits, the service calls
  the monolith's internal idempotent settlement endpoint. The `orders.payment_status` update is
  conditional, and `payment.succeeded` is emitted only on the first transition.

Proof:

```bash
# The payments service answers this 401 itself (no monolith requestId in the body).
curl -i http://localhost:3000/api/provider/wallet

SPARKLE=$(curl -s -X POST http://localhost:3000/api/auth/provider/login \
  -H 'content-type: application/json' \
  -d '{"email":"sparkle@example.com","password":"eDemand-2026!"}' | jq -r .token)
curl -s -H "authorization: Bearer $SPARKLE" http://localhost:3000/api/provider/wallet
```

### Why the public API did not change

The client contract is the **address**, not the process that serves it. nginx decides:

```nginx
location ^~ /api/notifications           { proxy_pass $notifications_upstream; }
location ^~ /api/provider/wallet         { proxy_pass $payments_upstream; }
location ^~ /api/customer/transactions   { proxy_pass $payments_upstream; }
location ^~ /api/payments/webhook        { proxy_pass $payments_upstream; }
location /                               { proxy_pass $monolith_upstream; }
```

That is also why the mobile app in the brief does not change: it calls `localhost:3000` as before.

### Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Move only the code, keep the tables in the monolith | Two writers and a shared schema are not a boundary; the monolith could still join across contexts |
| Synchronous RPC for every notification | A notification outage would fail bookings; the notification is not part of the booking transaction |
| Let Payments write `orders.payment_status` directly | Distributed-monolith anti-pattern: two services sharing one table is not an extraction |
| Extract Catalog first | Read-heavy and low-risk, but it exercises no money, idempotency or async boundary |
| One shared PostgreSQL database with two schemas | Still one failure domain and one migration owner; separate databases make the ownership physical |

### Area A tradeoffs

- Two more services and two more databases to operate.
- The notification read path can fail while the monolith is healthy.
- Wallet and transaction reads depend on Payments; an outage returns `502/503`, not stale local data.
- Money writes need idempotency and a durable retry path (Area D).
- The monolith still owns `orders`; the settlement callback is an extra network hop.

**Evidence:** `scripts/verify-area-a.ps1` (**32/32 assertions**) and
`scripts/beat1-happy-path.sh` (**12/12**). The verification script also asserts that both moved table
sets are absent from the monolith database.

---

## Area B — security

**Claim:** Keycloak is the only issuer, every service verifies the RS256 token itself, ownership is
enforced where the data lives, and the inherited BOLA is closed.

### Token issuance

| Question | Answer |
|---|---|
| Who issues tokens? | Keycloak 26.0, realm `edemand`, imported from `keycloak/realm-edemand.json` on every clean boot. The monolith never signs a production token. |
| What is in the token? | RS256 access token with `iss=http://localhost:8081/realms/edemand`, `aud` containing `edemand-api`, plus two custom claims: `local_id` (the monolith's numeric user id) and `role` (`customer` / `provider` / `admin`). |
| Who verifies it? | All three processes, independently: the monolith (`lib/http/keycloak.js`), Notifications (`notifications-service/keycloak.js`) and Payments (`payments-service/keycloak.js`). Each fetches the realm JWKS at boot with retries, caches keys by `kid`, and verifies signature + issuer + audience + expiry locally. |
| Is there a shared signing secret? | No. Only public keys are distributed. A compromised service cannot mint a token. |

### The realm's clients

| Client | Purpose |
|---|---|
| `edemand-web` | Normal login client. Adds the `edemand-api` audience and the `local_id` / `role` claims. |
| `edemand-short` | Same claims, **5-second** access-token lifespan, so the demo can show a genuine expired Keycloak token. |
| `edemand-other` | A valid client whose tokens deliberately **omit** the `edemand-api` audience. |
| `edemand-api` | Bearer-only audience/resource identifier. |

### Verification at three processes

```text
client token
   |
   +--> monolith:       fetch JWKS, verify signature/iss/aud/exp, map to local_id
   +--> notifications:  fetch JWKS, verify signature/iss/aud/exp
   +--> payments:       fetch JWKS, verify signature/iss/aud/exp
```

No service trusts `x-user-id` or `x-role` from nginx. nginx forwards `Authorization`; it does not
authenticate. **The service is the security boundary.**

The monolith keeps a test-only HS256 path because `node --test` has no Keycloak. It is selected in
one place (`lib/config.js`) and is disabled whenever `KEYCLOAK_URL` is set. It is a test seam, not a
production fallback.

### Rejection matrix

| Case | Monolith | Extracted services | Status |
|---|---|---|---|
| Real Keycloak token | Accept | Accept | 200 |
| Forged signature | Reject | Reject | **401** |
| Wrong audience | Reject | Reject | **401** |
| Expired token | Reject | Reject | **401** |
| No token | Reject | Reject | **401** |
| Valid token, wrong owner | Reject | Reject | **403** |

The sentence to remember: **401 is about the token; 403 is about the object.**

### Ownership

- **Notifications:** the query uses `recipient_role` and `recipient_id` from the verified token. The
  caller cannot pass another user's id in a query string. Mark-read returns `403` for someone else's
  row.
- **Payments:** the wallet query uses the provider id from the verified token. A customer token gets
  `403` on the provider wallet.
- **Jobs:** the inherited BOLA is fixed (below).

### The inherited BOLA, before and after

The supplied monolith let any authenticated caller read any job by id:

```text
GET /api/jobs/{id} with any valid token -> 200 + full job body
```

The fix is one ownership policy in `lib/modules/bidding/service.js#getJob`:

```text
unrelated customer          -> 403
job owner (customer)        -> 200
assigned provider           -> 200
admin                       -> 200
provider + open job         -> 200   (marketplace listing)
provider who actually bid   -> 200
```

The UI hiding the button was never the control. The attacker changes the id, not the token, so the
check must live in the route/service that reads the object. Regression tests in
`test/bidding.test.js` cover the stranger, the non-bidding provider on a booked job, the owner, and a
bidding provider.

### Internal boundaries

- `/api/internal/*`, `/internal/*` and `/metrics` return **404 at nginx**.
- Service-to-service calls use `INTERNAL_API_KEY`.
- The webhook uses `X-Webhook-Secret` and is idempotent by `gateway_event_id`.
- The databases publish no host ports.

### Area B limitations

- The internal key is **shared**, not per-service workload identity. At this size it is proportionate;
  production would add a private network and mTLS/workload identity.
- There is no token revocation list. A stolen token works until `exp`; production would use
  short-lived access tokens, refresh tokens and session logout.
- The realm is imported from a committed JSON file and the demo issuer is a plain HTTP hostname.
  Production needs TLS and a stable issuer URL.

**Evidence:** `scripts/beat3-auth-rejection.sh` (**17/17 assertions**), including
`iss=http://localhost:8081/realms/edemand`, `aud=edemand-api`, both boundaries rejecting forged,
wrong-audience and expired tokens, the ownership check, and the BOLA before/after behaviour.

---

## Area C — events, duplicate delivery, and the saga

| The four boundary questions | Answer |
|---|---|
| **What crosses** | Domain **events**, not commands: `provider.approved`, `provider.approval_reverted`, `booking.status_changed`, `booking.completed`, `review.created`, `bid.accepted`, `payment.succeeded`. The message is the raw event (`event_uid`, `type`, `aggregate_*`, `payload`, `occurred_at`). |
| **Ownership** | The monolith owns the outbox (`events`) and the saga table (`sagas`). Notifications owns the event → notification projection (`notification-rules.cjs`) and its rows. |
| **Transport** | RabbitMQ topic exchange `edemand.events`; durable queues `edemand.notifications` (Notifications) and `edemand.sagas` (orchestrator). Publisher confirms; at-least-once delivery. |
| **Decision** | Publish from the outbox in the same transaction as the state change, then let each consumer own its projection. Provider approval runs as an **orchestrated saga**. |

### Outbox, not dual writes

Every state change inserts an `events` row **inside the same SQLite transaction** as the write. Either
both commit or neither does. The in-process relay (`setInterval` in `instrumentation.js`) claims a
row, publishes it to `edemand.events`, and only then stamps `processed_at`. If the broker is down,
the claim is released and the next pass retries. This is the transactional-outbox pattern, not
"write the DB, then publish and hope".

### Duplicate delivery still has one effect

Delivery is at-least-once by design: a broker can redeliver after a crash, and the relay can
republish after a failed confirm. Notifications inserts with
`UNIQUE (source_event_id, recipient_role, recipient_id, type)` and `ON CONFLICT DO NOTHING`, where
`source_event_id` is the outbox UUID. A duplicate message creates **no second row**.

Saga outcomes use the same trick: `notification.created` / `notification.failed` are handled by
conditional `UPDATE ... WHERE state='awaiting_notification'`, so a duplicate outcome cannot finish or
compensate a saga twice.

### The projection rules

`notifications-service/notification-rules.cjs` is the whole event → notification mapping:

| Event | Recipient | Type | Copy |
|---|---|---|---|
| `booking.status_changed` | **counterparty** of the actor | `booking_status` | `Booking #<id> is now <status>.` |
| `booking.completed` | customer | `rating_request` | `How did it go?` |
| `review.created` | provider | `new_review` | `You received a <n>-star review.` |
| `provider.approved` | provider | `provider_approved` | `You're approved` |
| `provider.approval_reverted` | provider | `provider_approval_reverted` | `Approval reverted` |
| `bid.accepted` | winner + losers | `bid_accepted` / `bid_rejected` | Bid outcome |
| `payment.succeeded` | provider | `payment_received` | `Payment of <n> cents was received.` |

This is why **creating a booking does not notify the customer**: the customer is the actor, so the
rule notifies the counterparty (the provider). The customer's rows appear when the provider drives
the next state change.

### The saga: provider approval

Approving a provider has a local step (set `is_approved`) and a remote step (create the welcome
notification in another service and database).

1. **Local** — one SQLite transaction: flip `is_approved`, insert the `sagas` row
   (`awaiting_notification`), insert `provider.approved` with its `saga_id`.
2. **Remote** — Notifications consumes the event, writes the notification idempotently, publishes
   `notification.created` (or `notification.failed`).
3. **Local** — the orchestrator consumes the outcome. `notification.created` moves the saga to
   `completed`. `notification.failed` runs the **compensating action**: unapprove the provider and
   write `provider.approval_reverted` in the same transaction as `state='compensated'`.

Admins can follow it at `GET /api/admin/sagas/{id}` and list it at `GET /api/admin/sagas`.

**Why orchestration, not choreography.** The flow is one admin action, one owner, two steps and one
compensation. One place to read and test. Choreography would spread the sequence across Notifications
— which would then have to know that its failure means "unapprove" — and make ownership of the
compensation ambiguous. Choreography is better for long, loosely-coupled, many-consumer flows.

**Deterministic failure demo.** `POST /internal/faults` on Notifications (internal key, never routed)
turns on `notification_failure`. The consumer then publishes `notification.failed`, triggering the
real compensation. The switch is in-memory and resets on restart.

```bash
bash scripts/verify-area-c.sh
```

Expected: `AREA C PASSED (18 assertions)`, including one row per `source_event_id`, a re-published
event creating no second row, compensation unapproving Glow, and a retry completing the saga.

**Reset.** `docker compose down -v` drops the notifications and RabbitMQ volumes. RabbitMQ recreates
the exchange and queues from the assert-on-boot code. The broker is not a second source of truth: the
outbox is.

---

## Area D — timeouts, retries, idempotency, and one repaired race

Area D makes the **monolith → Payments & Wallet** seam survive the three failures the brief names.
The seam is used by booking completion (payout/commission) and cancellation (refund); the demo uses
completion because it changes money and is easy to observe.

| Injected failure | What happens at the seam | Why the caller survives |
|---|---|---|
| **Reply lost after the write** (`lost_reply`) | Payments commits the ledger row and the idempotency record, then destroys the socket before the response is written | The client sees a transport error, backs off and retries with the **same** `Idempotency-Key`. Payments finds the stored response and replays it. One effect. |
| **Reply slower than the timeout** (`slow_reply_ms`) | Payments commits, then holds the response past the client's 3 s timeout | The client times out and retries with the same key; the stored response returns immediately. The late response writes to a dead socket. One effect. |
| **Service unavailable for a window** (`outage_ms`) | Every request fails with 503 before any write | The order commit is already durable and includes a `ledger_commands` row. The response does not fail; the background reconciler replays the command after the outage. One effect. |

### Timeout, retry, jitter

`lib/modules/payments/client.js`:

```js
AbortSignal.timeout(config.paymentsTimeoutMs)              // 3000 ms
config.paymentsMaxAttempts                                  // 3 attempts
delay = random() * min(4000, 250 * 2^(attempt-1))           // exponential, full jitter
```

Only transport failures, timeouts and 5xx are retried. A 4xx is a decision and escapes at once.

Full jitter is deliberate: a fleet that retries in lockstep after an outage creates the next outage.
Jitter spreads the retries across the backoff window.

### Two layers of idempotency, on purpose

1. **Transport** — every logical write gets one key (`payment-intent:<order>`,
   `booking-completed:<order>`, `webhook:<gateway_event_id>`). Payments stores it in
   `idempotency_keys(key PRIMARY KEY)` with the response and returns that response on a replay.
2. **Domain** — the money tables keep their own UNIQUE keys: `payment_intents.order_id`,
   `transactions(order_id, kind)` and `webhook_events.gateway_event_id`. Even two different keys that
   race cannot double-credit, because the database refuses the second row.

### Durability before the network call

Completing or cancelling a booking writes the order change, the outbox event and a `ledger_commands`
row in the **same SQLite transaction** (`lib/modules/booking/service.js`,
`lib/modules/payments/ledger-queue.js`). The direct HTTP call is only the low-latency path. If it
fails, the row stays pending and `startLedgerReconciler()` retries every 3 seconds until Payments
acknowledges it. An outage delays the wallet update but cannot lose it.

### The unsafe race that was fixed

Registration was a read-then-write: `findCustomerByEmail()` followed by `INSERT`. Two concurrent
requests both read "no such email", both insert, and the UNIQUE(email) index rejects the second — but
the raw `SQLITE_CONSTRAINT_UNIQUE` became a **500** instead of the clean **409** of the sequential
path.

The fix lets the index be the arbiter and translates the constraint into `ConflictError` (409).
`test/identity-race.test.js` proves it with two worker threads on the same file database: one 201,
one 409, one row. The test was also run with the translation disabled to confirm it fails before the
fix.

**Evidence:** `scripts/beat2-failure-recovery.sh` (**20/20 assertions**) on a clean boot. Recovery
times observed: lost reply **162 ms**, slow reply **3230 ms**, 9 s outage **616 ms** — in every case
the order stayed completed and Payments held exactly one ledger row.

**Accepted tradeoff:** the reconciler is in-process and polls every 3 seconds, so recovery is
"seconds, not milliseconds", and a total monolith outage pauses reconciliation until restart. The
alternative — a separate queue worker or CDC — is more moving parts than a two-step money write needs
at this size. What matters is that the command is durable first and retried later.

---

## Area E — traces, metrics, dashboard, and contract tests

### One trace across both seams

OpenTelemetry runs in all three processes (`lib/telemetry.js`, `payments-service/telemetry.js`,
`notifications-service/telemetry.js`):

- the monolith starts a SERVER span in `lib/http/handle.js` and returns `x-trace-id` plus a W3C
  `traceparent` header;
- the payments client injects the current `traceparent` on every outbound HTTP call, so the Payments
  SERVER span is a child of the monolith route span;
- `events.trace_parent` stores the trace of the request that wrote the outbox row. The relay starts a
  PRODUCER span parented to it, and `lib/messaging/rabbit.js` puts that `traceparent` in the RabbitMQ
  message headers;
- the Notifications consumer starts a CONSUMER span from the header and carries the trace into
  `notification.created` / `notification.failed`; the monolith's saga consumer continues it.

Result in Jaeger: one trace containing the monolith route, the payments HTTP call, the outbox publish
and the notifications consumer. `scripts/beat4-find-the-trace.sh` asserts all three services appear
and that **every child span points at a parent in the same trace** (`ORPHANS=0`).

Tracing is **off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set**, so `node --test` and a bare
`npm run dev` emit nothing. Compose points all three at `http://jaeger:4318`.

### Metrics and dashboard

Each service exposes `/metrics` in Prometheus format. nginx returns 404 for `/metrics` and
`/internal`, so they are reachable only on the compose network.

| Metric | Labels | Used for |
|---|---|---|
| `http_requests_total` | `service`, `method`, `route`, `status` | Request rate and 5xx ratio |
| `http_request_duration_seconds` | `service`, `method`, `route`, `status` | p95 response time |
| `notifications_events_projected_total` | `service`, `event_type`, `outcome` | Consumer progress and injected failures |

Route labels are normalised (`/api/bookings/8001` → `/api/bookings/:id`), so ids do not explode the
time-series count. Prometheus scrapes all three targets every 5 s. Grafana is provisioned from
`observability/` with one dashboard, **eDemand — services at a glance**: request rate, error rate and
p95 latency per service.

### Contract tests

Pact consumer tests live in `test/pact/`:

- `notifications.pact.test.js` drives the real monolith client against a Pact mock and pins the inbox
  response shape and the forwarded bearer token;
- `payments.pact.test.js` pins `POST /internal/payment-intents` (including the `Idempotency-Key`
  header) and `GET /api/provider/wallet`.

They write `pacts/edemand-monolith-{notifications,payments}-service.json`. Run with
`npm run test:pact` (2/2).

`.github/workflows/ci.yml` runs the unit suite, the contract job and a production build. The contract
job was executed locally with:

```bash
act pull_request -j contracts
```

`act` has no GitHub artifact service, so the upload step is guarded with `if: ${{ env.ACT != 'true' }}`;
the job still fails the run if a contract breaks.

**Evidence:** `scripts/beat4-find-the-trace.sh` (**12/12**, 9 spans, `ORPHANS=0`),
`npm run test:pact` (**2/2**), and the CI workflow above.

---

## The four demo beats

Run them from the repository root on a clean boot:

```bash
docker compose down -v
docker compose up -d --build --wait
```

Each script waits for health, prints one `PASS` line per assertion, and exits non-zero on a mismatch.
They use only `curl`, `node` and the compose stack.

> **Windows:** prefix with Git Bash, e.g.
> `& "C:\Program Files\Git\bin\bash.exe" scripts/beat1-happy-path.sh`.

### 1. Happy path — `scripts/beat1-happy-path.sh`

One request path across every boundary: anonymous inbox rejected by Notifications, admin approval
drives the saga and the RabbitMQ projection, a gateway booking creates a payment intent, "Pay now"
settles it, and OTP completion writes one payout row in Payments.

```bash
bash scripts/beat1-happy-path.sh
```

```text
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

### 2. Failure recovery — `scripts/beat2-failure-recovery.sh`

The three Area D failures, each survived with exactly one wallet effect. The switches are internal
and reset when the script exits.

```bash
bash scripts/beat2-failure-recovery.sh
```

```text
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

### 3. Auth rejection — `scripts/beat3-auth-rejection.sh`

A real Keycloak token accepted by both boundaries; forged, expired and wrong-audience tokens rejected
with 401 by the monolith **and** the extracted services; ownership enforced; and the inherited
`GET /api/jobs/{id}` BOLA now returning 403 where it used to return 200.

```bash
bash scripts/beat3-auth-rejection.sh
```

```text
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

### 4. Find the trace — `scripts/beat4-find-the-trace.sh`

Makes one gateway booking and finds the same request in Jaeger after the asynchronous half has run.

```bash
bash scripts/beat4-find-the-trace.sh
```

```text
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

---

## Verification matrix

Every number below comes from the submitted tag on a clean boot.

| Check | Command | Expected |
|---|---|---|
| Full test suite | `docker compose run --rm test` | **78/78** pass |
| Unit/concurrency only | `npm run test:unit` (Node 20) | **76/76** pass |
| Pact contracts | `npm run test:pact` | **2/2** pass |
| Production build | `npm run build` | Success |
| Clean boot | `docker compose up -d --build --wait` | **11 running, 9 healthy** |
| Area A verification | `powershell -ExecutionPolicy Bypass -File scripts/verify-area-a.ps1` | **32/32** |
| Area C verification | `bash scripts/verify-area-c.sh` | **18/18** |
| Beat 1 — happy path | `bash scripts/beat1-happy-path.sh` | **12/12** |
| Beat 2 — failure recovery | `bash scripts/beat2-failure-recovery.sh` | **20/20** |
| Beat 3 — auth rejection | `bash scripts/beat3-auth-rejection.sh` | **17/17** |
| Beat 4 — trace | `bash scripts/beat4-find-the-trace.sh` | **12/12**, 9 spans, `ORPHANS=0` |

The suite covers: health; identity (401/403/400/409); catalog (pagination, ownership); booking (id
8001, slot double-book race, idempotency, full status machine, OTP completion with exactly-once
credit, cancel/refund, reschedule); slots; bidding (accept race, accept-vs-withdraw); the payments
webhook replay; reviews → outbox → relay rating aggregate; admin approval writing the outbox event
atomically; Area C events (duplicate delivery, saga completion, compensation, retry); the identity
race with two worker threads; and the two Pact contracts.

The broker is not started by `node:test`. `test-helpers/notifications.js` installs an in-process
publisher that runs the **same** projection rules as the service. RabbitMQ, real queues and duplicate
redelivery are proven by `scripts/verify-area-c.sh` on the compose stack.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `execvpe(/bin/bash) failed: No such file or directory` | PowerShell's `bash` is WSL, and the distro has no `/bin/bash` | Use `& "C:\Program Files\Git\bin\bash.exe" scripts/beat1-happy-path.sh` |
| `better-sqlite3` build error on `npm install` | Node 24 has no prebuilt binary; building needs Visual Studio C++ tools | Use Node 20 (`.nvmrc`) or run tests in Docker |
| `docker compose up --wait` times out on first boot | Keycloak imports the realm and both services wait for JWKS; first boot is 2–4 minutes | Wait, then `docker compose ps`; inspect `docker compose logs keycloak notifications` |
| `bind: address already in use` on 3000/8081/15672 | Another Docker project or local service owns the port | `docker compose down` in the other project, or change the host side of the mapping |
| `502 Bad Gateway` on `/api/notifications` or wallet | The extracted service is unhealthy, or Keycloak is not ready | `docker compose ps`; `docker compose logs notifications payments` |
| Login returns 401 immediately after boot | Realm import or JWKS fetch not finished | Wait ~60 s for the first Keycloak import, then retry |
| Notifications page is empty after *creating* a booking | The customer is the actor, so the rule notifies the **provider** | Log in as `sparkle@example.com` to see it; customer rows appear when the provider confirms/starts/completes |
| Jaeger shows nothing | Traces export asynchronously | Wait a few seconds, reload; Beat 4 retries before asserting |
| Grafana panels are empty | Prometheus has not scraped yet (5 s interval) | Wait ~15 s and refresh |
| `permission denied` running a beat | Script not executable / wrong shell | Run with `bash scripts/...`, not `./scripts/...` |
| Beat 1 says Glow is already approved | Stack was not reset, so the saga already ran | `docker compose down -v && docker compose up -d --build --wait` |

Useful commands:

```bash
docker compose ps
docker compose logs -f notifications
docker compose logs -f payments
docker compose exec notifications-db psql -U user -d notifications_db -c '\dt'
docker compose exec payments-db psql -U user -d payments_db -c '\dt'
curl -i http://localhost:3000/api/internal/orders/8001/payment-status   # 404 at the gateway
curl -i http://localhost:3000/metrics                                   # 404 at the gateway
```

---

## Security notes

**This stack is a teaching artifact. Do not expose it to the internet.**

Demo defaults that must change for any real deployment:

| Setting | Demo value | Where |
|---|---|---|
| Keycloak admin | `admin` / `admin` | `docker-compose.yml` |
| RabbitMQ | `edemand` / `edemand-demo-pass` | `docker-compose.yml` |
| Internal service key | `dev-internal-key-change-me` | `INTERNAL_API_KEY` |
| Webhook secret | `edemand-webhook-secret` | `WEBHOOK_SECRET` |
| Seed passwords | `eDemand-2026!` | `lib/db/seed.js`, realm JSON |
| PostgreSQL | `user` / `password` | compose defaults |
| Grafana | anonymous admin | intentional for the local demo |

Postgres and the two Express services publish no host ports; RabbitMQ, Keycloak, Jaeger, Prometheus
and Grafana do, because the demo needs a browser. In production those would sit behind a private
network and TLS, with per-service workload identity instead of one shared internal key.

The test-only HS256 verifier is disabled whenever `KEYCLOAK_URL` is set. It exists so `node --test`
can run without an identity provider; it is not a fallback path in the composed stack.

---

## Design decisions and tradeoffs

### Why keep the monolith?

The brief says to change the monolith only as much as the migration needs. We kept its language, UI
and public API, removed the moved tables, and replaced the calls with clients. That is the honest
"strangler" shape: extract a context, leave the rest working, keep the public contract stable.

### Why these two seams?

Ranked by how cleanly a context detaches today:

1. **Notifications (first).** One owned table, no synchronous hot-path caller, already
   projection-shaped. The lowest-risk proof of the service + database + gateway pattern.
2. **Payments & Wallet (second).** Clearest transaction boundary, highest value from isolation, and
   the webhook already behaved like a service. The one inward coupling (`orders.payment_status`)
   became a callback to the order owner.
3. **Catalog / Provider Profile (next).** Read-heavy and mostly independent, but extraction means
   Catalog must subscribe to `review.created` for the rating aggregate.
4. **Booking + Bidding (last / together).** They share the physical `slot_holds` UNIQUE guard. In one
   database that is free; split them and the availability invariant becomes distributed reservation.

Identity is a shared dependency and is best pulled out early as an IdP — which Area B does with
Keycloak.

### Rejected alternatives, in one table

| Decision | Rejected alternative | Why |
|---|---|---|
| Separate PostgreSQL per service | Shared database, separate schemas | One failure domain and one migration owner; ownership is not physical |
| nginx gateway | Kong / full API gateway | We need path routing and one published port; Kong is justified by rate limits, consumer credentials and canaries |
| Orchestrated saga | Choreography | Two steps, one owner, one compensation; choreography hides the flow and blurs compensation ownership |
| Durable command + reconciler | Best-effort HTTP only | A payment outage would lose the wallet update |
| Full jitter | Fixed or no jitter | Lockstep retries recreate the outage |
| Transactional outbox | Publish after commit | A crash between commit and publish loses the event |
| Keycloak RS256 + JWKS | Shared HS256 secret | A shared secret lets any verifier mint tokens; public-key verification separates checking from creating |

The full defence, including the industrial landscape comparison (Uber, Airbnb, Shopify, Netflix,
Monzo and others), is in [`docs/dossier.md`](docs/dossier.md).

---

## Known limitations

- **The relay is in-process.** `setInterval` shares the connection and dies with the process. The
  broker makes delivery durable across service restarts, but the publisher is still the monolith's
  timer. A relay container, Debezium/CDC or a transactional queue is the next step. The `events` table
  and `processed_at` claim make that swap mechanical.
- **The saga orchestrator is single-instance.** `sagas` lives in the monolith's SQLite file. A second
  orchestrator would need a lease/claim on saga rows. Conditional updates already make duplicate
  *messages* safe, but not duplicate pollers.
- **The reconciler is in-process and polls every 3 s.** Recovery is seconds, not milliseconds, and a
  monolith outage pauses reconciliation.
- **The internal key is shared.** No mTLS or per-service workload identity.
- **No token revocation list.** A stolen token works until `exp`.
- **`slot_holds` is a single-database invariant.** It becomes distributed reservation the moment
  Booking and Bidding are separated — which is why they are last.
- **Shared deploy for the monolith.** A migration, slow query or crash in any remaining context stops
  all of them. Notifications and Payments are now the exception: they have their own deploy and
  database.
- **Demo-only operational settings.** Plaintext issuer hostname, demo credentials, anonymous Grafana,
  no TLS.
- **Out of scope by design** (course adds later): real payment gateways, chat, cart, subscriptions,
  multi-region deployment. SOAP/WSDL appear nowhere.

---

## Team and ownership

Four members, five areas:

| Member | Areas | Primary evidence |
|---|---|---|
| Pannadhorn Chidchue | **A + B** | `verify-area-a.ps1` 32/32, `beat3-auth-rejection.sh` 17/17, `beat1` 12/12 |
| Natchanon Meechana | **C** | `verify-area-c.sh` 18/18, `test/area-c-events.test.js` |
| Phutharit Promin | **D** | `beat2-failure-recovery.sh` 20/20, `test/identity-race.test.js` |
| Thantip Kangwanwanit | **E** | `beat4-find-the-trace.sh` 12/12, `npm run test:pact` 2/2, CI |

The per-area owner, commit link and exact evidence are in [`OWNERS.md`](OWNERS.md).

---

**One-sentence closing:** the migration is done when the public API is unchanged, the moved tables
are physically gone from the monolith, every service verifies the token itself, invalid tokens get
401, wrong owners get 403, the inherited job BOLA is closed, every failure leaves exactly one money
effect, and one trace proves the whole path — the four beats are the reproducible evidence.
