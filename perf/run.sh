#!/usr/bin/env bash
#
# run.sh — 本机 runner（参考内部 trade-performance 框架的 runner 设计；
#          Linux/macOS 直跑，Windows 用 Git Bash 跑同一份脚本）
#
#   ./run.sh <scenario>[.js] [env] [profile] [KEY=value ...]
#
#   scenario   src/scenarios/ 下的场景名（.js 可带可不带）
#   env        config/environments/ 下的环境名，默认 local
#   profile    profiles/ 下的负载 profile，默认 smoke
#   KEY=value  __ENV 覆盖，原样透传 k6 -e（不带 -e 前缀），如：
#              VUS=2 RATE=30 DURATION=600s MAX_VUS=50 PRODUCT=FX_TRF CREATE_DATA_FILE=...
#
# 例:
#   ./run.sh trades-create.js dev smoke
#   ./run.sh trades-query                        # 默认 local + smoke
#   ./run.sh trades-create local baseline VUS=1 DURATION=600s
#
# 逐 HTTP 报文调试（仅 smoke 级验证；报文只写 k6.log 不刷屏；full 会把 .dat
# 二进制整个倒进日志，用完删 k6.log）:
#   K6_HTTP_DEBUG=headers ./run.sh trades-query
#   K6_HTTP_DEBUG=full ./run.sh trades-create local smoke RATE=1 DURATION=5s MAX_VUS=1
set -euo pipefail
K6_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$K6_ROOT"

# ── 全链路统一 UTC ────────────────────────────────────────────
# 服务器日志是 UTC，k6.log/manifest 的价值之一就是与服务端日志对表——
# 本地 +08:00 对 UTC 意味着每次排障都要心算时差。TZ 被 k6 子进程继承
# （k6 是 Go，各平台都认 TZ），下面 date 生成的 runId 与结果日目录同为 UTC。
export TZ=UTC

usage() {
  echo "用法: $0 <scenario>[.js] [env] [profile] [KEY=value ...]" >&2
  echo "" >&2
  echo "scenarios: $(ls src/scenarios/*.js 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.js$//' | tr '\n' ' ')" >&2
  echo "envs:      $(ls config/environments/*.json 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.json$//' | tr '\n' ' ')" >&2
  echo "profiles:  $(ls profiles/*.json 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.json$//' | tr '\n' ' ')" >&2
  exit 2
}

[[ $# -lt 1 ]] && usage

SCENARIO="${1%.js}"; shift
ENV_NAME="local" PROFILE="smoke" POS=0
RAW_OVERRIDES=()
for a in "$@"; do
  if [[ "$a" == *=* || "$a" == "-e" ]]; then
    RAW_OVERRIDES+=("$a")
  else
    POS=$((POS + 1))
    if [[ "$POS" == 1 ]]; then ENV_NAME="$a"; else PROFILE="$a"; fi
  fi
done

# ── 覆盖项前置校验：在 k6 启动前发现拼写问题，而不是白等一轮 ──
OVERRIDE_ARGS=()
for o in ${RAW_OVERRIDES[@]+"${RAW_OVERRIDES[@]}"}; do
  [[ -z "$o" || "$o" == "-e" ]] && continue          # 混进来的裸 -e 直接忽略
  if [[ ! "$o" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
    echo "ERROR: 覆盖项格式错误: '$o'（应为 KEY=value，不带 -e 前缀，如 VUS=8）" >&2
    exit 1
  fi
  OVERRIDE_ARGS+=(-e "$o")
done

SCENARIO_FILE="src/scenarios/${SCENARIO}.js"
ENV_FILE="config/environments/${ENV_NAME}.json"
PROFILE_FILE="profiles/${PROFILE}.json"
[[ -f "$SCENARIO_FILE" ]] || { echo "ERROR: 场景不存在: ${SCENARIO}（${SCENARIO_FILE}）" >&2; usage; }
[[ -f "$ENV_FILE" ]] || { echo "ERROR: 环境不存在: ${ENV_NAME}（${ENV_FILE}）——参数顺序 <scenario> <env> <profile>" >&2; usage; }
[[ -f "$PROFILE_FILE" ]] || { echo "ERROR: profile 不存在: ${PROFILE}（${PROFILE_FILE}）——参数顺序 <scenario> <env> <profile>" >&2; usage; }

command -v k6 >/dev/null 2>&1 || {
  echo "ERROR: k6 不在 PATH" >&2
  echo "  macOS:   brew install k6" >&2
  echo "  Windows: winget install k6 --source winget" >&2
  echo "  Linux:   https://grafana.com/docs/k6/latest/set-up/install-k6/" >&2
  exit 2
}
# ── 从 config/<env>.json 读一个平铺标量 ──
# ⚠ 刻意不是 JSON 解析器：bash 没有内置解析，jq/python/node 在压测机上都不能假定
#   存在。只处理"独占一行的 `"key": value`"这一种形态（去引号、去尾逗号），
#   这样读的键在文件里必须唯一。结构化解析都在 k6 侧（lib/config.js）。
cfg_get() {
  sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\(.*\)$/\1/p" "$ENV_FILE" \
    | head -1 | sed 's/,[[:space:]]*$//; s/^"//; s/"$//'
}

# 环境级地址：配置文件为准，环境变量单次覆盖（改文件容易被顺手提交，覆盖不会）
PROM_URL="${K6_PROMETHEUS_RW_SERVER_URL:-$(cfg_get promRwUrl)}"
GRAFANA_URL="${GRAFANA_DASHBOARD_URL:-$(cfg_get grafanaDashboard)}"

# ── 结果目录：results/<UTC日>/<runId>/ ───────────────────────
# 时间戳只取一次再派生日目录——取两次可能跨零点落错天；
# runId 自含日期，目录被拷走后仍能说明自己何时跑的。
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DAY="${STAMP%%-*}"
RUN_ID="${SCENARIO}_${ENV_NAME}_${PROFILE}_${STAMP}"
RUN_DIR="results/${RUN_DAY}/${RUN_ID}"
mkdir -p "$RUN_DIR"

# ── run manifest ─────────────────────────────────────────────
# "一次只变一个变量"的纪律只有事后可核验才成立——没有 manifest，
# 三个月后的压测结果就是一堆无法解释的数字。
MANIFEST="$RUN_DIR/manifest.txt"
{
  echo "runId:        $RUN_ID"
  echo "timestamp:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "epochMillis:  $(( $(date +%s) * 1000 ))    # ← 贴进 Grafana URL 的 &from="
  echo "scenario:     $SCENARIO_FILE"
  echo "env:          $ENV_FILE"
  echo "profile:      $PROFILE_FILE"
  echo "overrides:    ${RAW_OVERRIDES[*]:-<none>}"
  echo "grafana:      ${GRAFANA_URL:-<none>}"
  echo "prometheus:   ${PROM_URL:-<none>}"
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

echo "▶ scenario $SCENARIO_FILE"
echo "▶ env      $ENV_FILE"
echo "▶ profile  $PROFILE_FILE"
[[ "${#RAW_OVERRIDES[@]}" -gt 0 ]] && echo "▶ override ${RAW_OVERRIDES[*]}"
echo "▶ results  $RUN_DIR"
echo ""

# ── 输出通道 ─────────────────────────────────────────────────
# result.csv = 逐请求明细（含全部 tag），三分类计数之外的逐条排查靠它
OUT_ARGS=(--out "csv=$RUN_DIR/result.csv")

if [[ -n "$PROM_URL" ]]; then
  OUT_ARGS+=(--out experimental-prometheus-rw)
  export K6_PROMETHEUS_RW_SERVER_URL="$PROM_URL"
  # 默认只推 p(99)；官方 19665 与自建面板要 p95 等，缺了延迟图半空。显式设置仍优先。
  export K6_PROMETHEUS_RW_TREND_STATS="${K6_PROMETHEUS_RW_TREND_STATS:-p(95),p(99),min,max,avg}"
  # 结束即标记序列 stale——否则 from->now 查询里尾值再飘 ~5 分钟，
  # 经典的"Grafana 和 summary 对不上"来源之一。
  export K6_PROMETHEUS_RW_STALE_MARKERS="${K6_PROMETHEUS_RW_STALE_MARKERS:-true}"
  echo "▶ prometheus  $PROM_URL  (trend stats: $K6_PROMETHEUS_RW_TREND_STATS)"
  echo ""
fi

# ── k6 内置 web dashboard（k6 ≥ v0.49）─────────────────────
# 运行中 http://127.0.0.1:5665 看实时曲线，结束导出自包含 HTML——
# Prometheus 未接通前这是唯一的时序视图。⚠ 不要拿它判通过与否：
# 它的错误率是 http_req_failed（HTTP 层），本系统业务失败也返回 200，
# summary 里的三分类才是权威。并行第二个实例撞端口：K6_WEB_DASHBOARD_PORT=5666
# 换端口，或 K6_WEB_DASHBOARD=false 关闭。极短运行 k6 会跳过导出属正常。
if [[ "${K6_WEB_DASHBOARD:-true}" != "false" ]]; then
  export K6_WEB_DASHBOARD=true
  export K6_WEB_DASHBOARD_EXPORT="$RUN_DIR/dashboard.html"
  echo "▶ dashboard  http://127.0.0.1:${K6_WEB_DASHBOARD_PORT:-5665} → 导出 $RUN_DIR/dashboard.html"
  echo ""
fi

# 逐报文调试经 k6 原生 K6_HTTP_DEBUG 直通，runner 不做翻译。
# 开启时用 k6 原生 K6_LOG_OUTPUT 把日志流（含报文转储）直写 k6.log——
# 报文动辄几百 KB，刷屏毫无可读性；终端只留进度与文本摘要。
if [[ -n "${K6_HTTP_DEBUG:-}" ]]; then
  export K6_LOG_OUTPUT="${K6_LOG_OUTPUT:-file=$RUN_DIR/k6.log}"
  echo "⚠ K6_HTTP_DEBUG=${K6_HTTP_DEBUG} — 每条 HTTP 报文写入 ${K6_LOG_OUTPUT#file=}（不进终端），仅 smoke 级验证用；"
  echo "  报文含真实业务数据，full 还会整倒 .dat 二进制——用完删除该日志。"
  echo ""
fi

K6_ARGS=(run
  --tag "testid=$RUN_ID"
  -e ENV="$ENV_NAME"
  -e PROFILE="$PROFILE"
  -e TESTID="$RUN_ID"
  -e RESULT_DIR="$RUN_DIR")
K6_ARGS+=(${OVERRIDE_ARGS[@]+"${OVERRIDE_ARGS[@]}"})
K6_ARGS+=("${OUT_ARGS[@]}" "$SCENARIO_FILE")

set +e
if [[ -n "${K6_HTTP_DEBUG:-}" ]]; then
  # 日志已由 k6 直写 k6.log（K6_LOG_OUTPUT），不再 tee——两路同写一个文件会互相踩踏
  k6 "${K6_ARGS[@]}"
  K6_RC=$?
else
  k6 "${K6_ARGS[@]}" 2>&1 | tee "$RUN_DIR/k6.log"
  K6_RC=${PIPESTATUS[0]}
fi
set -e

# 结束时间戳——与 epochMillis 配对贴进 Grafana 的 &from= &to=
echo "endEpochMillis: $(( $(date +%s) * 1000 ))" >> "$MANIFEST"

# ── 判定：summary.json/summary.txt 由 k6 的 handleSummary 直接写盘（含 0 请求
#    防假绿的合成失败项，见 src/lib/report.js），runner 只提取 verdict 字段。
#    文件缺失 = 没跑到 handleSummary，基本是 init 报错（preflight 中止仍会产出并判 FAIL）。
VERDICT="FAIL(no-summary)"
if [[ -f "$RUN_DIR/summary.json" ]]; then
  VERDICT="$(sed -n 's/^[[:space:]]*"verdict": *"\([A-Z]*\)".*/\1/p' "$RUN_DIR/summary.json" | head -1)"
  [[ -z "$VERDICT" ]] && VERDICT="FAIL(bad-summary)"
else
  echo "⚠ 未生成 summary.json（k6 未跑到 handleSummary，多为 init 阶段报错——看 k6.log 开头）" >&2
fi

echo ""
# ⚠ ${VERDICT} 的大括号不可省：bash 3.2 在 C locale 下解析变量名时会把紧随的
#   多字节字符（如全角括号）字节误并进名字，报 unbound variable
echo "── 结果（${VERDICT}）────────────────────────────────"
[[ -f "$RUN_DIR/summary.txt" ]] && echo "summary:   $RUN_DIR/summary.txt   ← 三分类/双延迟文本摘要（终端同款），判定权威"
[[ -f "$RUN_DIR/summary.json" ]] && echo "raw:       $RUN_DIR/summary.json  ← 机读（verdict/基线对比输入）"
[[ -f "$RUN_DIR/dashboard.html" ]] && echo "dashboard: $RUN_DIR/dashboard.html ← 时序曲线（不作判定）"
echo "csv:       $RUN_DIR/result.csv"
echo "k6 log:    $RUN_DIR/k6.log"
echo "manifest:  $MANIFEST"
echo ""
if [[ -n "$GRAFANA_URL" ]]; then
  sep='?'; [[ "$GRAFANA_URL" == *\?* ]] && sep='&'
  START_MS=$(grep -oE 'epochMillis: *[0-9]+' "$MANIFEST" | head -1 | grep -oE '[0-9]+')
  END_MS=$(grep -oE 'endEpochMillis: *[0-9]+' "$MANIFEST" | grep -oE '[0-9]+')
  echo "Grafana:   ${GRAFANA_URL}${sep}from=${START_MS}&to=${END_MS}&var-testid=${RUN_ID}"
else
  echo "Grafana 时间范围（替换 URL 里的 from=now-1h&to=now）:"
  grep -E 'epochMillis' "$MANIFEST" | sed 's/^/  /'
  echo "  想要现成链接：在 $ENV_FILE 配 grafanaDashboard（或单次 export GRAFANA_DASHBOARD_URL）"
fi

if grep -q 'PREFLIGHT FAILED' "$RUN_DIR/k6.log" 2>/dev/null; then
  echo ""
  echo "⚠ PREFLIGHT FAILED — 用例池未通过本地校验（占位符/缺字段/空池），一条请求都没发。"
  grep 'PREFLIGHT' "$RUN_DIR/k6.log" | tail -5
  echo "  先把数据填好：见 data/worker-svc/trade-management/README.md"
fi

# 退出码：k6 非零（阈值中断/中止/脚本错）优先；k6 为零但判定 FAIL（如 0 样本）也非零
if [[ "$K6_RC" -ne 0 ]]; then exit "$K6_RC"; fi
[[ "$VERDICT" == PASS ]] || exit 1
exit 0
