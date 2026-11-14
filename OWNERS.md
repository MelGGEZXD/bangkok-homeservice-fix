# Owners

**Team:** Bangkok Homeservice — DES428 capstone
**Repository:** <https://github.com/MelGGEZXD/bangkok-homeservice-fix>
**Submission tag:** `capstone-final`
**Submission branch:** `main` (development branch `area-a-second`)

One owner per area. Each row names the person, the boundary they own, and the commit that carries the
work. The commit links point at the submitted history; no squash or rewrite was applied after the
areas were merged.

---

## Team roster

> **Before submitting:** fill the two remaining members (C and D) in the roster. The area ownership
> and commit links below are final.

| Member | Full name | Student ID | Areas owned |
|---|---|---|---|
| 1 | **Pannadhorn Chidchue** | `6622780888` | **A + B** |
| 2 | `__________` | `__________` | **C** |
| 3 | `__________` | `__________` | **D** |
| 4 | **Thantip Kangwanwanit** | `6622781217` | **E** |

---

## Area ownership

| Area | What it covers | Owner | Commit |
|---|---|---|---|
| **A — Extract two contexts** | Notifications extracted first (own PostgreSQL DB, Express service, nginx route, monolith no longer owns the table); Payments & Wallet extracted second (own PostgreSQL DB, HTTP client seam, callback to the order owner) | Pannadhorn Chidchue | [`2e266ef`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/2e266ef) (Notifications, with Area B) · [`a4c1b67`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/a4c1b67) (Payments & Wallet) |
| **B — Security** | Keycloak realm and RS256/JWKS verification in all three processes; forged, expired and wrong-audience tokens rejected with 401; service-side ownership; inherited `GET /api/jobs/{id}` BOLA fixed | Pannadhorn Chidchue | [`2e266ef`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/2e266ef) |
| **C — Events and saga** | Outbox → RabbitMQ `edemand.events`, durable queues, publisher confirms, duplicate delivery with one effect, provider-approval saga with compensation, orchestration-vs-choreography defence | `Member 2` | [`ce5c257`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/ce5c257) |
| **D — Failure and idempotency** | Three fault switches (lost reply, slow reply, timed outage) survived with one wallet effect; durable `ledger_commands` and reconciler; timeout + exponential backoff with full jitter; stable `Idempotency-Key`; customer/provider registration race fixed with a two-worker-thread proof | `Member 3` | [`97505b6`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/97505b6) |
| **E — Observability and contracts** | One OpenTelemetry trace across HTTP and RabbitMQ; Prometheus metrics and Grafana dashboard (request rate, error rate, p95 per service); Pact consumer contracts for both new boundaries; GitHub Actions CI run locally with `act` | Thantip Kangwanwanit | [`97505b6`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/97505b6) |

---

## Evidence per area

| Area | Primary evidence | Repeatable command |
|---|---|---|
| **A** | 32 assertions on both extractions, including replayed webhook producing one charge and the moved tables absent from the monolith database | `powershell -ExecutionPolicy Bypass -File scripts/verify-area-a.ps1` |
| **A** | 12 assertions on the end-to-end happy path | `bash scripts/beat1-happy-path.sh` |
| **B** | 17 assertions: real token, forged, expired, wrong audience, ownership, BOLA before/after | `bash scripts/beat3-auth-rejection.sh` |
| **C** | 18 assertions: queue topology, duplicate delivery, saga completion, compensation, retry | `bash scripts/verify-area-c.sh` |
| **D** | 20 assertions across three injected failures, one wallet effect each | `bash scripts/beat2-failure-recovery.sh` |
| **D** | Two worker threads race one email: one 201, one 409, one row | `npm run test:unit` (`test/identity-race.test.js`) |
| **E** | 12 assertions, 9 spans, `ORPHANS=0` | `bash scripts/beat4-find-the-trace.sh` |
| **E** | 2 consumer contracts, generated into `pacts/` | `npm run test:pact` |
| **E** | CI jobs: unit, contracts, production build | `act pull_request -j contracts` |

The architecture rationale for every area is in [`docs/dossier.md`](docs/dossier.md). The recorded
demo shot list is [`docs/demo-runbook.md`](docs/demo-runbook.md).

---

## Submission

- Branch: `area-a-second` (merged to `main`; the tag is what is marked)
- Tag: `capstone-final`
- The four demo scripts, their expected output and the reset command are in [`README.md`](README.md).
- The architecture dossier is [`docs/dossier.md`](docs/dossier.md).
- The demo video `capstone-demo.mp4` and the confidential peer reviews are submitted separately, not
  committed to this repository.
