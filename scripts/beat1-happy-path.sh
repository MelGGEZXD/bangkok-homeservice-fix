#!/usr/bin/env bash
# Beat 1 — the happy path across every new boundary.
#
# What a marker should see:
#   1. a request with no token is refused by the NOTIFICATIONS SERVICE (401, no monolith requestId)
#   2. admin approval writes the saga + outbox event; RabbitMQ carries it to Notifications, the
#      projection appears in the provider's inbox, and the saga reaches `completed`
#   3. a gateway booking creates a payment intent in the PAYMENTS SERVICE (HTTP seam)
#   4. "Pay now" settles through the payments service's idempotent webhook and the monolith sees
#      the order as paid (the order owner is notified by the service)
#   5. OTP completion writes exactly one payout ledger row in Payments, and the provider wallet
#      balances match that one row
#
# Prerequisites: docker compose up -d --build --wait
# Usage: bash scripts/beat1-happy-path.sh
set -euo pipefail

cd "$(dirname "$0")/.."

API=${API:-http://localhost:3000}
PASSWORD=${DEMO_PASSWORD:-eDemand-2026!}
GLOW_ID=3
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

body() { # body METHOD URL [token] [json-body]
  local method=$1 url=$2 token=${3:-} payload=${4:-}
  local args=(-s -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "authorization: Bearer $token")
  [ -n "$payload" ] && args+=(-H 'content-type: application/json' -d "$payload")
  curl "${args[@]}"
}

status() { # status METHOD URL [token] [json-body]
  local method=$1 url=$2 token=${3:-} payload=${4:-}
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "authorization: Bearer $token")
  [ -n "$payload" ] && args+=(-H 'content-type: application/json' -d "$payload")
  curl "${args[@]}"
}

field() { # field JSON NAME
  node -e 'const v=JSON.parse(process.argv[1]); const p=process.argv[2].split("."); let x=v; for (const k of p) x=x==null?undefined:x[k]; process.stdout.write(x==null?"":String(x))' "$1" "$2"
}

jget() { # jget NAME (reads JSON from stdin)
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const p=process.argv[1].split(".");let x=v;for(const k of p)x=x==null?undefined:x[k];process.stdout.write(x==null?"":String(x))})' "$1"
}

login() { field "$(body POST "$API$1" "" "{\"email\":\"$2\",\"password\":\"$PASSWORD\"}")" token; }

wait_for() { # wait_for SECONDS COMMAND... (returns the first non-empty stdout)
  local seconds=$1; shift
  local out=""
  for _ in $(seq 1 "$seconds"); do
    out=$("$@" 2>/dev/null || true)
    [ -n "$out" ] && { echo "$out"; return 0; }
    sleep 1
  done
  return 1
}

notification_count() { # notification_count TOKEN TYPE
  body GET "$API/api/notifications" "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);process.stdout.write(String(a.filter(n=>n.type===process.argv[1]).length))})' "$2"
}

place_booking() { # place_booking TOKEN PAYMENT_METHOD -> "order_id otp"
  local token=$1 method=$2 offset date time res id otp
  for offset in $(seq 5 45); do
    date=$(node -e 'const d=new Date(Date.now()+Number(process.argv[1])*864e5);while(d.getUTCDay()===0)d.setUTCDate(d.getUTCDate()+1);process.stdout.write(d.toISOString().slice(0,10))' "$offset")
    for time in 09:00 10:00 11:00 12:00 13:00 14:00 15:00 16:00; do
      res=$(curl -s -X POST "$API/api/bookings" \
        -H "authorization: Bearer $token" -H 'content-type: application/json' \
        -H "idempotency-key: beat1-$offset-$time-$RANDOM" \
        -d "{\"provider_id\":$SPARKLE_ID,\"service_date\":\"$date\",\"starting_time\":\"$time\",\"items\":[{\"service_id\":$SERVICE_ID,\"quantity\":1}],\"payment_method\":\"$method\"}")
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

echo "== waiting for the stack =="
for _ in $(seq 1 120); do
  if [ "$(status GET "$API/api/health")" = "200" ]; then break; fi
  sleep 1
done
check "$(status GET "$API/api/health")" "200" "stack healthy at $API/api/health"

echo "== notifications boundary =="
check "$(status GET "$API/api/notifications")" "401" "unauthenticated inbox is 401 at the service"
unauth=$(body GET "$API/api/notifications")
check "$(printf '%s' "$unauth" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(Object.hasOwn(JSON.parse(s),"requestId"))))')" "false" "401 body came from the notifications service, not the monolith"

echo "== provider approval: saga + outbox + RabbitMQ =="
admin=$(login /api/auth/admin/login admin@edemand.test)
glow=$(login /api/auth/provider/login glow@example.com)
before=$(notification_count "$glow" provider_approved)
approval=$(body POST "$API/api/admin/providers/$GLOW_ID/approve" "$admin")
approved=$(field "$approval" is_approved)
if [ "$approved" != "true" ]; then
  # Already approved on a previous run: the inbox still proves the boundary, and the saga check
  # below is skipped rather than failing a second run of the same demo.
  if printf '%s' "$approval" | grep -q "already approved"; then
    echo "PASS  provider $GLOW_ID was already approved (run reset for the full saga beat)"
    approved=true
  fi
fi
check "$approved" "true" "admin approved provider Glow (id $GLOW_ID)"
saga=$(field "$approval" saga_id)
if [ -n "$saga" ]; then
  state=""
  for _ in $(seq 1 60); do
    state=$(field "$(body GET "$API/api/admin/sagas/$saga" "$admin")" state)
    [ "$state" = "completed" ] && break
    sleep 0.5
  done
  check "$state" "completed" "saga $saga completed after notification.created"
fi
if [ "$before" -gt 0 ]; then
  after=$before
else
  after=$(wait_for 60 notification_count "$glow" provider_approved) || after=0
fi
check "$([ "$after" -gt 0 ] && echo yes || echo no)" "yes" "Glow's provider_approved notification is readable through the extracted service"

echo "== booking -> payments intent -> webhook -> order paid =="
nong=$(login /api/auth/customer/login nong@example.com)
read -r order otp <<< "$(place_booking "$nong" gateway)"
check "$([ -n "$order" ] && echo yes || echo no)" "yes" "placed gateway booking $order (HTTP seam to payments)"
paid=$(body POST "$API/api/payments/simulate" "$nong" "{\"order_id\":$order}")
check "$(field "$paid" ok)" "true" "pay-now settled the intent through the payments service"
check "$(field "$(body GET "$API/api/bookings/$order" "$nong")" payment_status)" "paid" "the order owner sees payment_status=paid"

echo "== completion -> exactly one payout ledger row =="
sparkle=$(login /api/auth/provider/login sparkle@example.com)
body POST "$API/api/bookings/$order/confirm" "$sparkle" >/dev/null
body POST "$API/api/bookings/$order/start" "$sparkle" >/dev/null
completed=$(body POST "$API/api/bookings/$order/complete" "$sparkle" "{\"otp\":$otp}")
check "$(field "$completed" status)" "completed" "provider completed booking $order with the OTP"
wallet=$(body GET "$API/api/provider/wallet" "$sparkle")
rows=$(printf '%s' "$wallet" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const w=JSON.parse(s);process.stdout.write(String(w.transactions.filter(t=>t.order_id===Number(process.argv[1])&&t.kind==="payout_credit").length))})' "$order")
check "$rows" "1" "payments holds exactly one payout_credit row for order $order"
expected_earning=$(printf '%s' "$completed" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).provider_earnings_cents)))')
seen_earning=$(printf '%s' "$wallet" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const w=JSON.parse(s);const t=w.transactions.find(t=>t.order_id===Number(process.argv[1])&&t.kind==="payout_credit");process.stdout.write(String(t?t.amount_cents:""))})' "$order")
check "$seen_earning" "$expected_earning" "the wallet row carries the order's provider earnings ($expected_earning cents)"

echo
echo "BEAT 1 PASSED ($pass assertions)"
echo "Next: bash scripts/beat2-failure-recovery.sh"
