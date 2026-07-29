#!/usr/bin/env bash
#
# k6/run.sh —— 三维正交的唯一执行入口
#
#   ./k6/run.sh <plan> <env> <profile> [KEY=value ...]
#
#   plan     scenarios/ 下的文件名（不含 .js）
#   env      config/ 下的文件名（不含 .json）
#   profile  profiles/ 下的文件名（不含 .json）
#   KEY=value  覆盖项，直接写，**不加 -e 前缀**
#
# 例：
#   ./k6/run.sh p02-trade-create dev smoke
#   ./k6/run.sh p02-trade-create dev baseline
#   ./k6/run.sh p02-trade-create dev baseline VUS=8 DURATION=300s
#   ./k6/run.sh p02-trade-create dev arrival  RATE=4
#   ./k6/run.sh p02-trade-create dev baseline CREATE_DATA_FILE=data/create-trade/create-trade-invalid.json
#
# ⚠ 覆盖项刻意不用 `-e KEY=value`：Windows 侧的 run.ps1 里 PowerShell 会把 `-e`
#   当参数名前缀去匹配，报 "ambiguous parameter"。两边统一成裸 KEY=value，
#   **命令行长得一样，笔记才通用**。这是为跨平台一致性付的一点代价。
#
# 送指标进 Prometheus（与后端指标同一根时间轴）：
#   K6_PROMETHEUS_RW_SERVER_URL=http://<prom>:9090/api/v1/write \
#   ./k6/run.sh p02-trade-create dev baseline
#
# k6 的 open() 按**脚本文件**解析相对路径，不按 cwd —— 不 cd 也能跑。
# 仍然 cd 到 k6/ 目录，是为了让 results/ 落在固定位置，
# 且从任何 cwd 调用都是同一副行为。

set -euo pipefail

K6_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$K6_ROOT"

usage() {
    echo "usage: $0 <plan> <env> <profile> [KEY=value ...]" >&2
    echo "" >&2
    echo "plans:    $(ls scenarios/*.js       2>/dev/null | xargs -n1 basename | sed 's/\.js//'   | tr '\n' ' ')" >&2
    echo "envs:     $(ls config/*.json        2>/dev/null | xargs -n1 basename | sed 's/\.json//' | tr '\n' ' ')" >&2
    echo "profiles: $(ls profiles/*.json      2>/dev/null | xargs -n1 basename | sed 's/\.json//' | tr '\n' ' ')" >&2
    exit 1
}

[[ $# -lt 3 ]] && usage

PLAN="$1"; ENV="$2"; PROFILE="$3"; shift 3

# ── 覆盖项校验：早失败，别等 k6 起来了才发现打错 ──
# 与 run.ps1 的校验逻辑保持一致（同样的正则、同样的错误文案）
RAW_OVERRIDES=("$@")
OVERRIDE_ARGS=()
for o in "${RAW_OVERRIDES[@]+"${RAW_OVERRIDES[@]}"}"; do
    [[ -z "$o" ]] && continue
    [[ "$o" == "-e" ]] && continue                 # 手滑写了 -e，忽略掉
    if [[ ! "$o" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
        echo "ERROR: 覆盖项格式不对: '$o'" >&2
        echo "       应为 KEY=value（不加 -e 前缀），例如 VUS=8" >&2
        exit 1
    fi
    OVERRIDE_ARGS+=(-e "$o")
done

PLAN_FILE="scenarios/$PLAN.js"
ENV_FILE="config/$ENV.json"
PROFILE_FILE="profiles/$PROFILE.json"

[[ -f "$PLAN_FILE"    ]] || { echo "ERROR: plan '$PLAN' not found ($PLAN_FILE)" >&2; usage; }
[[ -f "$ENV_FILE"     ]] || { echo "ERROR: env '$ENV' not found ($ENV_FILE)" >&2; usage; }
[[ -f "$PROFILE_FILE" ]] || { echo "ERROR: profile '$PROFILE' not found ($PROFILE_FILE)" >&2; usage; }

command -v k6 >/dev/null 2>&1 || {
    echo "ERROR: k6 not on PATH" >&2
    echo "  macOS:   brew install k6" >&2
    echo "  Windows: winget install k6 --source winget" >&2
    echo "  Linux:   https://grafana.com/docs/k6/latest/set-up/install-k6/" >&2
    exit 2
}

RUN_ID="${PLAN}_${ENV}_${PROFILE}_$(date +%Y%m%d-%H%M%S)"
RUN_DIR="results/$RUN_ID"
mkdir -p "$RUN_DIR"

# ── run manifest ──
# "每次只改一个变量"这条纪律，只有在事后能验证的前提下才成立。
# 没有 manifest 的压测结果三个月后就是一堆无法解释的数字。
MANIFEST="$RUN_DIR/manifest.txt"
{
    echo "runId:        $RUN_ID"
    echo "timestamp:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "epochMillis:  $(( $(date +%s) * 1000 ))    # ← 贴进 Grafana URL 的 &from="
    echo "plan:         $PLAN_FILE"
    echo "env:          $ENV_FILE"
    echo "profile:      $PROFILE_FILE"
    echo "overrides:    ${RAW_OVERRIDES[*]:-<none>}"
    echo "host:         $(hostname)"
    echo "user:         $(whoami)"
    echo "k6:           $(k6 version 2>&1 | head -1 || echo unknown)"
    if git -C "$K6_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
        echo "scriptCommit: $(git -C "$K6_ROOT" rev-parse --short HEAD)"
        echo "scriptDirty:  $(git -C "$K6_ROOT" status --porcelain | wc -l | tr -d ' ') file(s)"
    fi
    echo ""
    echo "--- $ENV_FILE ---";     cat "$ENV_FILE"
    echo "--- $PROFILE_FILE ---"; cat "$PROFILE_FILE"
} > "$MANIFEST"

echo "▶ plan     $PLAN_FILE"
echo "▶ env      $ENV_FILE"
echo "▶ profile  $PROFILE_FILE"
[[ ${#RAW_OVERRIDES[@]} -gt 0 ]] && echo "▶ override ${RAW_OVERRIDES[*]}"
echo "▶ results  $RUN_DIR"
echo ""

# ── 输出 ──
OUT_ARGS=(--out "csv=$RUN_DIR/result.csv")

# Prometheus remote-write：把压测指标送进后端已有的 Prometheus，
# 这样 TPS/P95 与 hikaricp_connections_pending 等指标在同一个面板、同一根时间轴。
# ⚠ 输出名在部分版本是 experimental-prometheus-rw，报错就换另一个。
if [[ -n "${K6_PROMETHEUS_RW_SERVER_URL:-}" ]]; then
    OUT_ARGS+=(--out "experimental-prometheus-rw")
    echo "▶ prometheus  $K6_PROMETHEUS_RW_SERVER_URL"
    echo ""
fi

# ── k6 web dashboard（k6 ≥ v0.49 自带；报 unknown environment variable 就升级 k6）──
# 跑时 http://127.0.0.1:5665 实时看曲线，跑完导出自包含 HTML ——
# 拿到 Prometheus remote-write 审批之前，这是唯一的时间序列视图（见 GRAFANA.zh.md §7）。
# ⚠ 判定不看它：dashboard 的错误率是 http_req_failed（HTTP 层），
#   本项目业务失败照样返回 HTTP 200 —— 三类错误口径以 summary.txt 为准。
# 默认开启。并行跑第二个实例会撞端口：K6_WEB_DASHBOARD_PORT=5666 换端口，
# 或 K6_WEB_DASHBOARD=false 整个关掉。
# ⚠ 运行太短时 k6 跳过导出（"report generation was skipped, not enough data"，
#   聚合桶默认 10s）—— smoke 没有 report.html 是正常的，正式轮次才有。
if [[ "${K6_WEB_DASHBOARD:-true}" != "false" ]]; then
    export K6_WEB_DASHBOARD=true
    export K6_WEB_DASHBOARD_EXPORT="$RUN_DIR/report.html"
    echo "▶ dashboard  http://127.0.0.1:${K6_WEB_DASHBOARD_PORT:-5665} → 导出 $RUN_DIR/report.html"
    echo ""
fi

set +e
RESULT_DIR="$RUN_DIR" k6 run \
    -e ENV="$ENV" \
    -e PROFILE="$PROFILE" \
    -e RESULT_DIR="$RUN_DIR" \
    "${OVERRIDE_ARGS[@]+"${OVERRIDE_ARGS[@]}"}" \
    "${OUT_ARGS[@]}" \
    --summary-trend-stats "avg,min,med,p(90),p(95),p(99),max,count" \
    "$PLAN_FILE" 2>&1 | tee "$RUN_DIR/k6.log"
K6_RC=${PIPESTATUS[0]}
set -e

# 结束时间戳 —— 与 epochMillis 配对贴进 Grafana 的 &from= &to=
echo "endEpochMillis: $(( $(date +%s) * 1000 ))" >> "$MANIFEST"

echo ""
echo "── 结果 ──────────────────────────────────────────"
echo "summary:  $RUN_DIR/summary.txt"
echo "raw:      $RUN_DIR/summary.json"
echo "csv:      $RUN_DIR/result.csv"
[[ -f "$RUN_DIR/report.html" ]] && echo "report:   $RUN_DIR/report.html   ← 时间序列曲线（判定以 summary 为准）"
echo "manifest: $MANIFEST"
echo ""
if [[ -n "${GRAFANA_DASHBOARD_URL:-}" ]]; then
    sep='?'; [[ "$GRAFANA_DASHBOARD_URL" == *\?* ]] && sep='&'
    START_MS=$(grep -oE 'epochMillis: *[0-9]+' "$MANIFEST" | head -1 | grep -oE '[0-9]+')
    END_MS=$(grep -oE 'endEpochMillis: *[0-9]+' "$MANIFEST" | grep -oE '[0-9]+')
    echo "Grafana:  ${GRAFANA_DASHBOARD_URL}${sep}from=${START_MS}&to=${END_MS}"
else
    echo "Grafana 时间范围（替换 URL 里的 from=now-1h&to=now）："
    grep -E 'epochMillis' "$MANIFEST" | sed 's/^/  /'
    echo "  想直接打印完整链接：export GRAFANA_DASHBOARD_URL='<看板 URL，含 var-host 等参数>'"
fi

if grep -q 'PREFLIGHT FAILED' "$RUN_DIR/k6.log" 2>/dev/null; then
    echo ""
    echo "⚠ PREFLIGHT FAILED —— 参考数据业务上不可用。"
    grep 'PREFLIGHT' "$RUN_DIR/k6.log" | tail -5
    echo "  这份结果不可作为性能结论。先修数据，见 data/create-trade/README.md。"
fi

exit $K6_RC
