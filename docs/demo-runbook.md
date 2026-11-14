# Capstone demo recording — runbook

The brief asks for **`capstone-demo.mp4`, 8–12 minutes**: a clean clone, the one command, health
green, then the four demo scripts run and narrated request by request across every boundary.

This file is the shot list and narration guide. The recording must be made on the presenting machine;
a synthetic recording is not evidence.

---

## 1. Before recording

### Machine and stack

- Close other Docker projects. The stack runs 11 containers and needs roughly 8 GB of Docker memory.
- Use a **clean clone**, not the working copy:

  ```bash
  git clone https://github.com/MelGGEZXD/bangkok-homeservice-fix.git /tmp/bangkok-demo
  cd /tmp/bangkok-demo
  git checkout capstone-final
  ```

- Confirm the tag is the submission:

  ```bash
  git log --oneline -5
  git describe --tags --exact-match
  ```

- If you are on Windows, run the four beats through **Git Bash**:

  ```powershell
  & "C:\Program Files\Git\bin\bash.exe" scripts/beat1-happy-path.sh
  ```

  PowerShell's `bash` may resolve to WSL, which fails with `execvpe(/bin/bash)`.

### Recording setup

| Item | Setting |
|---|---|
| Resolution | 1920×1080, 30 fps |
| Audio | One microphone, tested for 10 seconds before the take |
| Terminal font | 16–18 pt, dark background, no transparency |
| Browser zoom | 110–125%, one window, four tabs |
| Notifications | Off (Windows Focus Assist / macOS Do Not Disturb) |
| Timer | Visible clock or a phone timer to stay inside 12 minutes |

### Tabs to have open

| # | Tab | Why |
|---|---|---|
| 1 | <http://localhost:3000> | The app through the gateway |
| 2 | <http://localhost:8081> | Keycloak realm, clients, RS256 keys |
| 3 | <http://localhost:16686> | Jaeger, opened after Beat 4 |
| 4 | <http://localhost:3005> | Grafana dashboard |

Optional for the full team: <http://localhost:15672> (RabbitMQ) and <http://localhost:9090>
(Prometheus).

### Do not pre-run the beats

A first run changes state: Glow becomes approved, bookings 8001–8004 exist. Record from
`docker compose down -v` so the ids and assertions match the README exactly.

---

## 2. Shot list (target 10 minutes)

| Time | Shot | Narration |
|---|---|---|
| 0:00–1:00 | Repository root: `git log --oneline -5`, `git tag --list`, explain the tree | "This is the submitted commit, tagged `capstone-final`. The monolith still owns identity, catalog, booking, bidding and reviews. Notifications and Payments & Wallet are separate Express services with their own PostgreSQL databases, behind one nginx gateway." |
| 1:00–3:00 | `docker compose up -d --build --wait`, then `docker compose ps` and `curl -s localhost:3000/api/health` | "One command, no cloud account, no local database install. `--wait` returns only when the gateway, monolith, both services, both databases, Keycloak, RabbitMQ, Jaeger, Prometheus and Grafana are healthy. Eleven containers." |
| 3:00–5:00 | `bash scripts/beat1-happy-path.sh` | "One request path across every boundary. The anonymous inbox is rejected by the Notifications service itself — the 401 body has no monolith request id. Admin approval writes the saga row and the outbox event in one transaction; RabbitMQ carries it to Notifications; the saga completes. A gateway booking creates a payment intent, Pay now settles it, and OTP completion writes exactly one payout row." |
| 5:00–7:00 | `bash scripts/beat2-failure-recovery.sh` | "Three injected failures. Lost reply: the write commits, the socket dies, the client retries with the same idempotency key, one wallet effect. Slow reply: the client times out at three seconds and the retry returns the stored result. Nine-second outage: the order still completes because the ledger command is durable, and the reconciler drains it. One order, one wallet effect, every time." |
| 7:00–8:30 | `bash scripts/beat3-auth-rejection.sh` | "Keycloak issues the token: RS256, issuer `localhost:8081/realms/edemand`, audience `edemand-api`. The monolith and both extracted services fetch the realm JWKS and verify the token themselves. Forged, expired and wrong-audience tokens are 401 at both boundaries. A valid token for the wrong object is 403. The inherited job BOLA now returns 403 where it used to return 200." |
| 8:30–10:00 | `bash scripts/beat4-find-the-trace.sh`, open the printed Jaeger URL, then Grafana | "The response carries `x-trace-id` and a W3C `traceparent`. Jaeger shows one trace with nine spans: the monolith route, the payments service over HTTP, the outbox publish, and the notifications consumer over RabbitMQ. Every child points at a parent in the same trace; there are no orphans. Grafana shows request rate, error rate and p95 latency per service, scraped from `/metrics` on all three." |
| 10:00–10:30 | `docker compose down -v` | "This is the reset: both extracted PostgreSQL databases, RabbitMQ and Grafana return to first boot. SQLite reseeds, so booking ids start at 8001 again." |

Stop recording before the 12-minute mark. The marker values a complete, calm narration over a rushed
one.

---

## 3. Narration rules

1. **Say what crossed the boundary, not just what the script printed.**
   Bad: "It passed 12 assertions." Good: "The 401 came from Notifications, not the monolith."
2. **Name the owner of the data.** "Payments owns the money rows; the monolith owns the order."
3. **Say 401 vs 403 deliberately.** 401 is the token; 403 is the object.
4. **Use the numbers on screen.** Do not invent timings; the script prints them.
5. **Do not read the README aloud.** Point at the PASS line and explain the mechanism behind it.

---

## 4. If a beat fails on camera

Do not edit code during the recording. Choose one:

1. **Reset and rerun.** Say: "The stack is probably not on a clean boot; I'll reset and rerun." Then:

   ```bash
   docker compose down -v
   docker compose up -d --build --wait
   ```

2. **If the failure repeats**, show the corresponding unit test or verification script, and explain
   the boundary it exercises. Then continue with the remaining beats.

A recorded recovery is better evidence than a hidden cut.

---

## 5. Post-recording check

- [ ] Duration is between 8 and 12 minutes.
- [ ] Audio is audible in the first 10 seconds and not clipping.
- [ ] The four beat scripts each print their final PASS line.
- [ ] Beat 4's Jaeger screenshot shows all three services in one trace and `ORPHANS=0`.
- [ ] Grafana shows the three service names and non-empty panels.
- [ ] The video shows the clean clone and the tag, not the working directory.
- [ ] `capstone-demo.mp4` is uploaded through the course channel, not committed to the repository.

---

## 6. What not to do

- Do not record from a working copy with uncommitted changes; the marker checks the tag.
- Do not skip the reset before the four beats if you want ids `8001–8005` and the README's exact
  output.
- Do not open `:3001`, `:3002`, `/metrics`, `/internal` or `:5432` in the browser. They are
  intentionally not public; the gateway returns 404 for the internal paths.
- Do not claim a number that is not on screen.
- Do not include the confidential peer reviews in the video or the repository.
