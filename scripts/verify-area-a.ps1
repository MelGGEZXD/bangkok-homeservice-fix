# Area A verification script (Windows PowerShell).
#
# What it proves:
#   1. the docker compose stack boots healthy
#   2. the gateway routes /api/notifications to the extracted service, not the monolith
#   3. admin approval writes an outbox event and the relay delivers ONE notification
#   4. the notifications service enforces record ownership (403 for another user)
#   5. the monolith SQLite file has no notifications table
#   6. a replayed internal delivery returns duplicate:true (exactly-one effect)
#   7. the gateway routes wallet/ledger reads to the SECOND extracted service (payments)
#   8. the payments service verifies the Keycloak token itself and enforces role ownership
#   9. the monolith SQLite file has none of the four moved money tables
#  10. a gateway webhook settles a booking once; a replay is a 200 no-op (one charge row)
#  11. provider registration writes a wallet into the payments database, not the monolith
#
# It resets the compose volumes first, so the run is deterministic.
# Usage:  powershell -ExecutionPolicy Bypass -File .\scripts\verify-area-a.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$base = "http://localhost:3000"
$pass = 0

# Windows PowerShell 5.1 turns a native command's stderr into a terminating NativeCommandError when
# $ErrorActionPreference is "Stop" (docker writes build progress to stderr). Run native tools with a
# local Continue preference so their output stays data, while cmdlet failures still stop the script.
function Invoke-Quietly([scriptblock]$Block) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { return (& $Block 2>&1) }
  finally { $ErrorActionPreference = $previous }
}

function Check($condition, $message) {
  if (-not $condition) { throw "FAIL: $message" }
  $script:pass++
  Write-Host ("PASS  " + $message) -ForegroundColor Green
}

function Login($path, $email) {
  $body = @{ email = $email; password = "eDemand-2026!" } | ConvertTo-Json -Compress
  return (Invoke-RestMethod -Method Post -Uri ($base + $path) -ContentType "application/json" -Body $body).token
}

function Status($argsList) {
  $out = Invoke-Quietly { & curl.exe -s -o NUL -w "%{http_code}" @argsList }
  return (@($out) -join "").Trim()
}

Write-Host "== resetting stack and booting ==" -ForegroundColor Cyan
Invoke-Quietly { & docker compose down -v --remove-orphans } | Out-Null
Invoke-Quietly { & docker compose up -d --build --wait } | Out-Null

# --wait has been observed to return 1 on some Compose versions even when every healthcheck is
# green, so verify the actual HTTP health instead of trusting that exit code.
# Keycloak's realm import (Area B) has to finish before the monolith can load its JWKS and report
# healthy, so allow up to 90 seconds on a cold, freshly-rebuilt stack.
$healthy = $false
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Milliseconds 1000
  try {
    $h = Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 2
    if ($h.status -eq "ok") { $healthy = $true; break }
  } catch { }
}
Check $healthy "gateway and monolith are healthy at $base/api/health"

Write-Host "== checking gateway routing ==" -ForegroundColor Cyan
$body401 = (Invoke-Quietly { & curl.exe -s "$base/api/notifications" }) -join ""
Check ((Status @("-s", "-o", "NUL", "-w", "%{http_code}", "$base/api/notifications")) -eq "401") "unauthenticated inbox is 401"
Check ($body401 -match "missing bearer token") "401 body came from the notifications service (no monolith requestId)"
Check ($body401 -notmatch "requestId") "response is not the monolith error shape"

Write-Host "== approving a provider and delivering across the boundary ==" -ForegroundColor Cyan
$admin = Login "/api/auth/admin/login" "admin@edemand.test"
$approved = Invoke-RestMethod -Method Post -Uri "$base/api/admin/providers/3/approve" -Headers @{ Authorization = "Bearer $admin" }
Check ($approved.is_approved -eq $true) "admin approved pending provider Glow (id 3)"

$glow = Login "/api/auth/provider/login" "glow@example.com"
$notes = @()
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  $notes = Invoke-RestMethod -Method Get -Uri "$base/api/notifications" -Headers @{ Authorization = "Bearer $glow" }
  if ($null -eq $notes) { $notes = @() }
  if ($notes.Count -gt 0) { break }
}
Check ($notes.Count -ge 1) "relay delivered a notification and Glow can read it through the gateway"
$note = $notes[0]
Check ($note.type -eq "provider_approved") "newest notification is provider_approved"
Check ($note.read_at -eq $null) "notification starts unread"

Write-Host "== checking ownership ==" -ForegroundColor Cyan
$nong = Login "/api/auth/customer/login" "nong@example.com"
$cross = Status @("-s", "-o", "NUL", "-w", "%{http_code}", "-X", "POST", "-H", "Authorization: Bearer $nong", "$base/api/notifications/$($note.id)/read")
Check ($cross -eq "403") "another user cannot mark Glow's notification read (403)"

$read = Invoke-RestMethod -Method Post -Uri "$base/api/notifications/$($note.id)/read" -Headers @{ Authorization = "Bearer $glow" }
Check ($read.read_at -ne $null) "the owner can mark it read"

$nongNotes = Invoke-RestMethod -Method Get -Uri "$base/api/notifications" -Headers @{ Authorization = "Bearer $nong" }
if ($null -eq $nongNotes) { $nongNotes = @() }
Check ($nongNotes.Count -eq 0) "Nong's inbox does not leak Glow's notification"

Write-Host "== checking the monolith no longer owns the table ==" -ForegroundColor Cyan
$dbCheck = @'
const Database = require("better-sqlite3");
const db = new Database("/app/data/edemand.db", { readonly: true });
const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'").all();
console.log(JSON.stringify(rows));
'@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dbCheck))
$dbOut = (Invoke-Quietly { & docker compose exec -T edemand node -e "eval(Buffer.from('$b64','base64').toString())" }) -join ""
Check ($dbOut.Trim() -eq "[]") "monolith SQLite has no notifications table"

Write-Host "== checking duplicate delivery has one effect ==" -ForegroundColor Cyan
$probe = @'
const body = {
  source_event_id: "22222222-2222-4222-8222-222222222222",
  recipient_role: "customer",
  recipient_id: 1,
  type: "verify_probe",
  title: "Verify probe",
  body: "This must exist exactly once.",
  order_id: null
};
async function post() {
  const res = await fetch("http://127.0.0.1:3001/internal/notifications", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-key": process.env.INTERNAL_API_KEY || "dev-internal-key-change-me"
    },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}
(async () => {
  const first = await post();
  const second = await post();
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const rows = await pool.query("select count(*)::int as n from notifications where type = $1", ["verify_probe"]);
  await pool.end();
  console.log(JSON.stringify({ first, second, count: rows.rows[0].n }));
})();
'@
$b64Probe = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($probe))
$probeOut = (Invoke-Quietly { & docker compose exec -T notifications node -e "eval(Buffer.from('$b64Probe','base64').toString())" }) -join ""
$result = $probeOut | ConvertFrom-Json
Check ($result.first.body.duplicate -eq $false) "first internal delivery creates the notification"
Check ($result.second.body.duplicate -eq $true) "replayed internal delivery is recognised as duplicate"
Check ([int]$result.count -eq 1) "database contains exactly one row for the probe"

Write-Host "== checking the second extracted service: Payments & Wallet ==" -ForegroundColor Cyan
$wallet401 = (Invoke-Quietly { & curl.exe -s "$base/api/provider/wallet" }) -join ""
Check ((Status @("-s", "-o", "NUL", "-w", "%{http_code}", "$base/api/provider/wallet")) -eq "401") "unauthenticated wallet read is 401"
Check ($wallet401 -match "missing bearer token") "401 body came from the payments service"
Check ($wallet401 -notmatch "requestId") "wallet response is not the monolith error shape"

$sparkle = Login "/api/auth/provider/login" "sparkle@example.com"
$wallet = Invoke-RestMethod -Uri "$base/api/provider/wallet" -Headers @{ Authorization = "Bearer $sparkle" }
Check ($wallet.provider_id -eq 1) "Sparkle reads her own wallet through the gateway"
Check ($wallet.balance_cents -ge 0) "wallet carries a balance field from the payments service"

$nong = Login "/api/auth/customer/login" "nong@example.com"
$crossRole = Status @("-s", "-o", "NUL", "-w", "%{http_code}", "$base/api/provider/wallet", "-H", "Authorization: Bearer $nong")
Check ($crossRole -eq "403") "a customer token cannot read the provider wallet (403 from the payments service)"

$moneyDbCheck = @'
const Database = require("better-sqlite3");
const db = new Database("/app/data/edemand.db", { readonly: true });
const names = ["payment_intents", "transactions", "provider_wallets", "webhook_events"];
const rows = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN (" + names.map(() => "?").join(",") + ")"
).all(...names);
console.log(JSON.stringify(rows));
'@
$b64Money = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($moneyDbCheck))
$moneyOut = (Invoke-Quietly { & docker compose exec -T edemand node -e "eval(Buffer.from('$b64Money','base64').toString())" }) -join ""
Check ($moneyOut.Trim() -eq "[]") "monolith SQLite has none of the four payments tables"

Write-Host "== settling a gateway booking across the boundary ==" -ForegroundColor Cyan
$when = (Get-Date).AddDays(3)
if ($when.DayOfWeek -eq "Sunday") { $when = $when.AddDays(1) }
$date = $when.ToString("yyyy-MM-dd")
$bookingBody = @{
  provider_id = 1; address_id = 1; service_date = $date; starting_time = "09:00";
  items = @(@{ service_id = 2; quantity = 1 }); payment_method = "gateway"
} | ConvertTo-Json -Depth 5 -Compress
$placed = Invoke-RestMethod -Method Post -Uri "$base/api/bookings" -ContentType "application/json" -Headers @{ Authorization = "Bearer $nong" } -Body $bookingBody
Check ($placed.payment_intent.status -eq "requires_payment") "booking created a requires_payment intent in the payments service"
Check ($placed.payment_intent.gateway_ref -match "^SIM-PI-") "the intent reference crossed the seam"
$orderId = $placed.order.id
$gatewayRef = $placed.payment_intent.gateway_ref

$eventBody = @{ gateway_event_id = "area-a-verify-evt-1"; type = "payment_intent.succeeded"; gateway_ref = $gatewayRef } | ConvertTo-Json -Compress
$first = Invoke-RestMethod -Method Post -Uri "$base/api/payments/webhook" -ContentType "application/json" -Headers @{ "X-Webhook-Secret" = "edemand-webhook-secret" } -Body $eventBody
Check ($first.settled -eq $true) "first gateway webhook settles the intent"
$second = Invoke-RestMethod -Method Post -Uri "$base/api/payments/webhook" -ContentType "application/json" -Headers @{ "X-Webhook-Secret" = "edemand-webhook-secret" } -Body $eventBody
Check ($second.replayed -eq $true) "replaying the same gateway event id is a 200 no-op"

$detail = Invoke-RestMethod -Uri "$base/api/bookings/$orderId" -Headers @{ Authorization = "Bearer $nong" }
Check ($detail.payment_status -eq "paid") "the payments service told the monolith to mark the order paid"
Check ($detail.payment_intent.status -eq "succeeded") "the intent read back from the payments service is succeeded"

Write-Host "== checking a wallet write crosses the boundary ==" -ForegroundColor Cyan
$newEmail = "verify-provider-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())@example.com"
$regBody = @{ email = $newEmail; password = "VerifyPass123!"; name = "Verify Provider"; company_name = "Verify Co" } | ConvertTo-Json -Compress
$registered = Invoke-RestMethod -Method Post -Uri "$base/api/auth/provider/register" -ContentType "application/json" -Body $regBody
Check ($registered.id -gt 0) "provider registration succeeded"

$paymentDbProbe = @'
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const charges = await pool.query("select count(*)::int as n from transactions where order_id = $1 and kind = 'charge'", [ORDER_ID]);
  const wallet = await pool.query("select count(*)::int as n from provider_wallets where provider_id = $1", [PROVIDER_ID]);
  const intents = await pool.query("select count(*)::int as n from payment_intents");
  console.log(JSON.stringify({
    charges: charges.rows[0].n,
    wallet: wallet.rows[0].n,
    intents: intents.rows[0].n
  }));
  await pool.end();
})();
'@
$paymentDbProbe = $paymentDbProbe.Replace("ORDER_ID", [string]$orderId).Replace("PROVIDER_ID", [string]$registered.id)
$b64PaymentProbe = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($paymentDbProbe))
$paymentOut = (Invoke-Quietly { & docker compose exec -T payments node -e "eval(Buffer.from('$b64PaymentProbe','base64').toString())" }) -join ""
$paymentResult = $paymentOut | ConvertFrom-Json
Check ([int]$paymentResult.charges -eq 1) "payments DB has exactly one charge for the booking after the replay"
Check ([int]$paymentResult.wallet -eq 1) "the new provider's wallet row is in the payments DB"
Check ([int]$paymentResult.intents -ge 1) "the booking intent is stored in the payments DB"

Write-Host ""
Write-Host ("ALL AREA A CHECKS PASSED (" + $pass + " assertions)") -ForegroundColor Green
Write-Host "Stack is left running at http://localhost:3000"
Write-Host "Reset later with: docker compose down -v"
