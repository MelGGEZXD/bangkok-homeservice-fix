param(
  [string]$BaseUrl = 'http://localhost:3000',
  [string]$ComposeProject = '',
  [int]$DaysAhead = 8,
  [string]$WebhookSecret = 'edemand-webhook-secret'
)

$ErrorActionPreference = 'Stop'
$date = (Get-Date).AddDays($DaysAhead)
if ($date.DayOfWeek -eq 'Sunday') { $date = $date.AddDays(1) }
$bookingDate = $date.ToString('yyyy-MM-dd')

function Assert-Check($Condition, $Message) {
  if (-not $Condition) { throw $Message }
}

function Invoke-Api($Method, $Path, $Token, $Body, $Expected = 200, $Headers = @{}) {
  $options = @{ Method = $Method; Uri = "$BaseUrl$Path"; Headers = $Headers.Clone()
    TimeoutSec = 20; SkipHttpErrorCheck = $true }
  if ($Token) { $options.Headers.Authorization = "Bearer $Token" }
  if ($null -ne $Body) {
    $options.Body = $Body | ConvertTo-Json -Depth 5 -Compress
    $options.ContentType = 'application/json'
  }
  $response = Invoke-WebRequest @options
  Assert-Check ($response.StatusCode -eq $Expected) "$Method $Path expected $Expected, got $($response.StatusCode) $($response.Content)"
  return ConvertFrom-Json -InputObject $response.Content -NoEnumerate
}

function Login($Role, $Email) {
  (Invoke-Api POST "/api/auth/$Role/login" $null @{ email = $Email; password = 'eDemand-2026!' }).token
}

function Book($Time, $Method) {
  Invoke-Api POST '/api/bookings' $customer @{
    provider_id = 1; service_date = $bookingDate; starting_time = $Time; payment_method = $Method
    items = @(@{ service_id = 2; quantity = 1 })
  } 201
}

function Finish($Booking) {
  $id = $Booking.order.id
  $null = Invoke-Api POST "/api/bookings/$id/confirm" $provider
  $null = Invoke-Api POST "/api/bookings/$id/start" $provider
  $done = Invoke-Api POST "/api/bookings/$id/complete" $provider @{ otp = $Booking.otp }
  Assert-Check ($done.status -eq 'completed') 'Expected a completed booking'
  $null = Invoke-Api POST "/api/bookings/$id/complete" $provider @{ otp = $Booking.otp } 409
  return $done
}

$customer = Login customer 'nong@example.com'
$otherCustomer = Login customer 'somchai@example.com'
$provider = Login provider 'sparkle@example.com'
$otherProvider = Login provider 'fixit@example.com'
$walletBefore = Invoke-Api GET '/api/provider/wallet' $provider
$null = Invoke-Api GET '/api/provider/wallet' $null $null 401
$null = Invoke-Api GET '/api/provider/wallet' $customer $null 403
$null = Invoke-Api GET '/api/customer/transactions' $provider $null 403

$online = Book '09:00' 'gateway'
$onlineId = $online.order.id
$webhook = @{ gateway_event_id = [guid]::NewGuid().ToString(); type = 'payment_intent.succeeded'
  gateway_ref = $online.payment_intent.gateway_ref }
$auth = @{ 'X-Webhook-Secret' = $WebhookSecret }
$settled = Invoke-Api POST '/api/payments/webhook' $null $webhook 200 $auth
$replay = Invoke-Api POST '/api/payments/webhook' $null $webhook 200 $auth
$already = Invoke-Api POST '/api/payments/simulate' $customer @{ order_id = $onlineId }
Assert-Check ($settled.settled -and $replay.replayed -and $already.already_settled) 'Payment replay was not deduped'
$onlineDone = Finish $online

$cash = Book '11:00' 'cod'
$cashDone = Finish $cash
$wallet = Invoke-Api GET '/api/provider/wallet' $provider
Assert-Check ($wallet.balance_cents - $walletBefore.balance_cents -eq $onlineDone.provider_earnings_cents) 'Gateway earnings differ'
Assert-Check ($wallet.commission_owed_cents - $walletBefore.commission_owed_cents -eq $cashDone.commission_cents) 'Cash commission differs'
$otherWallet = Invoke-Api GET '/api/provider/wallet?provider_id=1' $otherProvider
Assert-Check ($otherWallet.provider_id -ne 1 -and @($otherWallet.transactions | Where-Object order_id -eq $onlineId).Count -eq 0) 'Another provider can see this ledger'
$walletPage = Invoke-WebRequest -Uri "$BaseUrl/provider/wallet" -Headers @{ Cookie = "edemand_token=$provider" } -TimeoutSec 20
Assert-Check ($walletPage.Content -match 'payout_credit' -and $walletPage.Content -match 'commission_owed') 'Wallet page failed to render the extracted ledger'
"PASS webhook replay, gateway payout, cash commission, Wallet page and provider scope (online=$onlineId cash=$($cash.order.id))"

$toRefund = Book '13:00' 'gateway'
$refundId = $toRefund.order.id
$null = Invoke-Api POST '/api/payments/simulate' $customer @{ order_id = $refundId }
$cancelled = Invoke-Api POST "/api/bookings/$refundId/cancel" $customer
Assert-Check ($cancelled.refunded -and $cancelled.order.payment_status -eq 'refunded') 'Paid cancellation did not refund'
$rebooked = Book '13:00' 'gateway'
$unpaidId = $rebooked.order.id
$unpaid = Invoke-Api POST "/api/bookings/$unpaidId/cancel" $customer
Assert-Check (-not $unpaid.refunded) 'Unpaid cancellation must not refund'
$null = Invoke-Api POST '/api/payments/simulate' $customer @{ order_id = $unpaidId } 409

$history = Invoke-Api GET '/api/customer/transactions' $customer
$otherHistory = Invoke-Api GET '/api/customer/transactions?customer_id=1' $otherCustomer
Assert-Check (@($history | Where-Object { $_.order_id -eq $onlineId -and $_.kind -eq 'charge' }).Count -eq 1) 'Expected one charge after repeated settlement'
Assert-Check (@($history | Where-Object { $_.order_id -eq $refundId -and $_.kind -eq 'refund' }).Count -eq 1) 'Expected one refund'
Assert-Check (@($otherHistory | Where-Object { $_.order_id -in @($onlineId, $refundId) }).Count -eq 0) 'Another customer can see these transactions'
"PASS paid cancellation, one refund, slot released, unpaid cancellation and customer scope (refund=$refundId)"

if ($ComposeProject) {
  $local = @'
const Database = require("better-sqlite3");
const db = new Database("/app/data/edemand.db", { readonly: true });
console.log(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'
  AND name IN ('payment_intents','transactions','provider_wallets','webhook_events')`).get().n);
'@ | docker compose -p $ComposeProject exec -T edemand node
  Assert-Check ($LASTEXITCODE -eq 0 -and $local -eq '0') 'Finance tables still exist in Booking SQLite'
  $counts = docker compose -p $ComposeProject exec -T payments-db psql -U payments -d payments -Atc "SELECT count(*) FROM transactions WHERE order_id IN ($onlineId,$($cash.order.id),$refundId)"
  Assert-Check ($LASTEXITCODE -eq 0 -and $counts -eq '5') 'Payments PostgreSQL does not own all five financial records'
  'PASS database ownership: zero finance tables in Booking SQLite; all five test records in Payments PostgreSQL'
}
