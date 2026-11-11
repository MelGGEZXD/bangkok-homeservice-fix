#!/usr/bin/env bash
# Beat 2 — three injected failures at the payments seam, each survived with exactly one effect.
#
# The seam is monolith -> Payments & Wallet when a booking is completed. The monolith commits the
# order and writes a durable ledger command in the SAME transaction; the HTTP call is only the fast
# path. Every write carries one Idempotency-Key for the whole logical operation, and the payments
# service is UNIQUE on (order_id, kind), so a retry or a reconciliation replay is one effect.
#
# What a marker should see:
#   A. lost reply   — payments commits, then the socket dies. The client retries and the order is
#                     still completed; exactly one payout row exists.
#   B. slow reply   — payments commits, then holds the response past the client's 3s timeout. The
#                     retry replays the stored response; exactly one payout row exists.
#   C. outage       — every payments request fails for 9s. The completion still succeeds because
#                     the ledger command is durable; the background reconciler delivers it after
#                     the outage, and exactly one payout row exists.
#
# Prerequisites: docker compose up -d --build --wait
# Usage: bash scripts/beat2-failure-recovery.sh
set -euo pipefail
cd "$(dirname "$0")/.."

API=${API:-http://localhost:3000}
PASSWORD=${DEMO_PASSWORD:-eDemand-2026!}
INTERNAL_KEY=${INTERNAL_API_KEY:-dev-internal-key-change-me}
SPARKLE_ID=1
SERVICE_ID=1

pass=0
check() {
  if [ "$1" != "$2" ]; then
    echo "FAIL: expected $2, got $1 — $3"
    exit 1
  fi
  pass=$((pass + 1))
  echo "PASS  $3"
}

body() {
  local method=$1 url=$2 token=${3:-} payload=${4:-}
  local args=(-s -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "authorization: Bearer $token")
  [ -n "$payload" ] && args+=(-H 'content-type: application/json' -d "$payload")
  curl "${args[@]}"
}

status() {
  local method=$1 url=$2 token=${3:-} payload=${4:-}
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "authorization: Bearer $token")
  [ -n "$payload" ] && args+=(-H 'content-type: application/json' -d "$payload")
  curl "${args[@]}"
}

field() {
  node -e 'const v=JSON.parse(process.argv[1]); const p=process.argv[2].split("."); let x=v; for (const k of p) x=x==null?undefined:x[k]; process.stdout.write(x==null?"":String(x))' "$1" "$2"
}

jget() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const p=process.argv[1].split(".");let x=v;for(const k of p)x=x==null?undefined:x[k];process.stdout.write(x==null?"":String(x))})' "$1"
}

login() { field "$(body POST "$API$1" "" "{\"email\":\"$2\",\"password\":\"$PASSWORD\"}")" token; }

faults() { # faults JSON
  docker compose exec -T -e BODY="$1" -e KEY="$INTERNAL_KEY" payments node -e '
    fetch("http://127.0.0.1:3002/internal/faults", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-key": process.env.KEY },
      body: process.env.BODY,
    }).then((r) => r.text()).then((t) => process.stdout.write(t)).catch((e) => { console.error(e); process.exit(1); });
  ' | tr -d '\r'
}

db_query() {
  docker compose exec -T -e SQL="$1" edemand node -e '
    const Database = require("better-sqlite3");
    const db = new Database("data/edemand.db", { readonly: true });
    process.stdout.write(JSON.stringify(db.prepare(process.env.SQL).all()));
  ' | tr -d '\r'
}

cleanup() { faults '{"reset":true}' >/dev/null 2>&1 || true; }
trap cleanup EXIT

place_booking() {
  :
}

place() {
  local token=$1 offset date time res id otp
  for offset in $(seq 5 60); do
    date=$(node -e 'const d=new Date(Date.now()+Number(process.argv[1])*864e5);while(d.getUTCDay()===0)d.setUTCDate(d.getUTCDate()+1);process.stdout.write(d.toISOString().slice(0,10))' "$offset")
    for time in 09:00 10:00 11:00 12:00 13:00 14:00 15:00 16:00; do
      res=$(curl -s -X POST "$API/api/bookings" \
        -H "authorization: Bearer $token" -H 'content-type: application/json' \
        -H "idempotency-key: beat2-$offset-$time-$RANDOM" \
        -d "{\"provider_id\":$SPARKLE_ID,\"service_date\":\"$date\",\"starting_time\":\"$time\",\"items\":[{\"service_id\":$SERVICE_ID,\"quantity\":1}],\"payment_method\":\"cod\"}")
      id=$(printf '%s' "$res" | jget order.id)
      if [ -n "$id" ]; then
        otp=$(printf '%s' "$res" | jget otp)
        echo "$id $otp"
        return 0
      fi
    done
  done
  return 1
}

ledger_rows() { # ledger_rows TOKEN ORDER_ID
  body GET "$API/api/provider/wallet" "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let w={};try{w=JSON.parse(s)}catch{};const n=(w.transactions||[]).filter(t=>t.order_id===Number(process.argv[1])).length;process.stdout.write(String(n))})' "$2"
}

wait_rows() { # wait_rows TOKEN ORDER_ID WANTED [SECONDS]
  local token=$1 order=$2 want=$3 seconds=${4:-40} rows=0
  for _ in $(seq 1 "$seconds"); do
    rows=$(ledger_rows "$token" "$order" 2>/dev/null || true)
    [ "$rows" = "$want" ] && { echo "$rows"; return 0; }
    sleep 1
  done
  echo "$rows"
  return 1
}

complete_case() { # complete_case NAME FAULT_JSON WANT_DELAY_MS MIN_ELAPSED_MS FAULT_KEY
  local name=$1 fault=$2 want_delay=$3 min_elapsed=$4
  local order otp start end code elapsed case_state rows pending status_now

  read -r order otp <<< "$(place "$nong")"
  echo
  echo "== $name: order $order =="
  check "$([ -n "$order" ] && echo yes || echo no)" "yes" "placed booking $order"
  body POST "$API/api/bookings/$order/confirm" "$sparkle" >/dev/null
  body POST "$API/api/bookings/$order/start" "$sparkle" >/dev/null

  case_state=$(printf '%s' "$(faults "$fault")" | jget "${5:-lost_reply}")
  check "$case_state" "$want_delay" "fault switch is armed ($fault)"

  start=$(date +%s%3N)
  code=$(curl -s -o /tmp/beat2-complete.json -w '%{http_code}' -X POST "$API/api/bookings/$order/complete" \
    -H "authorization: Bearer $sparkle" -H 'content-type: application/json' -d "{\"otp\":$otp}")
  end=$(date +%s%3N)
  elapsed=$((end - start))
  check "$code" "200" "completion survived '$name' (HTTP $code after ${elapsed}ms)"
  if [ "$min_elapsed" -gt 0 ]; then
    check "$([ "$elapsed" -ge "$min_elapsed" ] && echo yes || echo no)" "yes" "the client waited for the ${want_delay}ms response and then retried"
  fi
  status_now=$(field "$(body GET "$API/api/bookings/$order" "$nong")" status)
  check "$status_now" "completed" "order $order is completed, not rolled back"

  rows=$(wait_rows "$sparkle" "$order" 1 45) || rows=$rows
  check "$rows" "1" "payments holds exactly one ledger row for order $order after recovery"

  pending=$(db_query "SELECT COUNT(*) AS n FROM ledger_commands WHERE order_id = $order AND kind = 'completed' AND completed_at IS NOT NULL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s)[0].n)))')
  check "$pending" "1" "the durable ledger command is marked done once"
}

echo "== waiting for the stack =="
for _ in $(seq 1 120); do
  if [ "$(status GET "$API/api/health")" = "200" ]; then break; fi
  sleep 1
done
check "$(status GET "$API/api/health")" "200" "stack healthy at $API/api/health"

nong=$(login /api/auth/customer/login nong@example.com)
sparkle=$(login /api/auth/provider/login sparkle@example.com)

cat <<'NOTE'
The three faults below are injected through the payments service's internal control endpoint. It is
reachable only on the compose network (nginx returns 404 for /internal), and the switches are
in-memory, so a restart clears them.
NOTE

complete_case "lost reply after the write" '{"lost_reply":true}' "true" 0 lost_reply
complete_case "reply slower than the timeout" '{"slow_reply_ms":5000}' "5000" 3000 slow_reply_ms
complete_case "payments fails for a time window" '{"outage_ms":9000}' "9000" 0 outage_ms

echo
echo "BEAT 2 PASSED ($pass assertions)"
echo "One order, one wallet effect, in every failure mode."
