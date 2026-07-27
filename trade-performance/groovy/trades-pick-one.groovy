/*
 * trades-pick-one.groovy
 * 挂载点：journeys/j04-lifecycle-event.jmx → "blotter" Simple Controller 下的 JSR223 PostProcessor
 *
 * 职责：从 blotter 列表响应里随机挑一笔 trade，作为本次生命周期事件的目标。
 *
 * ── 为什么随机挑，而不是像 checker task 那样 claim-once ──
 * 语义不同：
 *   checker task  一次性消费（approve 掉就没了）        → claim-once 队列
 *   trade         可反复操作（同一笔可被多次 amend）    → 随机挑即可
 *
 * 但**有一个例外要小心**：若两个线程同时挑中同一笔 trade 并各自提交事件，
 * 第二个会因为 trade 已处于 pending approve 而被业务拒绝。
 * 这是四眼原则的正确行为，不是缺陷 —— assert-trigger-event-response.groovy
 * 把它单列为 lockedRejection，与真正的业务拒绝分开统计。
 *
 * 若 lockedRejection 比例过高，说明**数据池太小**（可挑的 trade 太少），
 * 该去扩数据而不是找开发。S-05 同实体争用场景则反过来刻意制造这种碰撞。
 *
 * ⚠ JSONPath 假设 $.data[*].id，未经真实响应验证。
 */

import groovy.json.JsonSlurper
import java.util.concurrent.ThreadLocalRandom

def list
try {
    def data = new JsonSlurper().parseText(prev.getResponseDataAsString())?.data
    // 兼容裸数组与 Spring Page 两种形态
    list = (data instanceof List) ? data : (data?.content ?: data?.items)
} catch (Exception e) {
    log.error("GET /trades response is not JSON — ${e.message}")
    vars.put('targetTradeId', 'NOT_FOUND')
    return
}

if (!list) {
    log.error('GET /trades 没有返回任何 trade —— 环境里需要先有存量数据')
    vars.put('targetTradeId', 'NOT_FOUND')
    return
}

def t = list[ThreadLocalRandom.current().nextInt(list.size())]
vars.put('targetTradeId', (t.id ?: t.tradeId ?: 'NOT_FOUND') as String)
