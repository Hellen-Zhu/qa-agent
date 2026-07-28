#Requires -Version 5.1
<#
.SYNOPSIS
    JMeter 压测统一执行入口（Windows 原生版，与 scripts/run.sh 功能一致）

.DESCRIPTION
    .\scripts\run.ps1 <plan> <env> <profile> [key=value ...]

      plan     jmx\ 下的文件名（不含 .jmx），在 scenarios\ api\ suites\ ops\ 里查找
      env      config\   下的文件名（不含 .properties）
      profile  profiles\ 下的文件名（不含 .properties）
      key=value  覆盖项，**推荐写裸的 key=value**，脚本会补成 -Jkey=value

.EXAMPLE
    .\scripts\run.ps1 p02-trade-create dev smoke
    .\scripts\run.ps1 p02-trade-create dev baseline threads=8 duration=300
    .\scripts\run.ps1 p02-trade-create dev baseline refdataFile=data/refdata/refdata-pairs-single.csv

.NOTES
    ⚠ 为什么推荐裸 key=value 而不是 -Jkey=value：
      PowerShell 会把 `-开头的 token` 当成本脚本的参数名去匹配。本脚本刻意
      **不使用 [CmdletBinding()]**，未匹配的 token 才会落进 $args 原样传下去 ——
      所以 `-Jthreads=8` 实际也能用。但这依赖 PowerShell 的参数绑定行为，
      不同版本/不同调用方式（含 CI）表现未必一致。
      裸 key=value 不以 `-` 开头，绕开整套绑定规则，是**确定能用**的那条路。
      两种写法都收，脚本内部统一成 -Jkey=value。

    ⚠ 本文件与 scripts/run.sh 是**同一套逻辑的两份实现**。
      改任何一个，另一个必须同步 —— 否则 Mac 和 Windows 跑出来的结果不可比，
      而这种不一致在报告里看不出来。

    ⚠ 必须在项目根目录执行（脚本自己会 cd）：
      Include Controller 的路径不支持变量，按**当前工作目录**解析。
      不 cd 的表现是"跑完了但一条请求都没发"—— 不报错，只是什么都没发生。
#>

param(
    [string]$Plan,
    [string]$EnvName,
    [string]$ProfileName
)
# 其余参数由 $args 接收 —— 见上方 NOTES，这正是不写 [CmdletBinding()] 的原因

$ErrorActionPreference = 'Stop'

# ── 控制台 UTF-8 ─────────────────────────────────────────────
# 不设的话 jmeter.log 与 PREFLIGHT 告警里的中文会变成乱码，
# 而 preflight 的失败原因恰好全是中文 —— 看不懂等于没有守卫。
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

# JMeter 里 baseDir 会被拼成 ${__P(baseDir)}/data/dat 这类路径。
# Windows 上 Java 认正斜杠，而反斜杠混着正斜杠虽然多数时候也能用，
# 一旦进了正则或 groovy 字符串就会变成转义符。统一成正斜杠，少一类偶发故障。
$RootFwd = $ProjectRoot -replace '\\', '/'

function Show-Usage {
    Write-Host "usage: .\scripts\run.ps1 <plan> <env> <profile> [key=value ...]" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "plans:"
    Get-ChildItem -Path 'jmx\scenarios', 'jmx\api', 'jmx\suites', 'jmx\ops' -Filter '*.jmx' -ErrorAction SilentlyContinue |
        ForEach-Object { "  $($_.BaseName)" } | Sort-Object
    Write-Host ""
    Write-Host "envs:     $((Get-ChildItem 'config\*.properties'   -ErrorAction SilentlyContinue | ForEach-Object BaseName) -join ' ')"
    Write-Host "profiles: $((Get-ChildItem 'profiles\*.properties' -ErrorAction SilentlyContinue | ForEach-Object BaseName) -join ' ')"
    exit 1
}

if (-not $Plan -or -not $EnvName -or -not $ProfileName) { Show-Usage }

# ── 定位 jmx ─────────────────────────────────────────────────
# fragments\ 和 journeys\ 被刻意排除：它们没有 Thread Group，跑起来是空转。
# 与其让人对着一份 0 sample 的报告排查半天，不如在这里直接拒绝。
$PlanFile = $null
foreach ($d in 'jmx\scenarios', 'jmx\api', 'jmx\suites', 'jmx\ops') {
    $cand = Join-Path $d "$Plan.jmx"
    if (Test-Path $cand) { $PlanFile = $cand; break }
}
if (-not $PlanFile) {
    $frag = Get-ChildItem -Path 'jmx\fragments', 'jmx\journeys' -Filter "$Plan.jmx" -Recurse -ErrorAction SilentlyContinue
    if ($frag) {
        Write-Host "ERROR: '$Plan' is a fragment/journey -- it has no Thread Group and cannot be run directly." -ForegroundColor Red
        Write-Host "       Run a scenario or api plan that includes it instead."
        exit 2
    }
    Write-Host "ERROR: plan '$Plan' not found" -ForegroundColor Red
    Show-Usage
}

$EnvFile     = "config\$EnvName.properties"
$ProfileFile = "profiles\$ProfileName.properties"
if (-not (Test-Path $EnvFile))     { Write-Host "ERROR: env '$EnvName' not found ($EnvFile)" -ForegroundColor Red; exit 2 }
if (-not (Test-Path $ProfileFile)) { Write-Host "ERROR: profile '$ProfileName' not found ($ProfileFile)" -ForegroundColor Red; exit 2 }

# ── 覆盖项：裸 key=value 与 -Jkey=value 都收，统一成 -Jkey=value ──
$Extra = @()
foreach ($a in $args) {
    if ([string]::IsNullOrWhiteSpace($a)) { continue }
    if ($a -match '^-J[A-Za-z_][A-Za-z0-9_.]*=') { $Extra += $a; continue }
    if ($a -match '^[A-Za-z_][A-Za-z0-9_.]*=')   { $Extra += "-J$a"; continue }
    Write-Host "ERROR: 覆盖项格式不对: '$a'" -ForegroundColor Red
    Write-Host "       应为 key=value（推荐）或 -Jkey=value，例如 threads=8"
    exit 1
}

if (-not (Get-Command jmeter -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: jmeter not on PATH" -ForegroundColor Red
    Write-Host "  从 https://jmeter.apache.org/download_jmeter.cgi 下载 apache-jmeter-5.6.3.zip"
    Write-Host "  解压后把 <解压目录>\bin 加进 PATH（系统属性 -> 环境变量 -> Path）"
    Write-Host ""
    Write-Host "  装完必须**重开一个 PowerShell 窗口** -- PATH 不会在已开的窗口里刷新。" -ForegroundColor Yellow
    exit 2
}

# ── 运行标识 ─────────────────────────────────────────────────
$Stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'
$RunId     = "${Plan}_${EnvName}_${ProfileName}_$Stamp"
$RunDir    = "results\$RunId"
$ReportDir = "reports\$RunId"       # 刻意不预建：-e -o 要求目标目录不存在或为空
New-Item -ItemType Directory -Path $RunDir -Force | Out-Null

$Jtl      = "$RunDir\result.jtl"
$Log      = "$RunDir\jmeter.log"
$Manifest = "$RunDir\manifest.txt"

# ── run manifest ─────────────────────────────────────────────
# "每次只改一个变量"这条纪律，只有在事后能验证的前提下才成立。
# 没有 manifest 的压测结果三个月后就是一堆无法解释的数字。
$OverrideS = if ($Extra) { $Extra -join ' ' } else { '<none>' }
$lines = New-Object System.Collections.ArrayList
$null = $lines.Add("runId:        $RunId")
$null = $lines.Add("timestamp:    $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))")
$StartMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$null = $lines.Add("epochMillis:  $StartMs    # 贴进 Grafana URL 的 &from=")
$null = $lines.Add("plan:         $PlanFile")
$null = $lines.Add("env:          $EnvFile")
$null = $lines.Add("profile:      $ProfileFile")
$null = $lines.Add("overrides:    $OverrideS")
# 用 [Environment] 而不是 $env:COMPUTERNAME / $env:USERNAME：
# 后者只在 Windows 上有值，跨平台跑（或在 CI 容器里）会留下两个空字段，
# 而 manifest 的全部意义就是"事后能回答这次是在哪台机器上跑的"。
$null = $lines.Add("host:         $([Environment]::MachineName)")
$null = $lines.Add("user:         $([Environment]::UserName)")
$null = $lines.Add("os:           $([System.Environment]::OSVersion.VersionString)")
$null = $lines.Add("powershell:   $($PSVersionTable.PSVersion)")

$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$null = $lines.Add("jmeter:       $((jmeter --version 2>&1 | Select-Object -First 1))")
$null = $lines.Add("java:         $((java -version 2>&1 | Select-Object -First 1))")
if (Get-Command git -ErrorAction SilentlyContinue) {
    git -C $ProjectRoot rev-parse --git-dir 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $null = $lines.Add("scriptCommit: $(git -C $ProjectRoot rev-parse --short HEAD)")
        $null = $lines.Add("scriptDirty:  $((git -C $ProjectRoot status --porcelain | Measure-Object -Line).Lines) file(s)")
    }
}
$ErrorActionPreference = $prevEAP

$null = $lines.Add("")
$null = $lines.Add("--- $EnvFile ---")
$null = $lines.Add(((Get-Content $EnvFile)     | Where-Object { $_ -notmatch '^\s*#' -and $_ -notmatch '^\s*$' }) -join "`n")
$null = $lines.Add("--- $ProfileFile ---")
$null = $lines.Add(((Get-Content $ProfileFile) | Where-Object { $_ -notmatch '^\s*#' -and $_ -notmatch '^\s*$' }) -join "`n")
$lines | Set-Content -Path $Manifest -Encoding UTF8

Write-Host "> plan     $PlanFile"
Write-Host "> env      $EnvFile"
Write-Host "> profile  $ProfileFile"
if ($Extra) { Write-Host "> override $OverrideS" }
Write-Host "> results  $RunDir"
Write-Host ""

# ── 执行 ─────────────────────────────────────────────────────
# -q 可重复，后者覆盖前者：config -> profile -> 命令行 -J
# sample_variables 把业务字段写进 jtl 的额外列，用来按维度切分结果
#   （比自己在 Groovy 里写文件靠谱：不会漏、不会串行阻塞、不会和 JMeter 的写入打架）
$SampleVars = 'runPhase,caseId,tradeId,taskId,datFile,productType,costTier,fixings,datSizeBytes,errClass,riskOk,riskFailCode,pairId,portfolioId,effectiveUserId,claimedTaskId,claimedCount,checkerAction,bulkOutcome,bulkSuccessCount,checkerFailMsg,eventCaseId,eventType,needsApproval,eventTaskId,eventFailMsg,tradesRowCount,tradesQuery,targetTradeId'

$jmArgs = @(
    '-n',
    '-t', $PlanFile,
    '-q', $EnvFile,
    '-q', $ProfileFile,
    "-JbaseDir=$RootFwd",
    "-JrunResultDir=$RootFwd/$($RunDir -replace '\\','/')",
    "-Jsample_variables=$SampleVars",
    '-Jjmeter.save.saveservice.output_format=csv',
    '-Jjmeter.save.saveservice.response_data.on_error=true'
)
$jmArgs += $Extra
$jmArgs += @('-l', $Jtl, '-j', $Log, '-e', '-o', $ReportDir)

# ⚠⚠ 这里必须把 ErrorActionPreference 降回 Continue。
#   JMeter 把一部分日志写到 **stderr**，而 `$ErrorActionPreference='Stop'` + `2>&1`
#   会让 PowerShell 把第一行 stderr 当成终止性错误抛出 NativeCommandError ——
#   表现是"JMeter 刚启动就崩，且错误信息是 PowerShell 的不是 JMeter 的"。
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& jmeter @jmArgs 2>&1 | Tee-Object -FilePath "$RunDir\console.log"
$JmRc = $LASTEXITCODE
$ErrorActionPreference = $prevEAP

$EndMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
Add-Content -Path $Manifest -Value "endEpochMillis: $EndMs" -Encoding UTF8

Write-Host ""
Write-Host "-- 结果 ------------------------------------------"
Write-Host "jtl:      $Jtl"
Write-Host "report:   $ReportDir\index.html"
Write-Host "manifest: $Manifest"
Write-Host ""
Write-Host "可比口径的数字（推荐用它，别直接读 HTML 报告的 Total 行）："
Write-Host "  python scripts\summarize.py $Jtl"

# ── Grafana 时间范围 ──
# 压测端的数字单独看只能说"慢"，说不出"为什么慢"。结论要成立，必须把这段时间的
# 服务端指标摆在同一根时间轴上。这里直接打出可粘贴的范围，省掉事后回忆几点几分。
Write-Host ""
if ($env:GRAFANA_DASHBOARD_URL) {
    $sep = if ($env:GRAFANA_DASHBOARD_URL -like '*?*') { '&' } else { '?' }
    Write-Host "Grafana:  $($env:GRAFANA_DASHBOARD_URL)${sep}from=$StartMs&to=$EndMs"
} else {
    Write-Host "Grafana 时间范围（替换 URL 里的 from=now-1h&to=now）:"
    Write-Host "  &from=$StartMs&to=$EndMs"
    Write-Host "  想直接打印完整链接：`$env:GRAFANA_DASHBOARD_URL='<看板 URL，含 var-host 等参数>'"
}

# ── 开跑前守卫的结果 ──
if (Test-Path $Log) {
    if (Select-String -Path $Log -Pattern 'PREFLIGHT FAILED' -Quiet -ErrorAction SilentlyContinue) {
        Write-Host ""
        Write-Host "! PREFLIGHT FAILED -- 参考数据业务上不可用。" -ForegroundColor Red
        Select-String -Path $Log -Pattern 'PREFLIGHT' | Select-Object -Last 5 |
            ForEach-Object { Write-Host "  $($_.Line)" }
        Write-Host "  这份结果不可作为性能结论。先修数据，见 data\refdata\README.md。" -ForegroundColor Red
    }
}

# ── 未解析变量检查 ──
# JMeter 对解析不掉的 ${var} 不报错，直接把字面量发出去。
# 这类失败在报告里表现为业务拒绝，最难定位 —— 所以显式扫一遍。
if (Test-Path $Jtl) {
    if (Select-String -Path $Jtl -SimpleMatch '${' -Quiet -ErrorAction SilentlyContinue) {
        Write-Host ""
        Write-Host "! jtl 中出现未解析的 `${...} 字面量 -- 脚本有变量未定义：" -ForegroundColor Yellow
        Select-String -Path $Jtl -Pattern '\$\{[A-Za-z0-9_]*\}' -AllMatches |
            ForEach-Object { $_.Matches.Value } | Sort-Object -Unique |
            Select-Object -First 10 | ForEach-Object { Write-Host "  $_" }
    }
}

exit $JmRc
