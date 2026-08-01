#!/usr/bin/env bash
#
# run.sh — 本地 runner（不碰 k8s）。deploy/run.sh --local 的便捷入口：
# 参数解析后委托过去，报告提取/汇总表/PASS-FAIL 判定逻辑只存在一份。
#
#   ./run.sh <scenario>[.js] [env] [profile] [KEY=value ...] [--dry-run]
#   ./run.sh --tags <t1,t2>  [env] [profile] [KEY=value ...] [--dry-run]
#
#   scenario   src/scenarios/ 下的场景名（.js 可带可不带）
#   env        config/environments/ 下的环境名，默认 local
#   profile    profiles/ 下的负载 profile，默认 smoke
#   KEY=value  任意 __ENV 覆盖，透传给 k6 -e（VUS=2 RATE=30 DURATION=600s
#              MAX_VUS=50 PRODUCT=FX_TRF CREATE_DATA_FILE=... 等）
#
# 例:
#   ./run.sh trades-create.js dev smoke
#   ./run.sh trades-query                        # 默认 local + smoke
#   ./run.sh trades-create local baseline VUS=1 DURATION=600s
#   ./run.sh --tags P0 dev load
#
# k8s 提交入口是 deploy/run.sh（不带 --local）。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

list_scenarios() {
  ls src/scenarios/*.js 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.js$//' | tr '\n' ' '
}

usage() {
  sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  echo "可用场景: $(list_scenarios)"
  echo "可用 profile: $(ls profiles/*.json 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.json$//' | tr '\n' ' ')"
  exit 2
}

[[ $# -lt 1 ]] && usage

FWD=()
if [[ "$1" == "--tags" ]]; then
  [[ $# -lt 2 ]] && usage
  FWD+=(--tags "$2")
  shift 2
else
  SC="${1%.js}"
  if [[ ! -f "src/scenarios/${SC}.js" ]]; then
    echo "场景不存在: $1" >&2
    echo "可用场景: $(list_scenarios)" >&2
    exit 1
  fi
  FWD+=(-s "$SC")
  shift
fi

# 位置参数固定顺序 <env> <profile>；KEY=value 与 --dry-run 位置任意
ENV_NAME="local" PROFILE="smoke" EXTRA=() POS=0
for a in "$@"; do
  case "$a" in
    --dry-run) FWD+=(--dry-run) ;;
    *=*) EXTRA+=("$a") ;;
    *)
      POS=$((POS + 1))
      if [[ "$POS" == 1 ]]; then ENV_NAME="$a"; else PROFILE="$a"; fi
      ;;
  esac
done

[[ -f "config/environments/${ENV_NAME}.json" ]] || {
  echo "未知环境: ${ENV_NAME}（参数顺序是 <scenario> <env> <profile>）" >&2
  echo "可用环境: $(ls config/environments/*.json 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.json$//' | tr '\n' ' ')" >&2
  exit 1
}
[[ -f "profiles/${PROFILE}.json" ]] || {
  echo "未知 profile: ${PROFILE}（参数顺序是 <scenario> <env> <profile>）" >&2
  echo "可用 profile: $(ls profiles/*.json 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.json$//' | tr '\n' ' ')" >&2
  exit 1
}

exec deploy/run.sh "${FWD[@]}" -e "$ENV_NAME" -p "$PROFILE" --local ${EXTRA[@]+"${EXTRA[@]}"}
