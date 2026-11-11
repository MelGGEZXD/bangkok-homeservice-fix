#!/usr/bin/env bash
# Beat 4 — one request, one trace, across both seams.
#
# The request is a gateway booking: the monolith writes the order + payment intent, calls the
# Payments service over HTTP, and writes an outbox row. Seconds later the relay publishes the row
# to RabbitMQ and the Notifications service projects it.
#
# What a marker should see:
#   * the response carries x-trace-id and a W3C traceparent
#   * Jaeger holds ONE trace with spans from edemand, payments AND notifications
#   * every span except the root is a child of another span in the same trace (no broken links)
#   * the trace is openable in the Jaeger UI at the printed URL
#
# Prerequisites: docker compose up -d --build --wait
# Usage: bash scripts/beat4-find-the-trace.sh
set -euo pipefail
cd "$(dirname "$0")/.."

API=${API:-http://localhost:3000}
JAEGER=${JAEGER:-http://localhost:16686}
PASSWORD=${DEMO_PASSWORD:-eDemand-2026!}
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

field() {
  node -e 'const v=JSON.parse(process.argv[1]); const p=process.argv[2].split("."); let x=v; for (const k of p) x=x==null?undefined:x[k]; process.stdout.write(x==null?"":String(x))' "$1" "$2"
}

status() {
  local method=$1 url=$2
  curl -s -o /dev/null -w '%{http_code}' -X "$method" "$url"
}

echo "== waiting for the stack and Jaeger =="
for _ in $(seq 1 120); do
  [ "$(status GET "$API/api/health")" = "200" ] && break
  sleep 1
done
check "$(status GET "$API/api/health")" "200" "stack healthy at $API/api/health"
for _ in $(seq 1 60); do
  [ "$(status GET "$JAEGER/api/services")" = "200" ] && break
  sleep 1
done
check "$(status GET "$JAEGER/api/services")" "200" "Jaeger API reachable at $JAEGER"

nong=$(field "$(body POST "$API/api/auth/customer/login" "" "{\"email\":\"nong@example.com\",\"password\":\"$PASSWORD\"}")" token)
check "$([ -n "$nong" ] && echo yes || echo no)" "yes" "logged in the customer"

echo "== making one request that crosses both seams =="
trace=""
traceparent=""
order=""
for offset in $(seq 5 60); do
  date=$(node -e 'const d=new Date(Date.now()+Number(process.argv[1])*864e5);while(d.getUTCDay()===0)d.setUTCDate(d.getUTCDate()+1);process.stdout.write(d.toISOString().slice(0,10))' "$offset")
  for time in 09:00 10:00 11:00 12:00 13:00 14:00 15:00 16:00; do
    headers=$(mktemp)
    code=$(curl -s -D "$headers" -o /tmp/beat4-body.json -w '%{http_code}' -X POST "$API/api/bookings" \
      -H "authorization: Bearer $nong" -H 'content-type: application/json' \
      -H "idempotency-key: beat4-$offset-$time-$RANDOM" \
      -d "{\"provider_id\":$SPARKLE_ID,\"service_date\":\"$date\",\"starting_time\":\"$time\",\"items\":[{\"service_id\":$SERVICE_ID,\"quantity\":1}],\"payment_method\":\"gateway\"}")
    if [ "$code" = "201" ]; then
      trace=$(tr -d '\r' < "$headers" | awk 'tolower($1)=="x-trace-id:"{print $2}')
      traceparent=$(tr -d '\r' < "$headers" | awk 'tolower($1)=="traceparent:"{print $2}')
      order=$(field "$(cat /tmp/beat4-body.json)" order.id)
      rm -f "$headers"
      break 2
    fi
    rm -f "$headers"
  done
done
check "$([ -n "$order" ] && echo yes || echo no)" "yes" "placed gateway booking $order"
check "$([ -n "$trace" ] && [ ${#trace} -eq 32 ] && echo yes || echo no)" "yes" "response carries a 32-hex x-trace-id ($trace)"
check "$([ -n "$traceparent" ] && echo yes || echo no)" "yes" "the same response carries a W3C traceparent ($traceparent)"

echo "== waiting for the asynchronous half of the trace =="
services=""
spans=""
for _ in $(seq 1 45); do
  payload=$(curl -s "$JAEGER/api/traces/$trace" || true)
  services=$(printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(!j.data||!j.data[0])return process.stdout.write("");const p=j.data[0].processes;process.stdout.write([...new Set(Object.values(p).map(x=>x.serviceName))].sort().join(","))}catch{process.stdout.write("")}})')
  # Wait for all three processes. Each service exports its own batch, so the notifications span can
  # land before the monolith or payments batch; breaking on notifications alone is a race.
  if printf '%s' "$services" | grep -qx 'edemand,notifications,payments'; then break; fi
  sleep 1
done

check "$([ -n "$services" ] && echo yes || echo no)" "yes" "Jaeger found the trace by id"
check "$(printf '%s' "$services" | tr ',' '\n' | grep -c '^edemand$')" "1" "the monolith contributed spans"
check "$(printf '%s' "$services" | tr ',' '\n' | grep -c '^payments$')" "1" "the payments service continued the HTTP trace"
check "$(printf '%s' "$services" | tr ',' '\n' | grep -c '^notifications$')" "1" "the notifications service continued the RabbitMQ trace"

payload=$(curl -s "$JAEGER/api/traces/$trace")
printf '%s' "$payload" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const t=JSON.parse(s).data[0];
    const svc={}; for (const [id,p] of Object.entries(t.processes)) svc[id]=p.serviceName;
    const ids=new Set(t.spans.map(x=>x.spanID));
    const orphans=t.spans.filter(x=>Array.isArray(x.references)&&x.references.length>0&&!x.references.every(r=>ids.has(r.spanID)));
    console.log("ORPHANS=" + orphans.length);
    console.log("SPANS");
    for (const sp of t.spans.sort((a,b)=>a.startTime-b.startTime)) {
      console.log(`  ${svc[sp.processID].padEnd(14)} ${sp.operationName} (${Math.round(sp.duration/1000)}ms)`);
    }
  })' > /tmp/beat4-spans.txt
cat /tmp/beat4-spans.txt
check "$(grep -c '^ORPHANS=0$' /tmp/beat4-spans.txt || true)" "1" "every child span points at a parent in the same trace"
span_count=$(grep -c "^  " /tmp/beat4-spans.txt || true)
check "$([ "$span_count" -ge 6 ] && echo yes || echo no)" "yes" "one trace contains all $span_count spans"

echo
echo "BEAT 4 PASSED ($pass assertions)"
echo "Open the trace: $JAEGER/trace/$trace"
echo "Grafana (request rate, error rate, p95 latency per service): http://localhost:3005"
echo "The same trace id is in every log line and in each service's x-trace-id response header."
