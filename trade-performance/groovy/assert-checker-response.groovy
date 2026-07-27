/*
 * assert-checker-response.groovy
 * 挂载点：checker-flow/{approve,reject}-task.jmx → JSR223 Assertion
 *
 * 职责：单笔审批的业务层断言 + 三类错误分离（见 KPI Definitions §1.3）。
 *
 * ── 为什么 HTTP 断言不够 ──
 * 与 create 一样，审批接口业务失败时很可能照样返回 HTTP 200：
 *   任务已被处理 / 无权限 / trade 状态已变更 / 四眼校验不通过（maker == checker）
 * 只看状态码的报告会把这些算成成功。
 *
 * ⚠ 响应结构假设为 create 同款 {code, status, msg, data}，未经验证。
 */

import groovy.json.JsonSlurper

// 上游 PreProcessor 已判定为脚本错误（池空 / 池缺失）时，不再覆盖它的结论
def pre = vars.get('errClass')
if (pre == 'script') {
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage('script error: ' + vars.get('claimedTaskId'))
    return
}

def code = prev.getResponseCode()

// 技术错误：连接失败 / 5xx / 超时。这些计入 SLA。
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
    // 返回了 200 但不是 JSON —— 脚本或契约理解出了问题，本轮不可信
    vars.put('errClass', 'script')
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage("script: response is not JSON — ${e.message}")
    return
}

// 业务拒绝：HTTP 200 但业务状态为拒绝。不计入 SLA，但异常波动必须排查。
// 本接口最值得关注的一种业务拒绝是"任务已被处理"——若它频繁出现，
// 说明 claim-once 池出了问题（多个线程拿到同一个 task），是脚本 bug 不是系统问题。
if (json?.code != 200) {
    vars.put('errClass', 'business')
    vars.put('checkerFailMsg', (json?.msg ?: '') as String)
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage("business: code=${json?.code} msg=${json?.msg}")
    return
}

vars.put('errClass', 'ok')
