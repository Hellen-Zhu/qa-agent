/*
 * build-trigger-event-payload.groovy
 * 挂载点：steps/workers/trade-management/trigger-event.jmx → JSR223 PreProcessor
 *
 * 职责：为 10 种生命周期事件构造统一的 trigger-event 请求体。
 *
 * ⚠⚠ 请求体形状为推断值，未经真实 curl 验证 ⚠⚠
 *    假设 {"tradeId": "...", "eventType": "...", "params": {...}}。
 *    真实契约确认后**只改本文件**，10 种事件同时生效 —— 这正是把它们
 *    收敛到一个数据驱动 fragment 的收益（见 v2 §2.5.1）。
 *
 * ── 为什么 params 按事件类型分支 ──
 * 部分类事件（PartialNovation / StepOutPartial）需要比例参数，
 * 其余不需要。把分支写在这里而不是 CSV 里，是因为 CSV 只应描述**数据**，
 * 不应描述**结构**——否则加一种事件就要改 CSV 的列。
 */

import groovy.json.JsonOutput

def tradeId   = vars.get('targetTradeId')
def eventType = vars.get('eventType')

// ── 回退到全局池 ──
// journey（j04）在链路里自己查 blotter 并挑一笔，targetTradeId 已就位。
// 单接口测试（p06）没有那一步：每次迭代都先查列表会把 list 的耗时混进被测值，
// 所以取数挪到了 setUp 的 trade-pool。这里按需回退，两个调用方共用同一份 fragment。
// 与 resolve-dat-file.groovy 回退到 preflightDatFile 是同一个模式。
if (!tradeId || tradeId == 'NOT_FOUND' || tradeId.startsWith('${')) {
    def poolJson = props.getProperty('perfTradeIds')
    if (poolJson) {
        def pool = new groovy.json.JsonSlurper().parseText(poolJson)
        if (pool) {
            tradeId = pool[java.util.concurrent.ThreadLocalRandom.current().nextInt(pool.size())]
            vars.put('targetTradeId', tradeId as String)
        }
    }
}

if (!tradeId || tradeId == 'NOT_FOUND' || !eventType) {
    // 调用方没给目标 trade 或事件类型。发出去只会得到 400，
    // 混进错误率里看不出根因，所以在这里标成脚本错误。
    vars.put('eventPayload', '{}')
    vars.put('errClass', 'script')
    log.error("trigger-event 缺少入参：targetTradeId=${tradeId} eventType=${eventType}")
    return
}

def params = [:]
def pct = vars.get('partialPct')
if (pct && pct.trim() && !pct.startsWith('${')) {
    // 部分novation / 部分step-out：比例参数
    params.percentage = pct.trim() as BigDecimal
}

def body = [ tradeId: tradeId, eventType: eventType ]
if (params) body.params = params

vars.put('eventPayload', JsonOutput.toJson(body))

// 事件引用，仅存在于结果文件，便于事后在被测系统里定位这一批压测产生的事件
vars.put('eventReference',
         "PERF-${vars.get('eventCaseId') ?: 'EVT'}-${ctx.getThreadNum()}-${vars.getIteration()}")
