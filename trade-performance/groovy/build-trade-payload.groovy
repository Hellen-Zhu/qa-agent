/*
 * build-trade-payload.groovy
 * 挂载点：主 Thread Group → HTTP Request "create_trade" 的 JSR223 PreProcessor（第 2 个）
 *
 * 职责：拼出 multipart 里 `trade` 这个表单字段的值。
 *
 * 关键：trade 是 **普通表单字段**，不是文件 part。
 * 因此不需要写临时文件、不需要每线程文件管理、不需要 tearDown 清目录。
 * （真实 curl 用的是 -F 'trade={...}' 而非 -F 'trade=@file'）
 *
 * 用 JsonOutput 而不是字符串拼接：counterpartyName 里含 `*`（PRINTINGINT10LTD*HKG），
 * 真实数据还可能出现引号、反斜杠、非 ASCII。手拼字符串迟早拼出非法 JSON，
 * 而那种失败在压测里表现为"某些行偶发 400"，极难定位到是转义问题。
 */

import groovy.json.JsonOutput

def trade = [
    basic: [
        portfolioId     : vars.get('portfolioId'),
        counterpartyFmId: vars.get('counterpartyFmId'),
        counterpartyName: vars.get('counterpartyName'),
        // CSV 末列留空 → JMeter 给出空串；?: '' 兜住 null（列缺失时）
        notionalCurrency: vars.get('notionalCurrency') ?: ''
    ]
]

vars.put('tradePayload', JsonOutput.toJson(trade))

// 业务唯一标识：用于事后在被测系统里定位本次压测产生的数据。
// 注意 payload 目前不接受额外字段（README 待确认 #5），所以这个标识只能留在
// 结果文件里做关联，无法写进 trade 本身 —— 这正是清理策略只能靠
// "专用 PERF Portfolio + 状态 + 时间窗口" 兜底的原因。
// caseId 在 setUp 的 preflight 里不存在（那时还没有 CSV 行），兜成 PREFLIGHT
vars.put('tradeReference',
         "PERF-${vars.get('caseId') ?: 'PREFLIGHT'}-${ctx.getThreadNum()}-${vars.getIteration()}")
