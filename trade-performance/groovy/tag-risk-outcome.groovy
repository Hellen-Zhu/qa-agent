/*
 * tag-risk-outcome.groovy
 * 挂载点：steps/view-trade-details.jmx → trade_risk_metrics → JSR223 PostProcessor
 *
 * 职责：把 risk-engine 的成败打成标签，供结果分析按维度切分。
 *
 * ── 软依赖的处理分两种，别混为一谈 ──
 *
 * 常规场景（softDependencyMasking=false，默认）：
 *   risk-metrics 挂了就是挂了，照常计入错误率。
 *   这时候 503 是**意料之外**的，必须在默认报告里刺眼地显示出来。
 *
 * 降级场景（softDependencyMasking=true，配合 m03-degrade-risk-engine 使用）：
 *   risk-engine 是被**故意**打断的，它的失败是实验条件而不是实验结果。
 *   此时把它计入错误率会让错误率虚高到分不清"真崩"和"按预期降级"，
 *   而这个场景要观察的恰恰是系统能否**优雅退化**（trade 主体仍可展示）。
 *   所以显式屏蔽，改由 riskOk 标签承载信息。
 *
 * 默认选"不屏蔽"：masking 是一把会让报告说谎的刀，必须显式开启、
 * 且开启记录进 run manifest，事后才知道这份报告是在什么前提下跑出来的。
 */

def code   = prev.getResponseCode()
def ok     = prev.isSuccessful() && code == '200'
def mask   = props.getProperty('softDependencyMasking') == 'true'

vars.put('riskOk', ok ? 'true' : 'false')

if (!ok) {
    // 保留原始状态码：503（下游挂了）和 504（超时）对应的处置完全不同，
    // 只记 riskOk=false 会把这两者的区别丢掉。
    vars.put('riskFailCode', code)
    log.debug("risk-metrics degraded for ${vars.get('tradeId')}: HTTP ${code}")

    if (mask) {
        prev.setSuccessful(true)
        prev.setResponseMessage("MASKED soft-dependency failure (HTTP ${code})")
    }
} else {
    vars.put('riskFailCode', '')
}
