#!/usr/bin/env bash
# Beat 3 — auth rejection (Area B).
#
# Proves, against the running stack:
#   1. a real Keycloak token is accepted by the monolith AND independently by the extracted service
#   2. a forged signature gets 401 at both boundaries
#   3. an expired Keycloak token gets 401 at both boundaries
#   4. a valid token for the wrong audience gets 401 at both boundaries
#   5. the service enforces record ownership (another user cannot mark your notification read)
#   6. the inherited BOLA is fixed: a stranger cannot read another customer's job by id
#
# Prerequisites: `docker compose up -d --build` and the stack healthy.
# Usage: bash scripts/beat3-auth-rejection.sh
set -euo pipefail

cd "$(dirname "$0")/.."

API=${API:-http://localhost:3000}
KEYCLOAK=${KEYCLOAK:-http://localhost:8081}
REALM=${REALM:-edemand}
PASSWORD=${DEMO_PASSWORD:-eDemand-2026!}
CLIENT=${CLIENT_ID:-edemand-web}

pass=0
check() {
  if [ "$1" != "$2" ]; then
    echo "FAIL: expected $2, got $1 — $3"
    exit 1
  fi
  pass=$((pass + 1))
  echo "PASS  $3"
}

status() { # status METHOD URL [token] [json-body]
  local method=$1 url=$2 token=${3:-} body=${4:-}
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' -d "$body")
  curl "${args[@]}"
}

body() { # body METHOD URL [token] [json-body]
  local method=$1 url=$2 token=${3:-} body=${4:-}
  local args=(-s -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' -d "$body")
  curl "${args[@]}"
}

field() { # field JSON NAME — no jq on a stock Windows shell
  node -e 'const v=JSON.parse(process.argv[1]); const p=process.argv[2].split("."); let x=v; for (const k of p) x=x==null?undefined:x[k]; process.stdout.write(x==null?"":String(x))' "$1" "$2"
}

claims() { # claims JWT NAME
  node -e 'const t=process.argv[1].split(".")[1].replace(/-/g,"+").replace(/_/g,"/"); const j=JSON.parse(Buffer.from(t,"base64").toString()); const k=process.argv[2]; const v=j[k]; process.stdout.write(Array.isArray(v)?v.join(","):String(v??""))' "$1" "$2"
}

kc_token() { # kc_token CLIENT
  local res
  res=$(curl -s -X POST "$KEYCLOAK/realms/$REALM/protocol/openid-connect/token" \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode "grant_type=password" \
    --data-urlencode "client_id=$1" \
    --data-urlencode "username=nong@example.com" \
    --data-urlencode "password=$PASSWORD")
  field "$res" access_token
}

service_status() { # service_status TOKEN — call the extracted service directly, inside its container
  docker compose exec -T -e PROBE_TOKEN="$1" notifications node -e '
    fetch("http://127.0.0.1:3001/api/notifications", { headers: { authorization: "Bearer " + process.env.PROBE_TOKEN } })
      .then((r) => { console.log(r.status); })
      .catch(() => { console.log(0); });
  ' | tr -d '\r'
}

echo "== waiting for the stack =="
ready=0
for _ in $(seq 1 90); do
  if curl -fsS "$API/api/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
check "$ready" "1" "stack healthy at $API/api/health"

echo "== real token =="
login=$(curl -s -X POST "$API/api/auth/customer/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"nong@example.com\",\"password\":\"$PASSWORD\"}")
token=$(field "$login" token)
[ -n "$token" ] || { echo "FAIL: could not log in as nong — $login"; exit 1; }
echo "iss=$(claims "$token" iss) aud=$(claims "$token" aud) role=$(claims "$token" role) local_id=$(claims "$token" local_id)"
check "$(claims "$token" iss)" "$KEYCLOAK/realms/$REALM" "token issuer is Keycloak"
case "$(claims "$token" aud)" in *edemand-api*) pass=$((pass+1)); echo "PASS  token audience includes edemand-api";; *) echo "FAIL: audience is $(claims "$token" aud)"; exit 1;; esac
check "$(status GET "$API/api/me" "$token")" "200" "the monolith accepts the real token"
check "$(service_status "$token")" "200" "the extracted service verifies the same token itself"

echo "== forged signature =="
forged="${token%????}AAAA"
check "$(status GET "$API/api/notifications" "$forged")" "401" "monolith rejects a forged signature"
check "$(service_status "$forged")" "401" "extracted service rejects a forged signature"

echo "== wrong audience =="
wrong=$(kc_token edemand-other)
[ -n "$wrong" ] || { echo "FAIL: Keycloak did not issue a wrong-audience token"; exit 1; }
echo "wrong-audience token aud=$(claims "$wrong" aud)"
check "$(status GET "$API/api/notifications" "$wrong")" "401" "monolith rejects a token for the wrong audience"
check "$(service_status "$wrong")" "401" "extracted service rejects a token for the wrong audience"

echo "== expired token =="
short=$(kc_token edemand-short)
[ -n "$short" ] || { echo "FAIL: Keycloak did not issue a short-lived token"; exit 1; }
echo "short-lived token exp=$(claims "$short" exp); sleeping 7s"
sleep 7
check "$(status GET "$API/api/notifications" "$short")" "401" "monolith rejects an expired token"
check "$(service_status "$short")" "401" "extracted service rejects an expired token"

echo "== service-side ownership =="
admin=$(field "$(curl -s -X POST "$API/api/auth/admin/login" -H 'content-type: application/json' \
  -d "{\"email\":\"admin@edemand.test\",\"password\":\"$PASSWORD\"}")" token)
approve=$(status POST "$API/api/admin/providers/3/approve" "$admin")
case "$approve" in 200|201|409) pass=$((pass+1)); echo "PASS  provider 3 approved (or already approved)";; *) echo "FAIL: approve returned $approve"; exit 1;; esac
glow=$(field "$(curl -s -X POST "$API/api/auth/provider/login" -H 'content-type: application/json' \
  -d "{\"email\":\"glow@example.com\",\"password\":\"$PASSWORD\"}")" token)
notes=""
for _ in $(seq 1 20); do
  notes=$(body GET "$API/api/notifications" "$glow")
  [ "$(field "$notes" length)" != "0" ] && break
  sleep 0.5
done
note_id=$(node -e 'const a=JSON.parse(process.argv[1]); process.stdout.write(a.length?String(a[0].id):"")' "$notes")
[ -n "$note_id" ] || { echo "FAIL: Glow has no notification to test ownership with"; exit 1; }
check "$(status POST "$API/api/notifications/$note_id/read" "$token")" "403" "another user cannot mark Glow's notification read"
check "$(status POST "$API/api/notifications/$note_id/read" "$glow")" "200" "the owner can mark it read"

echo "== inherited BOLA is fixed =="
stamp=$(date +%s)
email_a="beat3-a-$stamp@example.com"
email_b="beat3-b-$stamp@example.com"
reg_a=$(body POST "$API/api/auth/customer/register" "" "{\"email\":\"$email_a\",\"password\":\"$PASSWORD\",\"name\":\"Beat Three A\"}")
reg_b=$(body POST "$API/api/auth/customer/register" "" "{\"email\":\"$email_b\",\"password\":\"$PASSWORD\",\"name\":\"Beat Three B\"}")
[ "$(field "$reg_a" id)" != "" ] && [ "$(field "$reg_b" id)" != "" ] || { echo "FAIL: could not register two customers"; exit 1; }
a=$(field "$(curl -s -X POST "$API/api/auth/customer/login" -H 'content-type: application/json' -d "{\"email\":\"$email_a\",\"password\":\"$PASSWORD\"}")" token)
b=$(field "$(curl -s -X POST "$API/api/auth/customer/login" -H 'content-type: application/json' -d "{\"email\":\"$email_b\",\"password\":\"$PASSWORD\"}")" token)
day=$(date -d '+5 days' +%Y-%m-%d 2>/dev/null || date -v+5d +%Y-%m-%d)
job=$(body POST "$API/api/jobs" "$a" "{\"category_id\":4,\"title\":\"BOLA probe\",\"min_price_cents\":30000,\"max_price_cents\":90000,\"window_start\":\"$day 10:00\",\"window_end\":\"$day 17:00\"}")
job_id=$(field "$job" id)
[ -n "$job_id" ] || { echo "FAIL: could not post a job — $job"; exit 1; }
check "$(status GET "$API/api/jobs/$job_id" "$b")" "403" "an unrelated customer cannot read the job (was 200 before the fix)"
check "$(status GET "$API/api/jobs/$job_id" "$a")" "200" "the owner still reads the job"
fixit=$(field "$(curl -s -X POST "$API/api/auth/provider/login" -H 'content-type: application/json' -d "{\"email\":\"fixit@example.com\",\"password\":\"$PASSWORD\"}")" token)
check "$(status GET "$API/api/jobs/$job_id" "$fixit")" "200" "a provider may still browse an open job"

echo
echo "AREA B PASSED ($pass assertions)"
echo "Keycloak realm: $KEYCLOAK/realms/$REALM (admin console http://localhost:8081, admin/admin in the demo)"
