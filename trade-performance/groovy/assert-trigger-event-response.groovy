/*
 * assert-trigger-event-response.groovy
 * 挂载点：steps/workers/trade-management/trigger-event.jmx → JSR223 Assertion
 *
 * 职责：生命周期事件提交的业务断言 + 三类错误分离。
 *
 * ── 本接口最需要区分的一种"失败" ──
 * 目标 trade 若已处于 pending approve（被别的事件锁着），提交会被业务拒绝。
 * 这**不是**系统缺陷，而是四眼原则的正确行为 —— 但它会以"错误率 X%"
 * 出现在报告里，把真正的技术问题淹没掉。
 *
 * 所以这里把它单列为 lockedRejection，既不算技术错误，也从业务拒绝里拆出来：
 * 它的正确读法是"并发打同一批 trade 的比例太高"，属于**测试数据分布问题**，
 * 该去调数据池而不是找开发。
 *
 * S-05 同实体争用场景反过来利用这一点：那里 lockedRejection 恰恰是被验证的行为。
 *
 * ⚠ 响应结构假设为 create 同款 {code, status, msg, data}，未经验证。
 */

import groovy.json.JsonSlurper

def pre = vars.get('errClass')
if (pre == 'script') {
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage('script error: missing targetTradeId or eventType')
    return
}

def code = prev.getResponseCode()
if (!prev.isResponseCodeOK() || code.startsWith('5') || code == '000') {
    vars.put('errClass', 'technical')
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage("technical: HTTP ${code}")
    return
}

def json
try {
    json = new JsonSlurper().parseText(prev.getResponseDataAsString())
} catch (Exception e) {
    vars.put('errClass', 'script')
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage("script: response is not JSON — ${e.message}")
    return
}

if (json?.code != 200) {
    def msg = (json?.msg ?: '') as String
    // 被锁拒绝：四眼原则的正确行为，单独打标签
    if (msg =~ /(?i)pending\s*approv|locked|in\s*progress/) {
        vars.put('errClass', 'lockedRejection')
        vars.put('eventFailMsg', msg)
        AssertionResult.setFailure(true)
        AssertionResult.setFailureMessage("lockedRejection: ${msg}")
        return
    }
    vars.put('errClass', 'business')
    vars.put('eventFailMsg', msg)
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage("business: code=${json?.code} msg=${msg}")
    return
}

vars.put('errClass', 'ok')
