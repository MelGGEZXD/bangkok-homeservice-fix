# Capstone demo recording — runbook

The brief asks for `capstone-demo.mp4`, 8–12 minutes: a clean clone, the one command, health green,
then the four demo scripts run and narrated request by request across every boundary. This file is
the shot list and narration guide. The recording itself must be made on the presenting machine; a
synthetic recording would not be evidence.

## Before recording

1. Close other Docker projects so the laptop has the full 8 GB budget.
2. Use a clean clone, not the working copy:

   ```bash
   git clone https://github.com/MelGGEZXD/bangkok-homeservice-fix.git /tmp/bangkok-demo
   cd /tmp/bangkok-demo
   git checkout capstone-final
   ```

3. Have four terminals ready: one for compose, one for the beat scripts, one for Jaeger/Grafana, one
   for `curl` if you want to show a raw response.

## Shot list (target 10 minutes)

| Time | Shot | Narration |
|---|---|---|
| 0:00–1:00 | Repository root, `git log --oneline -5`, `git tag --list` | "This is the submitted commit, tagged capstone-final. The monolith still owns booking, identity and catalog; Notifications and Payments & Wallet have their own Express services and PostgreSQL databases." |
| 1:00–3:00 | `docker compose up -d --build --wait`, then `docker compose ps` | "One command. `--wait` returns only when the gateway, monolith, both services, both databases, Keycloak, RabbitMQ, Jaeger, Prometheus and Grafana are healthy. Nothing else is installed and no cloud account is used." |
| 3:00–5:00 | `bash scripts/beat1-happy-path.sh` | "One request path across every boundary. The inbox refuses an anonymous call at the notifications service itself. Admin approval writes a saga row and an outbox event; RabbitMQ carries it to notifications and the saga completes. A gateway booking creates a payment intent, Pay now settles it, and OTP completion writes exactly one payout row in Payments." |
| 5:00–7:00 | `bash scripts/beat2-failure-recovery.sh` | "Three injected failures. Lost reply: the write commits, the socket dies, the client retries with the same idempotency key, one wallet effect. Slow reply: the client times out at 3 seconds and the retry returns the stored result. Nine-second outage: the order still completes because the ledger command is durable, and the reconciler drains it. One order, one wallet effect, every time." |
| 7:00–8:30 | `bash scripts/beat3-auth-rejection.sh` | "Keycloak issues the token. The monolith and both extracted services verify RS256 against the realm JWKS independently. Forged, expired and wrong-audience tokens are 401 at both boundaries. Ownership is enforced in the service: another user cannot read or mark read what they do not own. The inherited job BOLA now returns 403 where it used to return 200." |
| 8:30–10:00 | `bash scripts/beat4-find-the-trace.sh`, then open the printed Jaeger URL and the Grafana dashboard | "The response carries x-trace-id and a W3C traceparent. Jaeger shows one trace with nine spans: the monolith route, the payments service over HTTP, the outbox publish, and the notifications consumer over RabbitMQ. Every child points at a parent; there are no orphans. Grafana shows request rate, error rate and p95 latency per service, scraped from /metrics on all three." |
| 10:00–10:30 | `docker compose down -v` | "This is the reset: both extracted PostgreSQL databases, RabbitMQ and Grafana return to first boot. The monolith reseeds SQLite, so booking ids start at 8001 again." |

## If a beat is rerun without a reset

Beat 1 detects that Glow is already approved and says so; it still proves the inbox and the
remaining beats. For the exact output in the README, run `docker compose down -v` first.

## What not to do

- Do not edit files during the recording; the marker is checking the submitted commit.
- Do not skip the reset before the four beats if you want booking ids 8001–8005 and the full 12
  assertions in Beat 1.
- Do not narrate numbers that are not on screen; the README records the numbers from the clean run
  used for this dossier.
