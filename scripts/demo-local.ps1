# Warifu: one-command LOCAL demo stack (sandbox profile): Postgres on D:, anvil, the real sandbox kernel, the web app.
#   pwsh scripts/demo-local.ps1            start everything and print the click path
#   pwsh scripts/demo-local.ps1 -Stop      stop what this script started
# Nothing here touches a real key or network: anvil is a local chain, the kernel signer is anvil's well-known test key, the service secret is
# generated into D:\symbolon\demo (outside the repo, never committed). Logs: D:\symbolon\demo\logs. Free-form attempts need the sandbox model
# key; without it the challenge runs at level L1 (one-click + benign controls), which is enough to record.
param(
  [switch]$Stop,
  [string]$Demo = "D:\symbolon\demo",
  [string]$PgBin = "D:\tools\postgres\pgsql\bin",
  [string]$PgData = "D:\tools\postgres\data",
  [string]$Anvil = "D:\tools\foundry\bin\anvil.exe",
  [int]$WebPort = 3000,
  [int]$KernelPort = 8787
)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Logs = Join-Path $Demo "logs"
$PidFile = Join-Path $Demo "pids.json"
New-Item -ItemType Directory -Force $Logs | Out-Null

function Stop-Demo {
  if (Test-Path $PidFile) {
    foreach ($p in (Get-Content $PidFile | ConvertFrom-Json)) { try { Stop-Process -Id $p -Force -ErrorAction Stop; "stopped $p" } catch { } }
    Remove-Item $PidFile -Force
  }
}
if ($Stop) { Stop-Demo; return }
Stop-Demo

# 1. Postgres (port 54329; the 5432 service is someone else's: never touched)
& "$PgBin\pg_isready.exe" -h localhost -p 54329 | Out-Null
if ($LASTEXITCODE -ne 0) {
  "starting Postgres (replaying its log can take a minute after a hard shutdown)..."
  & "$PgBin\pg_ctl.exe" start -D $PgData -l "D:\tools\postgres\log\postgres.log" -w -t 180 | Out-Null
}
& "$PgBin\pg_isready.exe" -h localhost -p 54329
if ($LASTEXITCODE -ne 0) { throw "Postgres is not answering on 54329" }

# 2. sandbox database + migrations (stamps the profile once; refuses a production-stamped DB)
$Db = "symbolon_sandbox_demo"
$exists = & "$PgBin\psql.exe" -h localhost -p 54329 -U postgres -tAc "select 1 from pg_database where datname='$Db'"
if ($exists -ne "1") { & "$PgBin\createdb.exe" -h localhost -p 54329 -U postgres $Db }
$DbUrl = "postgres://postgres@localhost:54329/$Db"

$pids = @()
# 3. anvil (a local chain). Its startup output lists its throwaway dev accounts; the kernel signer is the second one. The key is read from
#    that output at run time and written only into the env file outside the repo: this script contains no key.
if (-not (Get-NetTCPConnection -LocalPort 8545 -State Listen -ErrorAction SilentlyContinue)) {
  Remove-Item "$Logs\anvil.log" -ErrorAction SilentlyContinue
  $a = Start-Process -FilePath $Anvil -ArgumentList "--port", "8545", "--chain-id", "31337" -RedirectStandardOutput "$Logs\anvil.log" -RedirectStandardError "$Logs\anvil.err" -PassThru -WindowStyle Hidden
  $pids += $a.Id
  Start-Sleep -Seconds 3
}
$anvilLog = if (Test-Path "$Logs\anvil.log") { Get-Content "$Logs\anvil.log" -Raw } else { "" }
$signer = if ($anvilLog -match "(?m)^\(1\) (0x[0-9a-fA-F]{64})") { $Matches[1] } else { $null }

# 4. generated local secrets (outside the repo)
$EnvFile = Join-Path $Demo "sandbox.env"
if (-not (Test-Path $EnvFile)) {
  if ($null -eq $signer) { Stop-Demo; throw "could not read anvil's dev account from $Logs\anvil.log: stop any anvil already running on 8545 and run again" }
  $svc = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]]) -replace "[+/=]", "x"
  $salt = [Convert]::ToBase64String((1..24 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]]) -replace "[+/=]", "y"
  @"
KERNEL_PROFILE=sandbox
NETWORK=local
EVIDENCE_MODE=fixtures
HOST=127.0.0.1
PORT=$KernelPort
ARC_RPC_URL=http://127.0.0.1:8545
DATABASE_URL=$DbUrl
SERVICE_TOKEN_SECRET=$svc
KERNEL_SIGNER_PRIVATE_KEY=$signer
CHALLENGE_IP_SALT=$salt
CHALLENGE_ENABLED=true
CHALLENGE_LLM_DAILY_BUDGET_USD=5
INDEXER_ENABLED=false
SCHEDULER_ENABLED=false
RECONCILER_ENABLED=false
"@ | Set-Content -Encoding utf8 $EnvFile
}
$svcSecret = ((Get-Content $EnvFile | Where-Object { $_ -like "SERVICE_TOKEN_SECRET=*" }) -split "=", 2)[1]

Push-Location $Root
try {
  $env:DATABASE_URL = $DbUrl
  pnpm kernel:migrate -- --profile sandbox | Select-Object -Last 2
  $env:DATABASE_URL = $null
} finally { Pop-Location }

# 5. the real sandbox kernel (every boot guard runs; it exits before listening if one fails)
$k = Start-Process -FilePath "node" -WorkingDirectory $Root -ArgumentList "--env-file=$EnvFile", "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", "./packages/blast-radius/scripts/register-ts.mjs", "services/kernel/src/main.ts" -RedirectStandardOutput "$Logs\kernel.log" -RedirectStandardError "$Logs\kernel.err" -PassThru -WindowStyle Hidden
$pids += $k.Id
$ready = $false
foreach ($i in 1..40) { Start-Sleep -Milliseconds 750; try { if ((Invoke-RestMethod "http://127.0.0.1:$KernelPort/v1/healthz").status -eq "ok") { $ready = $true; break } } catch { } }
if (-not $ready) { Stop-Demo; throw "the kernel did not come up: see $Logs\kernel.log" }

# 6. the web app (dev server: the first request of each page compiles it, so click through once before recording)
$env:WEB_SVC_URL = "http://127.0.0.1:$KernelPort"
$env:WEB_SVC_SECRET = $svcSecret
$env:WEB_SVC_TENANT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
$env:WEB_SVC_PROFILE = "sandbox"
# (pnpm is a .cmd shim on Windows: it has to be started through cmd.exe)
$w = Start-Process -FilePath "cmd.exe" -WorkingDirectory (Join-Path $Root "apps\web") -ArgumentList "/c", "pnpm exec next dev -p $WebPort" -RedirectStandardOutput "$Logs\web.log" -RedirectStandardError "$Logs\web.err" -PassThru -WindowStyle Hidden
$pids += $w.Id
$pids | ConvertTo-Json | Set-Content $PidFile

@"

Warifu demo stack is up (local chain, real sandbox kernel, no real keys).
  Web      http://localhost:$WebPort
  Kernel   http://127.0.0.1:$KernelPort/v1/healthz
Click path for the video:  /  ->  /challenge (ATK-10, ATK-02, then benign BC-1)  ->  /attack-lab  ->  /judge  ->  /certificate  ->  /pilot
Warm every page once before you record (the dev server compiles on first visit). Stop with:  pwsh scripts/demo-local.ps1 -Stop
"@
