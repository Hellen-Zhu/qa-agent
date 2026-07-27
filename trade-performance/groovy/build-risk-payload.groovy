/*
 * build-risk-payload.groovy
 * 挂载点：calculate-risk.jmx 与 calc-partial-novation-risk.jmx 的 JSR223 PreProcessor
 *
 * 职责：为两个"对既有 trade 算风险"的接口构造请求体。
 *
 * ── 为什么两个接口共用一个构造脚本 ──
 * 它们的入参形状只差一个 percentage：
 *   calculate-risk                  {"tradeId": "..."}
 *   calculate-partial-novation-risk {"tradeId": "...", "percentage": 50}
 * 拆成两个文件意味着真实契约确认后要改两处。合成一处、按需带字段，
 * 与 trigger-event 把 10 种事件收敛到一个 payload 构造器是同一个理由。
 *
 * ⚠⚠ 请求体形状为推断值，未经真实 curl 验证 ⚠⚠
 *    真实契约确认后只改本文件，两个接口同时生效。
 *    猜错的表现：HTTP 400 或 riskOk=false —— 会被 tag-risk-outcome.groovy
 *    打上标签，不会静默通过。
 */

import groovy.json.JsonOutput

def tradeId = vars.get('targetTradeId')

if (!tradeId || tradeId == 'NOT_FOUND') {
    vars.put('riskPayload', '{}')
    vars.put('errClass', 'script')
    log.error('risk 计算缺少 targetTradeId —— 调用方是否先取了一笔 trade？')
    return
}

def body = [ tradeId: tradeId ]

// partialPct 只有部分转让风险预览需要。calculate-risk 不设这个变量，
// 于是这里自然不带该字段 —— 同一个脚本服务两个接口。
def pct = vars.get('partialPct')
if (pct && pct.trim() && !pct.startsWith('${')) {
    body.percentage = pct.trim() as BigDecimal
}

vars.put('riskPayload', JsonOutput.toJson(body))
