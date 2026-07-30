#Requires -Version 5.1
<#
.SYNOPSIS
    Unified k6 load-test entry point (native Windows version, functionally identical to run.sh)

.DESCRIPTION
    .\run.ps1 <plan> <env> <profile> [KEY=value ...]

      plan     file name under scenarios\ (without .js)
      env      file name under config\    (without .json)
      profile  file name under profiles\  (without .json)
      KEY=value  overrides, written as-is, **do NOT add a -e prefix** (see NOTES below)

.EXAMPLE
    .\run.ps1 p02-trade-create dev smoke
    .\run.ps1 p02-trade-create dev baseline VUS=8 DURATION=300s
    .\run.ps1 p02-trade-create dev arrival  RATE=4
    .\run.ps1 p02-trade-create dev baseline CREATE_DATA_FILE=data/workers/trade-management/create-trade-lock-variant.json

.NOTES
    ⚠ Why overrides do NOT use `-e KEY=value`:
      PowerShell treats `-e` as a **parameter-name prefix** and matches it against
      this script's parameters. `-e` uniquely matched -EnvName, so `-e VUS=8` got
      bound as **EnvName='VUS=8'**, and the reported error was
      `ERROR: env 'VUS=8' not found (config\VUS=8.json)` —
      a message pointing in entirely the wrong direction (confirmed empirically
      on 2026-07-28 with pwsh 7.6).
      So this script takes bare KEY=value and adds the -e itself before handing off to k6.
      run.sh has been aligned to the same form — identical command lines on both
      sides is what keeps notes portable.

    ⚠ Two deliberate choices, both so that a stray `-e` can be caught:
      ① **No [CmdletBinding()]** — with it this becomes an "advanced function" and
         undeclared `-xxx` arguments get intercepted by the parameter binder;
         without it, they fall through into $args untouched.
      ② The environment parameter is named **$TargetEnv, not $EnvName** — if any
         parameter starts with e, `-e` uniquely prefix-matches it and gets consumed
         before reaching $args, which would defeat ①.
      Both are required; neither works alone (each verified empirically on
      2026-07-28 with pwsh 7.6).

    ⚠ $Profile is a PowerShell **automatic variable** (the path of the user's
      profile script), so the parameter is named ProfileName — do not "simplify"
      it back.

    ⚠ This file and run.sh are **two implementations of the same logic**.
      Change either one and the other must be updated in sync — otherwise Mac
      and Windows runs are not comparable, and that inconsistency is invisible
      in the reports.
#>

param(
    [string]$Plan,
    [string]$TargetEnv,
    [string]$ProfileName
)
# Remaining arguments are collected via $args — see NOTES above; this is exactly
# why [CmdletBinding()] is omitted
$Overrides = $args

$ErrorActionPreference = 'Stop'

# ── Console output in UTF-8 ──────────────────────────────────
# Without this, the ✓ / ⚠ symbols in the k6 log come out as mojibake —
# garbled guard output is as good as no guard.
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$K6Root = $PSScriptRoot
Set-Location $K6Root

function Show-Usage {
    Write-Host "usage: .\run.ps1 <plan> <env> <profile> [KEY=value ...]" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "plans:    $((Get-ChildItem 'scenarios\*.js'  -ErrorAction SilentlyContinue | ForEach-Object BaseName) -join ' ')"
    Write-Host "envs:     $((Get-ChildItem 'config\*.json'   -ErrorAction SilentlyContinue | ForEach-Object BaseName) -join ' ')"
    Write-Host "profiles: $((Get-ChildItem 'profiles\*.json' -ErrorAction SilentlyContinue | ForEach-Object BaseName) -join ' ')"
    exit 1
}

if (-not $Plan -or -not $TargetEnv -or -not $ProfileName) { Show-Usage }

$PlanFile    = "scenarios\$Plan.js"
$EnvFile     = "config\$TargetEnv.json"
$ProfileFile = "profiles\$ProfileName.json"

if (-not (Test-Path $PlanFile))    { Write-Host "ERROR: plan '$Plan' not found ($PlanFile)" -ForegroundColor Red; Show-Usage }
if (-not (Test-Path $EnvFile))     { Write-Host "ERROR: env '$TargetEnv' not found ($EnvFile)" -ForegroundColor Red; Show-Usage }
if (-not (Test-Path $ProfileFile)) { Write-Host "ERROR: profile '$ProfileName' not found ($ProfileFile)" -ForegroundColor Red; Show-Usage }

# ── Grafana dashboard: read from config/<env>.json ────────────
# The address belongs to the environment, so it lives in the env config --
# dev's dashboard is not perf's (var-host alone differs). PowerShell parses
# JSON natively; run.sh has no JSON parser and uses a line-scoped sed reader
# instead (see the cfg_get comment there) -- same values, same precedence.
# The env var still wins, so a one-off run needs no file edit.
$EnvCfg = Get-Content $EnvFile -Raw | ConvertFrom-Json
$GrafanaUrl = if ($env:GRAFANA_DASHBOARD_URL) { $env:GRAFANA_DASHBOARD_URL } else { [string]$EnvCfg.grafanaDashboard }

# Prometheus remote-write endpoint: same environment-owned / env-var-wins
# pattern as grafanaDashboard above. Non-empty (from either source) turns the
# experimental-prometheus-rw output on for this run.
$PromUrl = if ($env:K6_PROMETHEUS_RW_SERVER_URL) { $env:K6_PROMETHEUS_RW_SERVER_URL } else { [string]$EnvCfg.prometheusRwUrl }

# ── Override validation: fail early, don't wait for k6 to start before finding the typo ──
$OverrideArgs = @()
foreach ($o in $Overrides) {
    if ([string]::IsNullOrWhiteSpace($o)) { continue }
    if ($o -like '-e') { continue }                      # a stray -e slipped in; ignore it
    if ($o -notmatch '^[A-Za-z_][A-Za-z0-9_]*=') {
        Write-Host "ERROR: malformed override: '$o'" -ForegroundColor Red
        Write-Host "       expected KEY=value (no -e prefix), e.g. VUS=8" -ForegroundColor Red
        exit 1
    }
    $OverrideArgs += @('-e', $o)
}

# ── Is k6 available ──────────────────────────────────────────
if (-not (Get-Command k6 -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: k6 not on PATH" -ForegroundColor Red
    Write-Host "  winget install k6 --source winget"
    Write-Host "  or choco install k6"
    Write-Host "  or download the zip from https://github.com/grafana/k6/releases, unzip, and add the directory to PATH"
    Write-Host ""
    Write-Host "  After installing you MUST **open a new PowerShell window** — PATH does not refresh in an already-open one." -ForegroundColor Yellow
    exit 2
}

# ── Run identity ─────────────────────────────────────────────
# Stamp is taken ONCE and the day folder is derived from it -- asking for the
# date twice could straddle midnight and put the run under the wrong day.
$Stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$RunDay = $Stamp.Split('-')[0]
$RunId  = "${Plan}_${TargetEnv}_${ProfileName}_$Stamp"
# One folder per day: results\<YYYYMMDD>\<runId>\. The runId keeps its own
# date on purpose -- a folder copied out of the tree still says when it ran.
$RunDir = "results\$RunDay\$RunId"
New-Item -ItemType Directory -Path $RunDir -Force | Out-Null

# Paths that go into k6 always use forward slashes: handleSummary's output keys
# and --out are both handled by Go, which accepts forward slashes on Windows,
# while backslashes would additionally need escaping in JS strings.
$RunDirFwd = $RunDir -replace '\\', '/'

# ── run manifest ─────────────────────────────────────────────
# The "change only one variable per run" discipline only holds if it can be
# verified after the fact.
$Manifest  = "$RunDir\manifest.txt"
$StartMs   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$OverrideS = if ($Overrides) { $Overrides -join ' ' } else { '<none>' }

$lines = New-Object System.Collections.ArrayList
$null = $lines.Add("runId:        $RunId")
$null = $lines.Add("timestamp:    $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))")
$null = $lines.Add("epochMillis:  $StartMs")
$null = $lines.Add("plan:         $PlanFile")
$null = $lines.Add("env:          $EnvFile")
$null = $lines.Add("profile:      $ProfileFile")
$null = $lines.Add("overrides:    $OverrideS")
$null = $lines.Add("grafana:      $(if ($GrafanaUrl) { $GrafanaUrl } else { '<none>' })")
$null = $lines.Add("prometheus:   $(if ($PromUrl) { $PromUrl } else { '<none>' })")
# Use [Environment] rather than $env:COMPUTERNAME / $env:USERNAME:
# the latter only have values on Windows, so cross-platform runs (or CI
# containers) would leave two empty fields — and the entire point of the
# manifest is being able to answer "which machine was this run on" afterwards.
$null = $lines.Add("host:         $([Environment]::MachineName)")
$null = $lines.Add("user:         $([Environment]::UserName)")
$null = $lines.Add("k6:           $(k6 version 2>&1 | Select-Object -First 1)")
$null = $lines.Add("os:           $([System.Environment]::OSVersion.VersionString)")
$null = $lines.Add("powershell:   $($PSVersionTable.PSVersion)")

if (Get-Command git -ErrorAction SilentlyContinue) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    git -C $K6Root rev-parse --git-dir 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $null = $lines.Add("scriptCommit: $(git -C $K6Root rev-parse --short HEAD)")
        $null = $lines.Add("scriptDirty:  $((git -C $K6Root status --porcelain | Measure-Object -Line).Lines) file(s)")
    }
    $ErrorActionPreference = $prev
}

$null = $lines.Add("")
$null = $lines.Add("--- $EnvFile ---")
$null = $lines.Add((Get-Content $EnvFile -Raw))
$null = $lines.Add("--- $ProfileFile ---")
$null = $lines.Add((Get-Content $ProfileFile -Raw))

$lines | Set-Content -Path $Manifest -Encoding UTF8

Write-Host "> plan     $PlanFile"
Write-Host "> env      $EnvFile"
Write-Host "> profile  $ProfileFile"
if ($Overrides) { Write-Host "> override $OverrideS" }
Write-Host "> results  $RunDir"
Write-Host ""

# ── Output arguments ─────────────────────────────────────────
$OutArgs = @('--out', "csv=$RunDirFwd/result.csv")

# Prometheus remote-write: load metrics go into the backend's existing Prometheus,
# same panel and same timeline as metrics like hikaricp_connections_pending.
# ⚠ On some versions the output name is experimental-prometheus-rw; if it errors, use prometheus-rw.
if ($PromUrl) {
    $OutArgs += @('--out', 'experimental-prometheus-rw')
    # k6 reads the endpoint from this env var (the output has no CLI flag for
    # it) -- when the value came from the config file it must be set here.
    $env:K6_PROMETHEUS_RW_SERVER_URL = $PromUrl
    # k6's default trend stats for remote write is p(99) ONLY -- the official
    # k6 Prometheus dashboard (grafana.com id 19665) wants p95/min/max/avg too;
    # without them its latency panels sit half empty. Explicit env still wins.
    if (-not $env:K6_PROMETHEUS_RW_TREND_STATS) { $env:K6_PROMETHEUS_RW_TREND_STATS = 'p(95),p(99),min,max,avg' }
    # Mark series stale when the test ends -- without this the last values
    # linger ~5 minutes in from->now queries after the run.
    if (-not $env:K6_PROMETHEUS_RW_STALE_MARKERS) { $env:K6_PROMETHEUS_RW_STALE_MARKERS = 'true' }
    Write-Host "> prometheus  $PromUrl  (trend stats: $($env:K6_PROMETHEUS_RW_TREND_STATS))"
    Write-Host ""
}

# ── k6 web dashboard (built into k6 ≥ v0.49; "unknown environment variable" means upgrade k6) ──
# Live curves at http://127.0.0.1:5665 during the run, self-contained HTML export after —
# until Prometheus remote-write is approved, this is the only time-series view.
# ⚠ Do not use it for pass/fail: the dashboard's error rate is http_req_failed (HTTP layer),
#   and in this project business failures still return HTTP 200 — the three error
#   categories in summary.txt are authoritative.
# On by default. A second parallel instance collides on the port: $env:K6_WEB_DASHBOARD_PORT=5666
# to change it, or $env:K6_WEB_DASHBOARD='false' to turn it off entirely.
# ⚠ For very short runs k6 skips the export ("report generation was skipped, not enough
#   data"; the aggregation bucket defaults to 10s) — no report.html for smoke is normal,
#   only real rounds get one.
if ($env:K6_WEB_DASHBOARD -ne 'false') {
    $env:K6_WEB_DASHBOARD = 'true'
    $env:K6_WEB_DASHBOARD_EXPORT = "$RunDirFwd/report.html"
    $DashPort = if ($env:K6_WEB_DASHBOARD_PORT) { $env:K6_WEB_DASHBOARD_PORT } else { '5665' }
    Write-Host "> dashboard  http://127.0.0.1:$DashPort -> exports $RunDirFwd/report.html"
    Write-Host ""
}

# ── Execution ────────────────────────────────────────────────
$env:RESULT_DIR = $RunDirFwd

# Per-message debugging is passed straight through via k6's native K6_HTTP_DEBUG
# environment variable (same convention as K6_WEB_DASHBOARD); the runner does no
# translation:
#   $env:K6_HTTP_DEBUG='full'; .\run.ps1 p02-trade-create dev smoke
if ($env:K6_HTTP_DEBUG) {
    Write-Host "⚠ K6_HTTP_DEBUG=$($env:K6_HTTP_DEBUG) — printing every HTTP message, smoke-level verification only;" -ForegroundColor Yellow
    Write-Host "  messages contain real refdata, and full also dumps .dat binaries — delete this k6.log when done." -ForegroundColor Yellow
    Write-Host ""
}

$k6Args = @('run', '-e', "ENV=$TargetEnv", '-e', "PROFILE=$ProfileName", '-e', "RESULT_DIR=$RunDirFwd")
$k6Args += @('--tag', "testid=$RunId")
$k6Args += $OverrideArgs
$k6Args += $OutArgs
$k6Args += @('--summary-trend-stats', 'avg,min,med,p(90),p(95),p(99),max,count')
$k6Args += $PlanFile

# ⚠⚠ ErrorActionPreference MUST be dropped back to Continue here.
#   k6 writes its progress bar and logs to **stderr**, and `$ErrorActionPreference='Stop'`
#   + `2>&1` makes PowerShell throw the first stderr line as a terminating
#   NativeCommandError — the symptom is "k6 crashes right at startup, and the
#   error message is PowerShell's, not k6's".
#   One of PS 5.1's nastiest behaviors; it must be explicitly worked around.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& k6 @k6Args 2>&1 | Tee-Object -FilePath "$RunDir\k6.log"
$K6Rc = $LASTEXITCODE
$ErrorActionPreference = $prevEAP

$EndMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
Add-Content -Path $Manifest -Value "endEpochMillis: $EndMs" -Encoding UTF8

Write-Host ""
Write-Host "-- Results ---------------------------------------"
Write-Host "summary:  $RunDir\summary.txt"
Write-Host "raw:      $RunDir\summary.json"
Write-Host "csv:      $RunDir\result.csv"
if (Test-Path "$RunDir\report.html") {
    Write-Host "report:   $RunDir\report.html   <- time-series curves (summary is authoritative for pass/fail)"
}
Write-Host "manifest: $Manifest"
Write-Host ""
if ($GrafanaUrl) {
    $sep = if ($GrafanaUrl -like '*?*') { '&' } else { '?' }
    # var-testid: both the official k6 dashboard (19665) and grafana/oreo-k6-verdicts.json
    # key their run selector on the testid label -- the link lands on exactly this run.
    Write-Host "Grafana:  ${GrafanaUrl}${sep}from=$StartMs&to=$EndMs&var-testid=$RunId"
} else {
    Write-Host "Grafana time range (replace from=now-1h&to=now in the URL):"
    Write-Host "  &from=$StartMs&to=$EndMs"
    Write-Host "  To get a ready-made link: set grafanaDashboard in $EnvFile (or `$env:GRAFANA_DASHBOARD_URL for one run)"
}

if (Select-String -Path "$RunDir\k6.log" -Pattern 'PREFLIGHT FAILED' -Quiet -ErrorAction SilentlyContinue) {
    Write-Host ""
    Write-Host "! PREFLIGHT FAILED -- the data file failed local validation (placeholders / missing fields / empty pool)." -ForegroundColor Red
    Select-String -Path "$RunDir\k6.log" -Pattern 'PREFLIGHT' |
        Select-Object -Last 5 | ForEach-Object { Write-Host "  $($_.Line)" }
    Write-Host "  Nothing was sent. Fill in the data first; see data\workers\trade-management\README.md." -ForegroundColor Red
}

exit $K6Rc
