#!/usr/bin/env bash
# 冒烟自验:1 线程 1 循环跑一遍 testplan.smoke.jmx,判定脚本是否真的能用。
#
# 冒烟不是压测。它验证的是「结构对不对、关联提取生效没、token 传下去没」,
# 目的是避免交付一个从没跑过的脚本。10 秒的成本,换掉压了 20 分钟才发现
# 全是 401 的那种失败。
#
# 用法: bash smoke.sh <生成产物目录>

set -uo pipefail

OUTDIR="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JMX="$OUTDIR/testplan.smoke.jmx"
EXPECT="$OUTDIR/smoke-expect.json"
JTL="$OUTDIR/smoke.jtl"
LOG="$OUTDIR/smoke-jmeter.log"

if ! command -v jmeter >/dev/null 2>&1; then
  cat >&2 <<'EOF'
未找到 jmeter 命令。安装方式:
  macOS   brew install jmeter
  Linux   下载 https://jmeter.apache.org/download_jmeter.cgi 后把 bin/ 加进 PATH

冒烟这一步需要真实运行 JMeter,不能跳过——跳过就等于交付一个从没跑过的脚本。
EOF
  exit 2
fi

[[ -f "$JMX" ]] || { echo "找不到 $JMX,先跑 gen_jmx.py" >&2; exit 2; }
[[ -f "$EXPECT" ]] || { echo "找不到 $EXPECT,先跑 gen_jmx.py" >&2; exit 2; }

rm -f "$JTL" "$LOG"

echo "冒烟运行中(1 线程 1 循环,所有 Throughput 控制器已强制 100%)..."
echo

# XML 格式 + 保存请求数据:冒烟量极小,换取可诊断性是划算的。
# 正式压测绝不要开这些——samplerData 会让 .jtl 体积爆炸并拖慢压测机。
jmeter -n -t "$JMX" -l "$JTL" -j "$LOG" \
  -Jjmeter.save.saveservice.output_format=xml \
  -Jjmeter.save.saveservice.samplerData=true \
  -Jjmeter.save.saveservice.requestHeaders=true \
  -Jjmeter.save.saveservice.url=true \
  -Jjmeter.save.saveservice.response_data.on_error=true \
  -Jjmeter.save.saveservice.assertion_results=all \
  -Jjmeter.save.saveservice.assertion_results_failure_message=true \
  >/dev/null 2>&1

JMETER_RC=$?
if [[ ! -f "$JTL" ]]; then
  echo "JMeter 没有产出结果文件,通常是 .jmx 结构非法或 CSV 路径不对。" >&2
  echo "看日志: $LOG" >&2
  tail -n 30 "$LOG" >&2 2>/dev/null
  exit 2
fi
if [[ $JMETER_RC -ne 0 ]]; then
  echo "注意: jmeter 退出码为 $JMETER_RC,详见 $LOG" >&2
  echo
fi

python3 "$SCRIPT_DIR/check_smoke.py" "$JTL" "$EXPECT"
RESULT=$?

echo
echo "JMeter 日志: $LOG"
echo "原始结果  : $JTL"
exit $RESULT
