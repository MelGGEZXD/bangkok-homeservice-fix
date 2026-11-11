#!/usr/bin/env bash
# Area C — events, RabbitMQ, duplicate delivery, and an orchestrated saga with compensation.
#
# Proves, against the running stack:
#   1. provider approval commits the flag + saga row + outbox event atomically, and the event reaches
#      the Notifications service through RabbitMQ (queue has a live consumer)
#   2. the saga completes when Notifications reports notification.created
#   3. re-delivering the SAME outbox event (processed_at reset) has exactly one effect
#   4. a second event type, booking.status_changed, also travels through the broker
#   5. turning on the demo fault makes Notifications report notification.failed; the orchestrator
#      compensates by unapproving the provider and emitting provider.approval_reverted
#   6. turning the fault off and retrying completes a fresh saga
#
# Prerequisites: `docker compose up -d --build --wait` and Docker Desktop running.
# Usage: bash scripts/verify-area-c.sh
set -euo pipefail

cd "$(dirname "$0")/.."

API=${API:-http://localhost:3000}
PASSWORD=${DEMO_PASSWORD:-eDemand-2026!}
INTERNAL_KEY=${INTERNAL_API_KEY:-dev-internal-key-change-me}
RABBIT_USER=${RABBITMQ_USER:-edemand}
RABBIT_PASS=${RABBITMQ_PASSWORD:-edemand-demo-pass}
RABBIT_MGMT=${RABBIT_MGMT:-http://localhost:15672}
EXCHANGE=${RABBITMQ_EXCHANGE:-edemand.events}
QUEUE=${NOTIFICATIONS_QUEUE:-edemand.notifications}
GLOW_ID=3
SPARKLE_ID=1
FIXIT_ID=2
SERVICE_ID=4

pass=0
check() {
  if [ "$1" != "$2" ]; then
    echo "FAIL: expected $2, got $1 — $3"
    exit 1
  fi
  pass=$((pass + 1))
  echo "PASS  $3"
}

body() { # body METHOD URL [token] [json-body]
  local method=$1 url=$2 token=${3:-} body=${4:-}
  local args=(-s -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' -d "$body")
  curl "${args[@]}"
}

field() { # field JSON NAME — no jq assumption
  node -e 'const v=JSON.parse(process.argv[1]); const p=process.argv[2].split("."); let x=v; for (const k of p) x=x==null?undefined:x[k]; process.stdout.write(x==null?"":String(x))' "$1" "$2"
}

status() { # status METHOD URL [token] [json-body]
  local method=$1 url=$2 token=${3:-} body=${4:-}
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' -d "$body")
  curl "${args[@]}"
}

db_query() { # db_query SQL [JSON_ARGS] — read rows from the monolith's SQLite inside its container
  docker compose exec -T -e SQL="$1" -e ARGS="${2:-[]}" edemand node -e '
    const Database = require("better-sqlite3");
    const db = new Database("data/edemand.db");
    const stmt = db.prepare(process.env.SQL);
    const args = JSON.parse(process.env.ARGS || "[]");
    process.stdout.write(JSON.stringify(/^\s*(select|pragma)/i.test(process.env.SQL) ? stmt.all(...args) : stmt.run(...args)));
  ' | tr -d '\r'
}

db_scalar() { # db_scalar SQL [JSON_ARGS]
  node -e 'const rows=JSON.parse(process.argv[1]); const r=rows[0]||{}; const v=Object.values(r)[0]; process.stdout.write(v==null?"":String(v))' "$(db_query "$1" "${2:-[]}")"
}

notifications_count() { # notifications_count TOKEN TYPE
  local inbox
  inbox=$(body GET "$API/api/notifications" "$1")
  node -e 'const a=JSON.parse(process.argv[1]); const t=process.argv[2]; process.stdout.write(String(a.filter((n)=>n.type===t).length))' "$inbox" "$2"
}

notifications_type_order() { # notifications_type_order TOKEN TYPE ORDER_ID
  local inbox
  inbox=$(body GET "$API/api/notifications" "$1")
  node -e 'const a=JSON.parse(process.argv[1]); const t=process.argv[2]; const o=Number(process.argv[3]); process.stdout.write(String(a.filter((n)=>n.type===t&&n.order_id===o).length))' "$inbox" "$2" "$3"
}

faults() { # faults true|false
  docker compose exec -T -e VALUE="$1" -e KEY="$INTERNAL_KEY" notifications node -e '
    fetch("http://127.0.0.1:3001/internal/faults", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-key": process.env.KEY },
      body: JSON.stringify({ notification_failure: process.env.VALUE === "true" }),
    }).then((r) => r.text()).then((t) => process.stdout.write(t)).catch((e) => { console.error(e); process.exit(1); });
  ' | tr -d '\r'
}

wait_saga() { # wait_saga SAGA_ID WANTED_STATE
  local id=$1 want=$2 state=""
  for _ in $(seq 1 60); do
    state=$(field "$(body GET "$API/api/admin/sagas/$id" "$admin")" state)
    [ "$state" = "$want" ] && { echo "$state"; return 0; }
    sleep 0.5
  done
  echo "$state"
  return 1
}

wait_notification_count() { # wait_notification_count TOKEN TYPE MIN_COUNT
  local count=0
  for _ in $(seq 1 60); do
    count=$(notifications_count "$1" "$2")
    [ "$count" -ge "$3" ] && { echo "$count"; return 0; }
    sleep 0.5
  done
  echo "$count"
  return 1
}

wait_event_processed() { # wait_event_processed EVENT_TYPE AGGREGATE_ID
  local value="no"
  for _ in $(seq 1 40); do
    value=$(db_scalar "SELECT processed_at FROM events WHERE type = ? AND aggregate_id = ? ORDER BY id DESC LIMIT 1" "[\"$1\",$2]")
    [ -n "$value" ] && { echo "yes"; return 0; }
    sleep 0.5
  done
  echo "no"
  return 1
}

cleanup() {
  faults false >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== waiting for the stack =="
ready=0
for _ in $(seq 1 90); do
  if curl -fsS "$API/api/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
check "$ready" "1" "stack healthy at $API/api/health"

echo "== RabbitMQ topology =="
queue_json=$(curl -s -u "$RABBIT_USER:$RABBIT_PASS" "$RABBIT_MGMT/api/queues/%2F/$QUEUE")
check "$(field "$queue_json" name)" "$QUEUE" "notifications queue exists on RabbitMQ"
consumers=$(field "$queue_json" consumers)
[ -n "$consumers" ] && [ "$consumers" -ge 1 ] || { echo "FAIL: no live consumer on $QUEUE — $queue_json"; exit 1; }
pass=$((pass + 1)); echo "PASS  Notifications service is consuming $QUEUE ($consumers consumer)"
exchange_json=$(curl -s -u "$RABBIT_USER:$RABBIT_PASS" "$RABBIT_MGMT/api/exchanges/%2F/$EXCHANGE")
check "$(field "$exchange_json" name)" "$EXCHANGE" "topic exchange exists"

echo "== login =="
admin=$(field "$(body POST "$API/api/auth/admin/login" "" "{\"email\":\"admin@edemand.test\",\"password\":\"$PASSWORD\"}")" token)
glow=$(field "$(body POST "$API/api/auth/provider/login" "" "{\"email\":\"glow@example.com\",\"password\":\"$PASSWORD\"}")" token)
nong=$(field "$(body POST "$API/api/auth/customer/login" "" "{\"email\":\"nong@example.com\",\"password\":\"$PASSWORD\"}")" token)
fixit=$(field "$(body POST "$API/api/auth/provider/login" "" "{\"email\":\"fixit@example.com\",\"password\":\"$PASSWORD\"}")" token)
[ -n "$admin" ] && [ -n "$glow" ] && [ -n "$nong" ] && [ -n "$fixit" ] || { echo "FAIL: could not log in demo accounts"; exit 1; }
echo "PASS  logged in admin, Glow, Nong and FixIt"

# Deterministic start: Glow pending, fault off.
db_query "UPDATE provider_profiles SET is_approved = 0 WHERE provider_id = ?" "[$GLOW_ID]" >/dev/null
faults false >/dev/null

echo "== beat 1: approval -> outbox -> RabbitMQ -> notification, saga completes =="
approved=$(body POST "$API/api/admin/providers/$GLOW_ID/approve" "$admin")
saga_id=$(field "$approved" "saga_id")
[ -n "$saga_id" ] || { echo "FAIL: approval did not return a saga_id — $approved"; exit 1; }
pass=$((pass + 1)); echo "PASS  approval returned saga $saga_id"

state=$(wait_saga "$saga_id" "completed") || { echo "FAIL: saga stayed '$state'"; exit 1; }
pass=$((pass + 1)); echo "PASS  saga $saga_id completed after notification.created"

notes=$(wait_notification_count "$glow" "provider_approved" 1) || { echo "FAIL: Glow never received provider_approved (count=$notes)"; exit 1; }
pass=$((pass + 1)); echo "PASS  Glow received provider_approved through the extracted service"

evt=$(db_query "SELECT id, event_uid, processed_at FROM events WHERE type = 'provider.approved' AND payload_json LIKE ? ORDER BY id DESC LIMIT 1" "[\"%$saga_id%\"]")
evt_id=$(node -e 'const r=JSON.parse(process.argv[1])[0]; process.stdout.write(r?String(r.id):"")' "$evt")
evt_uid=$(node -e 'const r=JSON.parse(process.argv[1])[0]; process.stdout.write(r?String(r.event_uid):"")' "$evt")
processed=$(node -e 'const r=JSON.parse(process.argv[1])[0]; process.stdout.write(r&&r.processed_at?"yes":"no")' "$evt")
check "$processed" "yes" "the relay published event $evt_uid to RabbitMQ (outbox row processed)"

echo "== beat 2: duplicate delivery still has one effect =="
before=$(notifications_count "$glow" "provider_approved")
db_query "UPDATE events SET processed_at = NULL WHERE id = ?" "[$evt_id]" >/dev/null
sleep 3  # let the relay publish the same event_uid again
after=$(notifications_count "$glow" "provider_approved")
check "$after" "$before" "re-publishing the same event created no second notification (still $after)"
pg_count=$(docker compose exec -T -e UID="$evt_uid" notifications node -e '
  const { Pool } = require("pg");
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  p.query("SELECT COUNT(*)::int AS n FROM notifications WHERE source_event_id = $1", [process.env.UID])
    .then((r) => process.stdout.write(String(r.rows[0].n)))
    .finally(() => p.end());
' | tr -d '\r')
check "$pg_count" "1" "PostgreSQL holds exactly one row for source_event_id $evt_uid"

echo "== beat 3: a second event type (booking.status_changed) crosses too =="
address_id=$(node -e 'const a=JSON.parse(process.argv[1]); process.stdout.write(String(a[0].id))' "$(body GET "$API/api/customer/addresses" "$nong")")
[ -n "$address_id" ] || { echo "FAIL: Nong has no address"; exit 1; }
placed=""
order_id=""
for offset in 3 4 5 6 7 8 9 10; do
  date=$(node -e 'let d=new Date(Date.now()+Number(process.argv[1])*864e5); while(d.getUTCDay()===0)d=new Date(d.getTime()+864e5); process.stdout.write(d.toISOString().slice(0,10))' "$offset")
  for time in 10:00 11:00 12:00 13:00 14:00 15:00 16:00 17:00; do
    placed=$(body POST "$API/api/bookings" "$nong" "{\"provider_id\":$FIXIT_ID,\"address_id\":$address_id,\"service_date\":\"$date\",\"starting_time\":\"$time\",\"items\":[{\"service_id\":$SERVICE_ID,\"quantity\":1}],\"payment_method\":\"cod\"}")
    order_id=$(field "$placed" order.id)
    [ -n "$order_id" ] && break 2
  done
done
[ -n "$order_id" ] || { echo "FAIL: could not place a booking — $placed"; exit 1; }
pass=$((pass + 1)); echo "PASS  placed booking $order_id (emits booking.status_changed)"

booking_published=$(wait_event_processed "booking.status_changed" "$order_id") || { echo "FAIL: booking.status_changed never published"; exit 1; }
check "$booking_published" "yes" "booking.status_changed was published from the outbox"
booking_notes=0
for _ in $(seq 1 60); do
  booking_notes=$(notifications_type_order "$fixit" "booking_status" "$order_id")
  [ "$booking_notes" -ge 1 ] && break
  sleep 0.5
done
check "$booking_notes" "1" "FixIt received exactly one booking_status notification for order $order_id"

echo "== beat 4: injected failure -> compensation -> retry =="
# Make Glow pending again (fixture reset; the compensation itself is what beat 4 proves).
db_query "UPDATE provider_profiles SET is_approved = 0 WHERE provider_id = ?" "[$GLOW_ID]" >/dev/null
approved_before=$(notifications_count "$glow" "provider_approved")
faults true >/dev/null
echo "injected notification failure enabled"

failing=$(body POST "$API/api/admin/providers/$GLOW_ID/approve" "$admin")
failing_saga=$(field "$failing" "saga_id")
[ -n "$failing_saga" ] || { echo "FAIL: failing approval did not start a saga — $failing"; exit 1; }
state=$(wait_saga "$failing_saga" "compensated") || { echo "FAIL: saga stayed '$state' (expected compensated)"; exit 1; }
pass=$((pass + 1)); echo "PASS  notification.failed compensated saga $failing_saga"

is_approved=$(db_scalar "SELECT is_approved FROM provider_profiles WHERE provider_id = ?" "[$GLOW_ID]")
check "$is_approved" "0" "compensating action unapproved Glow"
reverted=$(wait_notification_count "$glow" "provider_approval_reverted" 1) || { echo "FAIL: Glow never received provider_approval_reverted"; exit 1; }
pass=$((pass + 1)); echo "PASS  Glow received provider_approval_reverted"

faults false >/dev/null
retry=$(body POST "$API/api/admin/providers/$GLOW_ID/approve" "$admin")
retry_saga=$(field "$retry" "saga_id")
[ -n "$retry_saga" ] || { echo "FAIL: retry did not start a saga — $retry"; exit 1; }
state=$(wait_saga "$retry_saga" "completed") || { echo "FAIL: retry saga stayed '$state'"; exit 1; }
is_approved=$(db_scalar "SELECT is_approved FROM provider_profiles WHERE provider_id = ?" "[$GLOW_ID]")
check "$is_approved" "1" "retry completed the saga and Glow is approved again"
after_retry=$(wait_notification_count "$glow" "provider_approved" $((approved_before + 1))) || { echo "FAIL: no fresh provider_approved after retry"; exit 1; }
check "$after_retry" "$((approved_before + 1))" "the retry produced exactly one new provider_approved notification"

echo
echo "AREA C PASSED ($pass assertions)"
echo "RabbitMQ console: $RABBIT_MGMT (user: $RABBIT_USER / pass: $RABBIT_PASS)"
echo "Saga just completed: $retry_saga"
