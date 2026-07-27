/*
 * refdata-pool-portfolios.groovy
 * 挂载点：setup/refdata-preflight.jmx → "portfolios" Simple Controller 下的 JSR223 PostProcessor
 * （原 build-refdata-pools.groovy 的一半，随四层重构拆分）
 *
 * 职责：把 portfolios 响应里的**全部** id 转成全局池。
 *
 * ── 为什么写 props 而不是 vars ──
 * vars (JMeterVariables) 是**每线程独立**的，setUp Thread Group 和主 Thread Group
 * 是不同线程，setUp 写进 vars 的东西主线程一个都读不到。
 * props (JMeterProperties) 是 **JVM 全局**的，这是跨线程组传数据的唯一途径。
 *
 * 分布式压测注意：props 不跨 slave 节点传播，每个 slave 会各自执行一次 setUp
 * （各节点自洽，是好事），但快照归档需按节点收集。
 *
 * ── 为什么直接解析 prev 而不是读 JSON Extractor 的 xxx_matchNr 变量 ──
 * Match No.=-1 的提取器必须放在 sampler 内部，而 sampler 在原子 fragment 里，
 * 原子 fragment 要同时服务 pick 与 pool 两种用法，不能绑定任何一种。
 * 直接解析响应体让原子 fragment 保持中立。
 */

import groovy.json.JsonOutput
import groovy.json.JsonSlurper

def POOL_KEY = 'portfolios'

def list = []
try {
    def data = new JsonSlurper().parseText(prev.getResponseDataAsString())?.data
    list = (data ?: []).collect { it.id as String }.findAll { it && it != 'null' }
} catch (Exception e) {
    log.error("refdata/portfolios response is not JSON — ${e.message}")
}

props.put('perfPortfolios', JsonOutput.toJson(list))

// ── 池非空检查（前置校验第 1 层）──
// 这一层单独拎出来，是因为它的失败原因和后两层完全不同：
// 空池 = 环境根本没数据 / 查询条件写错，不是"数据失效"，prune 策略对它无意义。
//
// 错误信息以 "kind=..." 分段累积在同一个属性里，portfolios 与 counterparties
// 各自维护自己那一段，互不覆盖 —— setUp 是单线程顺序执行，无竞争。
int minSize = (props.getProperty('preflightMinPoolSize') ?: '1') as int
def others = (props.getProperty('refdataPoolError') ?: '')
                 .split(';').findAll { it && !it.startsWith("${POOL_KEY}=") }
if (list.size() < minSize) {
    others << "${POOL_KEY}=${list.size()}(required>=${minSize})"
    log.error("REFDATA POOL TOO SMALL: ${POOL_KEY}=${list.size()}, required>=${minSize}")
}
if (others) {
    props.put('refdataPoolError', others.join(';'))
} else {
    props.remove('refdataPoolError')
}

log.info("refdata pool resolved: ${list.size()} portfolios")
