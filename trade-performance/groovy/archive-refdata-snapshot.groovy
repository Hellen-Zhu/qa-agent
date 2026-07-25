/*
 * archive-refdata-snapshot.groovy
 * 挂载点：setUp Thread Group → JSR223 Sampler（最后一个）
 *
 * 职责：把本次运行**实际使用的**参考数据落盘归档。
 *
 * 为什么需要：setUp 每次运行时解析，保证了新鲜度，但代价是丢失了可复现性——
 * 三个月后回看一份报告，你无法知道当时用的是哪些 portfolio。
 * 快照把这两者重新拼在一起：数据是新鲜的，同时是可追溯的。
 *
 * 这份文件应与 run manifest 一起归档，构成"结果可复现"的完整证据链。
 */

import groovy.json.JsonSlurper

def outDir = props.getProperty('runResultDir')
if (!outDir) {
    log.warn('runResultDir not set — skipping refdata snapshot')
    SampleResult.setIgnore()
    return
}

def portfolios = new JsonSlurper().parseText(props.getProperty('perfPortfolios') ?: '[]')
def cps        = new JsonSlurper().parseText(props.getProperty('perfCounterparties') ?: '[]')

def f = new File(outDir, 'resolved-refdata.csv')
f.parentFile.mkdirs()

f.withWriter('UTF-8') { w ->
    w.writeLine('type,id,name')
    portfolios.each { w.writeLine("portfolio,${it},") }
    cps.each        { w.writeLine("counterparty,${it.fmId},\"${(it.name ?: '').replace('"', '""')}\"") }
}

log.info("refdata snapshot written: ${f.absolutePath} (${portfolios.size()} portfolios, ${cps.size()} counterparties)")

// 这个 Sampler 只是干活，不是被测请求。
// 不 setIgnore 的话它会作为一条 sample 混进 jtl，污染报告里的接口列表。
SampleResult.setIgnore()
