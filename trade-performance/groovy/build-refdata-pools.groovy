/*
 * build-refdata-pools.groovy
 * 挂载点：setUp Thread Group → JSR223 PostProcessor（在两个 refdata 查询之后）
 *
 * 职责：把 JSON Extractor 抓出来的 portfolio / counterparty 列表转成全局池。
 *
 * 为什么写 props 而不是 vars：
 *   vars (JMeterVariables) 是 **每线程独立** 的，setUp Thread Group 和主 Thread Group
 *   是不同线程，setUp 写进 vars 的东西主线程一个都读不到。
 *   props (JMeterProperties) 是 **JVM 全局** 的，这是跨线程组传数据的唯一途径。
 *
 * 分布式压测注意：props 不跨 slave 节点传播，每个 slave 会各自执行一次 setUp
 * （各节点自洽，是好事），但快照归档需按节点收集。
 */

import groovy.json.JsonOutput

// ── 1. 从 Match No. = -1 的提取结果重组列表 ──
// JSON Extractor 设 -1 时产出 xxx_matchNr 以及 xxx_1 / xxx_2 / ... 一组变量
int nPortfolio = (vars.get('portfolioIds_matchNr') ?: '0') as int
int nCp        = (vars.get('cpFmIds_matchNr') ?: '0') as int

def portfolios = (1..nPortfolio).collect { vars.get("portfolioIds_${it}") }
                                .findAll { it && it != 'NOT_FOUND' }

def counterparties = (1..nCp).collect {
    [ fmId: vars.get("cpFmIds_${it}"), name: vars.get("cpNames_${it}") ]
}.findAll { it.fmId && it.fmId != 'NOT_FOUND' }

// ── 2. 池非空检查（前置校验第 1 层）──
// 这一层单独拎出来，是因为它的失败原因和后两层完全不同：
// 空池 = 环境根本没数据 / 查询条件写错，不是"数据失效"，prune 策略对它无意义
int minSize = (props.getProperty('preflightMinPoolSize') ?: '1') as int
if (portfolios.size() < minSize || counterparties.size() < minSize) {
    def msg = "REFDATA POOL TOO SMALL: portfolios=${portfolios.size()}, " +
              "counterparties=${counterparties.size()}, required>=${minSize}"
    log.error(msg)
    props.put('refdataPoolError', msg)
} else {
    props.remove('refdataPoolError')
}

// ── 3. 写入全局池 ──
props.put('perfPortfolios',     JsonOutput.toJson(portfolios))
props.put('perfCounterparties', JsonOutput.toJson(counterparties))

log.info("refdata resolved: ${portfolios.size()} portfolios, ${counterparties.size()} counterparties")
