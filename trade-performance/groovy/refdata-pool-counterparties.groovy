/*
 * refdata-pool-counterparties.groovy
 * 挂载点：setup/refdata-preflight.jmx → "counterparties" Simple Controller 下的 JSR223 PostProcessor
 * （原 build-refdata-pools.groovy 的另一半，随四层重构拆分）
 *
 * 职责：把 counterparty 响应里的**全部**记录转成全局池，fmId 与 name **成对**保存。
 *
 * ── 成对保存不是可选项 ──
 * 下游 select-refdata.groovy 从池里取一条时，必须拿到同一条记录的 fmId 和 name。
 * 如果池里存的是两个独立数组，取的时候按下标对齐看似可行，但任何一次过滤
 * （如剔除失效项）都会让两个数组错位，且错位是静默的。
 * 存成 [{fmId, name}, ...] 从结构上杜绝这件事。
 *
 * props / 分布式注意事项见 refdata-pool-portfolios.groovy。
 */

import groovy.json.JsonOutput
import groovy.json.JsonSlurper

def POOL_KEY = 'counterparties'

def list = []
try {
    def data = new JsonSlurper().parseText(prev.getResponseDataAsString())?.data
    list = (data ?: []).collect { [ fmId: it.fmId as String, name: (it.name ?: '') as String ] }
                       .findAll { it.fmId && it.fmId != 'null' }
} catch (Exception e) {
    log.error("refdata/counterparties response is not JSON — ${e.message}")
}

props.put('perfCounterparties', JsonOutput.toJson(list))

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

log.info("refdata pool resolved: ${list.size()} counterparties")
