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

| Member | Full name | Student ID | Areas owned |
|---|---|---|---|
| 1 | **Pannadhorn Chidchue** | `6622780888` | **A + B** |
| 2 | **Natchanon Meechana** | `6622770871` | **C** |
| 3 | **Phutharit Promin** | `6622781258` | **D** |
| 4 | **Thantip Kangwanwanit** | `6622781217` | **E** |

---

## Area ownership

| Area | What it covers | Owner | Commit |
|---|---|---|---|
| **A — Extract two contexts** | Notifications extracted first (own PostgreSQL DB, Express service, nginx route, monolith no longer owns the table); Payments & Wallet extracted second (own PostgreSQL DB, HTTP client seam, callback to the order owner) | Pannadhorn Chidchue | [`2e266ef`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/2e266ef) (Notifications, with Area B) · [`a4c1b67`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/a4c1b67) (Payments & Wallet) |
| **B — Security** | Keycloak realm and RS256/JWKS verification in all three processes; forged, expired and wrong-audience tokens rejected with 401; service-side ownership; inherited `GET /api/jobs/{id}` BOLA fixed | Pannadhorn Chidchue | [`2e266ef`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/2e266ef) |
| **C — Events and saga** | Outbox → RabbitMQ `edemand.events`, durable queues, publisher confirms, duplicate delivery with one effect, provider-approval saga with compensation, orchestration-vs-choreography defence | Natchanon Meechana | [`ce5c257`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/ce5c257) |
| **D — Failure and idempotency** | Three fault switches (lost reply, slow reply, timed outage) survived with one wallet effect; durable `ledger_commands` and reconciler; timeout + exponential backoff with full jitter; stable `Idempotency-Key`; customer/provider registration race fixed with a two-worker-thread proof | Phutharit Promin | [`97505b6`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/97505b6) |
| **E — Observability and contracts** | One OpenTelemetry trace across HTTP and RabbitMQ; Prometheus metrics and Grafana dashboard (request rate, error rate, p95 per service); Pact consumer contracts for both new boundaries; GitHub Actions CI run locally with `act` | Thantip Kangwanwanit | [`97505b6`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/97505b6) |

---

## Commit map

The four commits that carry the area work, in history order. Short hashes in the table above link to
these; the full hashes are listed after the table for offline marking.

| Commit | Date | Area | Commit message | What it contains |
|---|---|---|---|---|
| [`2e266ef`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/2e266ef) | 2026-11-09 | **A + B** | `Area A + B: extract notifications, Keycloak tokens, fix job BOLA` | Root commit, so it also imports the supplied monolith baseline. Adds the extracted Notifications service and its PostgreSQL database, the nginx gateway route, the Keycloak realm and protocol mappers, JWKS verification in the monolith and the service, the recipient/ownership checks, and the `GET /api/jobs/{id}` BOLA fix. |
| [`a4c1b67`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/a4c1b67) | 2026-11-11 | **A** | `Area A: extract Payments & Wallet into its own service and PostgreSQL DB` | Second extraction: the Payments service, `payments_db`, wallet/transaction/webhook routes, the monolith HTTP client, the internal settlement callback, and the removal of the four money tables from the monolith schema. |
| [`ce5c257`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/ce5c257) | 2026-11-11 | **C** | `Area C: RabbitMQ events, outbox publishing, provider-approval saga` | RabbitMQ topology and publisher confirms, the raw event envelope, the event → notification projection, the saga table/orchestrator/consumer, the compensating unapprove, and the deterministic failure switch. |
| [`97505b6`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/97505b6) | 2026-11-12 | **D + E** | `Area D + E: survive faults with one effect, trace both seams, contract CI` | Three fault switches, timeout + exponential backoff with full jitter, durable `ledger_commands` and reconciler, stable `Idempotency-Key`, the registration race fix, OpenTelemetry spans across HTTP and RabbitMQ, Prometheus metrics, the Grafana dashboard, Pact contracts, the CI workflow and the dossier. |

Full hashes:

```text
2e266efeb973a0f8fa5059166d2eb10710646f0e   A + B
a4c1b675c76dcc0e76d97192c6a4f6fa9fa2743d   A (Payments)
ce5c257e4816eff01ab4d3ea717c1039ff4b2c0c   C
97505b6fc1977858d7ac7e6d1207a4b2149fbc2d   D + E
```

Documentation commits after the area work:

| Commit | Purpose |
|---|---|
| [`e61d145`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/e61d145) | Add `OWNERS.md` and link the dossier |
| [`8179750`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/8179750) | Add the demo recording runbook |
| [`12c1541`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/12c1541) | Link the runbook from the README |
| [`f20d1ba`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/f20d1ba) | Submission README, roster, runbook and configuration |
| [`de6f31f`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/de6f31f) | Remove the internal checklist from the README |
| [`628702d`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/628702d) | Add the Area E owner and student ID |
| [`da48cd3`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/da48cd3) | Add the Area A and B owner name and student ID |
| [`b00c0ec`](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/b00c0ec) | Complete the roster with Areas C and D |

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
