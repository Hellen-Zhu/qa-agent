#Requires -Version 5.1
<#
.SYNOPSIS
    k6 压测统一执行入口（Windows 原生版，与 run.sh 功能一致）

.DESCRIPTION
    .\k6\run.ps1 <plan> <env> <profile> [KEY=value ...]

      plan     k6\scenarios\ 下的文件名（不含 .js）
      env      k6\config\    下的文件名（不含 .json）
      profile  k6\profiles\  下的文件名（不含 .json）
      KEY=value  覆盖项，直接写，**不要加 -e 前缀**（原因见下方 NOTES）

.EXAMPLE
    .\k6\run.ps1 p02-trade-create dev smoke
    .\k6\run.ps1 p02-trade-create dev baseline VUS=8 DURATION=300s
    .\k6\run.ps1 p02-trade-create dev arrival  RATE=4
    .\k6\run.ps1 p02-trade-create dev baseline REFDATA_FILE=data/refdata/refdata-pairs-single.csv

.NOTES
    ⚠ 为什么覆盖项不用 `-e KEY=value`：
      PowerShell 会把 `-e` 当成**参数名前缀**去匹配本脚本的参数。
      `-e` 唯一匹配到 -EnvName，于是 `-e VUS=8` 被绑成 **EnvName='VUS=8'**，
      报出来的是 `ERROR: env 'VUS=8' not found (k6\config\VUS=8.json)` ——
      一条完全指向错误方向的信息（2026-07-28 用 pwsh 7.6 实测确认）。
      所以这里收裸的 KEY=value，由脚本自己补上 -e 交给 k6。
      run.sh 已同步成同一种写法 —— 两边命令行长得一样，笔记才通用。

    ⚠ 两处刻意的写法，都是为了让 `-e` 这个手滑能被兜住：
      ① **不写 [CmdletBinding()]** —— 写了就是"高级函数"，未声明的 `-xxx`
         会被参数绑定器拦下；不写，它们才会原样落进 $args。
      ② 环境参数命名为 **$TargetEnv 而不是 $EnvName** —— 只要有个参数以 e 开头，
         `-e` 就会唯一前缀匹配上它，先于 $args 被吃掉，①就白做了。
      两条缺一不可（2026-07-28 用 pwsh 7.6 逐条实测过）。

    ⚠ $Profile 是 PowerShell 的**自动变量**（指向用户 profile 脚本路径），
      所以参数名用 ProfileName，不要图省事改回去。

    ⚠ 本文件与 run.sh 是**同一套逻辑的两份实现**。
      改任何一个，另一个必须同步 —— 否则 Mac 和 Windows 跑出来的结果
      不可比，而这种不一致在报告里看不出来。
#>

param(
    [string]$Plan,
    [string]$TargetEnv,
    [string]$ProfileName
)
# 其余参数由 $args 接收 —— 见上方 NOTES，这正是不写 [CmdletBinding()] 的原因
$Overrides = $args

$ErrorActionPreference = 'Stop'

# ── 控制台输出 UTF-8 ─────────────────────────────────────────
# 不设的话 k6 日志里的中文和 ✓ / ⚠ 会变成乱码，
# 而 preflight 的失败原因恰好全是中文 —— 看不懂等于没有守卫。
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

function Show-Usage {
    Write-Host "usage: .\k6\run.ps1 <plan> <env> <profile> [KEY=value ...]" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "plans:    $((Get-ChildItem 'k6\scenarios\*.js'  -ErrorAction SilentlyContinue | ForEach-Object BaseName) -join ' ')"
    Write-Host "envs:     $((Get-ChildItem 'k6\config\*.json'   -ErrorAction SilentlyContinue | ForEach-Object BaseName) -join ' ')"
    Write-Host "profiles: $((Get-ChildItem 'k6\profiles\*.json' -ErrorAction SilentlyContinue | ForEach-Object BaseName) -join ' ')"
    exit 1
}

if (-not $Plan -or -not $TargetEnv -or -not $ProfileName) { Show-Usage }

$PlanFile    = "k6\scenarios\$Plan.js"
$EnvFile     = "k6\config\$TargetEnv.json"
$ProfileFile = "k6\profiles\$ProfileName.json"

if (-not (Test-Path $PlanFile))    { Write-Host "ERROR: plan '$Plan' not found ($PlanFile)" -ForegroundColor Red; Show-Usage }
if (-not (Test-Path $EnvFile))     { Write-Host "ERROR: env '$TargetEnv' not found ($EnvFile)" -ForegroundColor Red; Show-Usage }
if (-not (Test-Path $ProfileFile)) { Write-Host "ERROR: profile '$ProfileName' not found ($ProfileFile)" -ForegroundColor Red; Show-Usage }

# ── 覆盖项校验：早失败，别等 k6 起来了才发现打错 ──────────────
$OverrideArgs = @()
foreach ($o in $Overrides) {
    if ([string]::IsNullOrWhiteSpace($o)) { continue }
    if ($o -like '-e') { continue }                      # 手滑写了 -e，忽略掉
    if ($o -notmatch '^[A-Za-z_][A-Za-z0-9_]*=') {
        Write-Host "ERROR: 覆盖项格式不对: '$o'" -ForegroundColor Red
        Write-Host "       应为 KEY=value（不要加 -e 前缀），例如 VUS=8" -ForegroundColor Red
        exit 1
    }
    $OverrideArgs += @('-e', $o)
}

# ── k6 在不在 ────────────────────────────────────────────────
if (-not (Get-Command k6 -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: k6 not on PATH" -ForegroundColor Red
    Write-Host "  winget install k6 --source winget"
    Write-Host "  或 choco install k6"
    Write-Host "  或 https://github.com/grafana/k6/releases 下载 zip，解压后把目录加进 PATH"
    Write-Host ""
    Write-Host "  装完必须**重开一个 PowerShell 窗口** —— PATH 不会在已开的窗口里刷新。" -ForegroundColor Yellow
    exit 2
}

# ── 运行标识 ─────────────────────────────────────────────────
$Stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$RunId  = "${Plan}_${TargetEnv}_${ProfileName}_$Stamp"
$RunDir = "k6\results\$RunId"
New-Item -ItemType Directory -Path $RunDir -Force | Out-Null

# k6 内部路径一律用正斜杠：handleSummary 的输出键和 --out 都交给 Go 处理，
# Go 在 Windows 上认正斜杠，而反斜杠在 JS 字符串里还得转义。
$RunDirFwd = $RunDir -replace '\\', '/'

# ── run manifest ─────────────────────────────────────────────
# "每次只改一个变量"这条纪律，只有在事后能验证的前提下才成立。
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
# 用 [Environment] 而不是 $env:COMPUTERNAME / $env:USERNAME：
# 后者只在 Windows 上有值，跨平台跑（或在 CI 容器里）会留下两个空字段，
# 而 manifest 的全部意义就是"事后能回答这次是在哪台机器上跑的"。
$null = $lines.Add("host:         $([Environment]::MachineName)")
$null = $lines.Add("user:         $([Environment]::UserName)")
$null = $lines.Add("k6:           $(k6 version 2>&1 | Select-Object -First 1)")
$null = $lines.Add("os:           $([System.Environment]::OSVersion.VersionString)")
$null = $lines.Add("powershell:   $($PSVersionTable.PSVersion)")

if (Get-Command git -ErrorAction SilentlyContinue) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    git -C $ProjectRoot rev-parse --git-dir 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $null = $lines.Add("scriptCommit: $(git -C $ProjectRoot rev-parse --short HEAD)")
        $null = $lines.Add("scriptDirty:  $((git -C $ProjectRoot status --porcelain | Measure-Object -Line).Lines) file(s)")
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

# ── 输出参数 ─────────────────────────────────────────────────
$OutArgs = @('--out', "csv=$RunDirFwd/result.csv")

# Prometheus remote-write：压测指标进后端已有的 Prometheus，
# 与 hikaricp_connections_pending 等指标同一个面板、同一根时间轴。
# ⚠ 输出名在部分版本是 experimental-prometheus-rw，报错就换成 prometheus-rw。
if ($env:K6_PROMETHEUS_RW_SERVER_URL) {
    $OutArgs += @('--out', 'experimental-prometheus-rw')
    Write-Host "> prometheus  $env:K6_PROMETHEUS_RW_SERVER_URL"
    Write-Host ""
}

# ── 执行 ─────────────────────────────────────────────────────
$env:RESULT_DIR = $RunDirFwd

$k6Args = @('run', '-e', "ENV=$TargetEnv", '-e', "PROFILE=$ProfileName", '-e', "RESULT_DIR=$RunDirFwd")
$k6Args += $OverrideArgs
$k6Args += $OutArgs
$k6Args += @('--summary-trend-stats', 'avg,min,med,p(90),p(95),p(99),max,count')
$k6Args += $PlanFile

# ⚠⚠ 这里必须把 ErrorActionPreference 降回 Continue。
#   k6 把进度条和日志写到 **stderr**，而 `$ErrorActionPreference='Stop'` + `2>&1`
#   会让 PowerShell 把第一行 stderr 当成终止性错误抛出 NativeCommandError ——
#   表现是"k6 刚启动就崩，且错误信息是 PowerShell 的不是 k6 的"。
#   这是 PS 5.1 最坑的行为之一，必须显式规避。
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& k6 @k6Args 2>&1 | Tee-Object -FilePath "$RunDir\k6.log"
$K6Rc = $LASTEXITCODE
$ErrorActionPreference = $prevEAP

$EndMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
Add-Content -Path $Manifest -Value "endEpochMillis: $EndMs" -Encoding UTF8

Write-Host ""
Write-Host "-- 结果 ------------------------------------------"
Write-Host "summary:  $RunDir\summary.txt"
Write-Host "raw:      $RunDir\summary.json"
Write-Host "csv:      $RunDir\result.csv"
Write-Host "manifest: $Manifest"
Write-Host ""
if ($env:GRAFANA_DASHBOARD_URL) {
    $sep = if ($env:GRAFANA_DASHBOARD_URL -like '*?*') { '&' } else { '?' }
    Write-Host "Grafana:  $($env:GRAFANA_DASHBOARD_URL)${sep}from=$StartMs&to=$EndMs"
} else {
    Write-Host "Grafana 时间范围（替换 URL 里的 from=now-1h&to=now）:"
    Write-Host "  &from=$StartMs&to=$EndMs"
    Write-Host "  想直接打印完整链接：`$env:GRAFANA_DASHBOARD_URL='<看板 URL，含 var-host 等参数>'"
}

if (Select-String -Path "$RunDir\k6.log" -Pattern 'PREFLIGHT FAILED' -Quiet -ErrorAction SilentlyContinue) {
    Write-Host ""
    Write-Host "! PREFLIGHT FAILED -- 参考数据业务上不可用。" -ForegroundColor Red
    Select-String -Path "$RunDir\k6.log" -Pattern 'PREFLIGHT' |
        Select-Object -Last 5 | ForEach-Object { Write-Host "  $($_.Line)" }
    Write-Host "  这份结果不可作为性能结论。先修数据，见 data\refdata\README.md。" -ForegroundColor Red
}

exit $K6Rc
