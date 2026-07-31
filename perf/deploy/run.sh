#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."   # 定位到 perf/ 根

SCENARIO="" TAGS="" PROFILE="smoke" ENV_NAME="local" RATE="" DURATION="" LOCAL=0 DRY=0
IMAGE="${K6_IMAGE:-perf-k6:latest}"
NAMESPACE="${K6_NAMESPACE:-perf}"

usage() {
  cat <<'EOF'
用法: deploy/run.sh (-s <scenario> | --tags <t1,t2>) [-p profile] [-e env] [-r rate] [-d duration] [--local] [--dry-run]
  -s        单场景名（src/scenarios/<name>.js）
  --tags    按场景 meta.tags 过滤批量执行（逗号=与）
  -p        负载 profile: smoke|load|stress|spike|soak（默认 smoke）
  -e        环境名（config/environments/<env>.json，默认 local）
  -r / -d   覆盖目标速率 / 稳态时长
  --local   本机 k6 直跑（默认提交 k8s Job）
  --dry-run 只打印将执行的命令/渲染的 manifest
注意: --tags 是本脚本参数，与 k6 的 --tag（指标标签）无关，不会传给 k6。
EOF
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s) SCENARIO="$2"; shift 2 ;;
    --tags) TAGS="$2"; shift 2 ;;
    -p) PROFILE="$2"; shift 2 ;;
    -e) ENV_NAME="$2"; shift 2 ;;
    -r) RATE="$2"; shift 2 ;;
    -d) DURATION="$2"; shift 2 ;;
    --local) LOCAL=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) usage ;;
  esac
done

[[ -n "$SCENARIO" && -n "$TAGS" ]] && usage
[[ -z "$SCENARIO" && -z "$TAGS" ]] && usage
[[ -f "config/environments/${ENV_NAME}.json" ]] || { echo "未知环境: ${ENV_NAME}" >&2; exit 1; }

PROM_RW_URL="$(node -p "JSON.parse(require('fs').readFileSync('config/environments/${ENV_NAME}.json','utf8')).promRwUrl || ''")"
K6_OUT_VALUE=""
[[ -n "$PROM_RW_URL" ]] && K6_OUT_VALUE="experimental-prometheus-rw"

if [[ -n "$TAGS" ]]; then
  SCENARIOS="$(node tools/scenario-meta.mjs src/scenarios "$TAGS")"
  [[ -z "$SCENARIOS" ]] && { echo "没有场景匹配 tags: $TAGS" >&2; exit 1; }
else
  [[ -f "src/scenarios/${SCENARIO}.js" ]] || { echo "场景不存在: ${SCENARIO}" >&2; exit 1; }
  SCENARIOS="$SCENARIO"
fi

mkdir -p reports
SUMMARY_ROWS=()

postprocess() {
  local testid="$1"
  node tools/extract-summary.mjs "reports/${testid}.log" "reports/${testid}.json"
  node tools/render-report.mjs "reports/${testid}.json"
}

run_local() {
  local sc="$1" testid="$2"
  local args=(run --tag "testid=${testid}" -e "ENV=${ENV_NAME}" -e "PROFILE=${PROFILE}" -e "TESTID=${testid}")
  [[ -n "$RATE" ]] && args+=(-e "RATE=${RATE}")
  [[ -n "$DURATION" ]] && args+=(-e "DURATION=${DURATION}")
  [[ -n "$PROM_RW_URL" ]] && args+=(-o experimental-prometheus-rw)
  if [[ "$DRY" == 1 ]]; then
    echo "DRY(local): k6 ${args[*]} src/scenarios/${sc}.js"
    return 0
  fi
  K6_PROMETHEUS_RW_SERVER_URL="$PROM_RW_URL" K6_PROMETHEUS_RW_TREND_STATS="p(95),p(99)" \
    k6 "${args[@]}" "src/scenarios/${sc}.js" 2>&1 | tee "reports/${testid}.log" || true
  postprocess "$testid"
}

run_k8s() {
  local sc="$1" testid="$2"
  export TESTID="$testid" SCENARIO="$sc" PROFILE ENV_NAME IMAGE PROM_RW_URL K6_OUT_VALUE
  export RATE_OPT="${RATE:-}" DURATION_OPT="${DURATION:-}"
  if [[ "$DRY" == 1 ]]; then
    envsubst < deploy/job.yaml
    return 0
  fi
  envsubst < deploy/job.yaml | kubectl -n "$NAMESPACE" apply -f -
  kubectl -n "$NAMESPACE" wait --for=condition=complete --timeout=4h "job/k6-${testid}" || true
  kubectl -n "$NAMESPACE" logs "job/k6-${testid}" > "reports/${testid}.log"
  postprocess "$testid"
}

for sc in $SCENARIOS; do
  TESTID="${sc}-$(date +%Y%m%d-%H%M%S)"
  echo "==> ${sc} (testid=${TESTID}, profile=${PROFILE}, env=${ENV_NAME})"
  if [[ "$LOCAL" == 1 ]]; then run_local "$sc" "$TESTID"; else run_k8s "$sc" "$TESTID"; fi
  if [[ "$DRY" == 0 && -f "reports/${TESTID}.json" ]]; then
    VERDICT="$(node -p "JSON.parse(require('fs').readFileSync('reports/${TESTID}.json','utf8')).thresholdFailures.length ? 'FAIL' : 'PASS'")"
    SUMMARY_ROWS+=("${VERDICT}  ${sc}  reports/${TESTID}.html")
  fi
  sleep 1   # 保证下一个 testid 时间戳不同
done

if [[ "$DRY" == 0 && "${#SUMMARY_ROWS[@]}" -gt 0 ]]; then
  echo
  echo "==== 汇总 ===="
  printf '%s\n' "${SUMMARY_ROWS[@]}"
  for r in "${SUMMARY_ROWS[@]}"; do
    [[ "$r" == FAIL* ]] && exit 1
  done
fi
exit 0
