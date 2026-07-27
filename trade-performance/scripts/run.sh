#!/usr/bin/env bash
#
# run.sh —— 三维正交的唯一执行入口
#
#   ./scripts/run.sh <plan> <env> <profile> [-Jkey=value ...]
#
#   plan     jmx/ 下的文件名（不含 .jmx），会在 scenarios/ api/ journeys/ suites/ ops/ 里查找
#   env      config/ 下的文件名（不含 .properties）
#   profile  profiles/ 下的文件名（不含 .properties）
#
# 例：
#   ./scripts/run.sh s01-create-trade-e2e dev  smoke
#   ./scripts/run.sh p02-trade-create     perf load
#   ./scripts/run.sh p02-trade-create     perf load -JportfolioSelect=fixed
#   ./scripts/run.sh p02-trade-create     perf load -JuserMode=fixed
#
# ⚠ 本脚本必须 cd 到项目根：
#   Include Controller 的路径不支持变量/函数，只能写死，且按**当前工作目录**解析。
#   不 cd 的话 JMeter 会静默地找不到 fragment —— 表现为"跑完了但一条请求都没发"。

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"          # ← 见上方警告，不可删除

usage() {
    echo "usage: $0 <plan> <env> <profile> [-Jkey=value ...]" >&2
    echo "" >&2
    echo "plans:" >&2
    find jmx -name '*.jmx' -not -path 'jmx/fragments/*' -not -path 'jmx/journeys/*' \
        | sed 's|.*/||; s|\.jmx$||; s|^|  |' | sort >&2
    echo "" >&2
    echo "envs:     $(ls config/*.properties   | xargs -n1 basename | sed 's/\.properties//' | tr '\n' ' ')" >&2
    echo "profiles: $(ls profiles/*.properties | xargs -n1 basename | sed 's/\.properties//' | tr '\n' ' ')" >&2
    exit 1
}

[[ $# -lt 3 ]] && usage

PLAN="$1"; ENV="$2"; PROFILE="$3"; shift 3
EXTRA=("$@")

# ── 定位 jmx ──
# fragments/ 和 journeys/ 被刻意排除：它们没有 Thread Group，跑起来是空转。
# 与其让人对着一份 0 sample 的报告排查半天，不如在这里直接拒绝。
PLAN_FILE=""
for d in jmx/scenarios jmx/api jmx/suites jmx/ops; do
    [[ -f "$d/$PLAN.jmx" ]] && { PLAN_FILE="$d/$PLAN.jmx"; break; }
done
if [[ -z "$PLAN_FILE" ]]; then
    if find jmx/fragments jmx/journeys -name "$PLAN.jmx" | grep -q .; then
        echo "ERROR: '$PLAN' is a fragment/journey — it has no Thread Group and cannot be run directly." >&2
        echo "       Run a scenario or api plan that includes it instead." >&2
        exit 2
    fi
    echo "ERROR: plan '$PLAN' not found" >&2
    usage
fi

ENV_FILE="config/$ENV.properties"
PROFILE_FILE="profiles/$PROFILE.properties"
[[ -f "$ENV_FILE"     ]] || { echo "ERROR: env '$ENV' not found ($ENV_FILE)" >&2; exit 2; }
[[ -f "$PROFILE_FILE" ]] || { echo "ERROR: profile '$PROFILE' not found ($PROFILE_FILE)" >&2; exit 2; }

command -v jmeter >/dev/null 2>&1 || { echo "ERROR: jmeter not on PATH" >&2; exit 2; }

# ── 运行标识 ──
RUN_ID="${PLAN}_${ENV}_${PROFILE}_$(date +%Y%m%d-%H%M%S)"
RUN_DIR="results/$RUN_ID"
REPORT_DIR="reports/$RUN_ID"
mkdir -p "$RUN_DIR"

JTL="$RUN_DIR/result.jtl"
LOG="$RUN_DIR/jmeter.log"

# ── run manifest ──
# "每次只改一个变量"这条纪律，只有在事后能验证的前提下才成立。
# 没有 manifest 的压测结果三个月后就是一堆无法解释的数字。
MANIFEST="$RUN_DIR/manifest.txt"
{
    echo "runId:        $RUN_ID"
    echo "timestamp:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "plan:         $PLAN_FILE"
    echo "env:          $ENV_FILE"
    echo "profile:      $PROFILE_FILE"
    echo "overrides:    ${EXTRA[*]:-<none>}"
    echo "host:         $(hostname)"
    echo "user:         $(whoami)"
    echo "jmeter:       $(jmeter --version 2>&1 | head -1 || echo unknown)"
    echo "java:         $(java -version 2>&1 | head -1 || echo unknown)"
    if git -C "$PROJECT_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
        echo "scriptCommit: $(git -C "$PROJECT_ROOT" rev-parse --short HEAD)"
        echo "scriptDirty:  $(git -C "$PROJECT_ROOT" status --porcelain | wc -l | tr -d ' ') file(s)"
    fi
    echo ""
    echo "--- $ENV_FILE ---";     grep -v '^\s*#' "$ENV_FILE"     | grep -v '^\s*$'
    echo "--- $PROFILE_FILE ---"; grep -v '^\s*#' "$PROFILE_FILE" | grep -v '^\s*$'
} > "$MANIFEST"

echo "▶ plan     $PLAN_FILE"
echo "▶ env      $ENV_FILE"
echo "▶ profile  $PROFILE_FILE"
[[ ${#EXTRA[@]} -gt 0 ]] && echo "▶ override ${EXTRA[*]}"
echo "▶ results  $RUN_DIR"
echo ""

# ── 执行 ──
# -q 可重复，后者覆盖前者：config → profile → 命令行 -J
# sample_variables 把业务字段写进 jtl 的额外列，用来按维度切分结果
#   （比自己在 Groovy 里写文件靠谱：不会漏、不会串行阻塞、不会和 JMeter 的写入打架）
set +e
jmeter -n \
    -t "$PLAN_FILE" \
    -q "$ENV_FILE" \
    -q "$PROFILE_FILE" \
    -JbaseDir="$PROJECT_ROOT" \
    -JrunResultDir="$PROJECT_ROOT/$RUN_DIR" \
    -Jsample_variables=runPhase,caseId,tradeId,taskId,datFile,productType,costTier,fixings,datSize,errClass,riskOk,riskFailCode,portfolioId,effectiveUserId,claimedTaskId,claimedCount,checkerAction,bulkOutcome,bulkSuccessCount,checkerFailMsg,eventCaseId,eventType,needsApproval,eventTaskId,eventFailMsg,tradesRowCount,tradesQuery,targetTradeId \
    -Jjmeter.save.saveservice.output_format=csv \
    -Jjmeter.save.saveservice.response_data.on_error=true \
    "${EXTRA[@]}" \
    -l "$JTL" \
    -j "$LOG" \
    -e -o "$REPORT_DIR"
JMETER_RC=$?
set -e

echo ""
echo "── 结果 ──────────────────────────────────────────"
echo "jtl:      $JTL"
echo "report:   $REPORT_DIR/index.html"
echo "manifest: $MANIFEST"

# ── 开跑前守卫的结果 ──
if grep -q 'PREFLIGHT FAILED' "$LOG" 2>/dev/null; then
    echo ""
    echo "⚠ PREFLIGHT FAILED —— 参考数据业务上不可用。"
    grep 'PREFLIGHT' "$LOG" | tail -5
    echo "  这份结果不可作为性能结论。先修数据，见 README「参考数据」。"
fi

# ── 未解析变量检查 ──
# JMeter 对解析不掉的 ${var} 不报错，直接把字面量发出去。
# 这类失败在报告里表现为业务拒绝，最难定位 —— 所以显式扫一遍。
if [[ -f "$JTL" ]] && grep -q '\${' "$JTL" 2>/dev/null; then
    echo ""
    echo "⚠ jtl 中出现未解析的 \${...} 字面量 —— 脚本有变量未定义："
    grep -o '\${[A-Za-z0-9_]*}' "$JTL" | sort -u | head -10
fi

exit $JMETER_RC
