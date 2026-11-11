# Owners

Team: Bangkok Homeservice — DES428 capstone
Repository: <https://github.com/MelGGEZXD/bangkok-homeservice-fix>

One owner per area, with the commit that carries the work. The links point at the commit on the
submitted branch; annotate each row with a pull request link if the repository moves to PR-based
review.

| Area | What it covers | Owner | Commit |
|---|---|---|---|
| **A — Extract two contexts** | Notifications extracted first (own PostgreSQL DB, Express service, nginx route, monolith no longer owns the table); Payments & Wallet extracted second (own PostgreSQL DB, HTTP client seam, callback to the order owner) | MelXD | [2e266ef](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/2e266ef) (Notifications, with Area B) · [a4c1b67](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/a4c1b67) (Payments & Wallet) |
| **B — Security** | Keycloak realm and RS256/JWKS verification in all three processes; forged, expired and wrong-audience tokens rejected with 401; service-side ownership; inherited `GET /api/jobs/{id}` BOLA fixed | MelXD | [2e266ef](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/2e266ef) |
| **C — Events and saga** | Outbox → RabbitMQ `edemand.events`, durable queues, publisher confirms, duplicate delivery with one effect, provider-approval saga with compensation, orchestration-vs-choreography defence | MelXD | [ce5c257](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/ce5c257) |
| **D — Failure and idempotency** | Three fault switches (lost reply, slow reply, timed outage) survived with one wallet effect; durable `ledger_commands` and reconciler; timeout + exponential backoff with full jitter; stable `Idempotency-Key`; customer/provider registration race fixed with a two-worker-thread proof | MelXD | [97505b6](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/97505b6) |
| **E — Observability and contracts** | One OpenTelemetry trace across HTTP and RabbitMQ; Prometheus metrics and Grafana dashboard (request rate, error rate, p95 per service); Pact consumer contracts for both new boundaries; GitHub Actions CI run locally with `act` | MelXD | [97505b6](https://github.com/MelGGEZXD/bangkok-homeservice-fix/commit/97505b6) |

## Evidence per area

| Area | Primary evidence |
|---|---|
| A | `scripts/verify-area-a.ps1` (32 assertions); `scripts/beat1-happy-path.sh`; `docs/dossier.md` §2.3 seams 1–2 |
| B | `scripts/beat3-auth-rejection.sh` (17 assertions); `docs/dossier.md` §4 |
| C | `scripts/verify-area-c.sh` (18 assertions); `test/area-c-events.test.js`; `docs/dossier.md` §5.2, §5.5 |
| D | `scripts/beat2-failure-recovery.sh` (20 assertions); `test/identity-race.test.js`; `docs/dossier.md` §6 |
| E | `scripts/beat4-find-the-trace.sh` (12 assertions, 9 spans, `ORPHANS=0`); `npm run test:pact` (2/2); `act pull_request -j contracts`; `docs/dossier.md` §7.4–7.5 |

## Submission

- Branch: `area-a-second` (merged to `main` for submission if required by the marker)
- Tag: `capstone-final`
- The four demo scripts, their expected output and the reset command are in `README.md`.
- The architecture dossier is `docs/dossier.md`.

> Owner handles above are the repository identity used for this run. Replace `MelXD` with each
> member's full name and student id if the course submission form requires legal names; the commit
> links stay the same.
