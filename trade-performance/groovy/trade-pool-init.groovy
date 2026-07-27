/*
 * trade-pool-init.groovy
 * 挂载点：setup/trade-pool.jmx → "blotter" Simple Controller 下的 JSR223 PostProcessor
 *
 * 职责：把 blotter 列表里的 tradeId 灌进全局池，供单接口测试取用。
 *
 * ── 与 checker task 池的关键差异：可重复使用，不是 claim-once ──
 *   checker task  一次性消费（approve 掉就没了）→ ConcurrentLinkedQueue.poll()
 *   trade         可反复操作（同一笔可多次 amend）→ 存 JSON 数组，随机取
 *
 * 但**同一笔 trade 上的并发事件仍会互斥**（pending approve 锁）。
 * 池太小时线程会频繁撞在同一笔上，产生 lockedRejection ——
 * 那是四眼原则的正确行为，读法是"数据池不够大"，不是系统缺陷。
 * 所以这里对池大小有下限检查。
 *
 * props / 分布式注意事项见 refdata-pool-portfolios.groovy。
 */

import groovy.json.JsonOutput
import groovy.json.JsonSlurper

def ids = []
try {
    def data = new JsonSlurper().parseText(prev.getResponseDataAsString())?.data
    def list = (data instanceof List) ? data : (data?.content ?: data?.items)
    ids = (list ?: []).collect { (it.id ?: it.tradeId) as String }
                      .findAll { it && it != 'null' }
} catch (Exception e) {
    log.error("GET /trades response is not JSON — ${e.message}")
}

props.put('perfTradeIds', JsonOutput.toJson(ids))

int minSize = (props.getProperty('tradePoolMinSize') ?: '10') as int
if (ids.size() < minSize) {
    def msg = "TRADE POOL TOO SMALL: ${ids.size()} trades, required>=${minSize} — " +
              "池太小会让多个线程反复撞同一笔 trade，产生大量 lockedRejection。" +
              "先灌一批存量 trade，或调低 tradePoolMinSize（但要知道结果会失真）。"
    log.error(msg)
    props.put('tradePoolError', msg)
} else {
    props.remove('tradePoolError')
}

log.info("trade pool initialised: ${ids.size()} trades")
