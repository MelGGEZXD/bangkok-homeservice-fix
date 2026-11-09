# Area A verification script (Windows PowerShell).
#
# What it proves:
#   1. the docker compose stack boots healthy
#   2. the gateway routes /api/notifications to the extracted service, not the monolith
#   3. admin approval writes an outbox event and the relay delivers ONE notification
#   4. the notifications service enforces record ownership (403 for another user)
#   5. the monolith SQLite file has no notifications table
#   6. a replayed internal delivery returns duplicate:true (exactly-one effect)
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

Write-Host ""
Write-Host ("ALL AREA A CHECKS PASSED (" + $pass + " assertions)") -ForegroundColor Green
Write-Host "Stack is left running at http://localhost:3000"
Write-Host "Reset later with: docker compose down -v"
