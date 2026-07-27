/*
 * assert-checker-bulk-response.groovy
 * 挂载点：checker-flow/bulk-{approve,reject}.jmx → JSR223 Assertion
 *
 * 职责：批量审批的业务层断言 + 三类错误分离 + **部分失败检测**。
 *
 * ══ 部分失败是批量接口特有的陷阱 ═════════════════════════════════
 * 批量接口很可能返回 HTTP 200 + code 200，同时在 data 里报告
 * "20 笔提交，18 笔成功，2 笔失败"。
 *
 * 只断言顶层状态的脚本会把这次算作**完全成功**，于是：
 *   - 有效 TPS 被高估（按 20 笔算，实际只完成 18 笔）
 *   - 单位工作量耗时被低估（分母用了 20）
 *   - 失败的那 2 笔悄无声息，直到有人去数数据库才发现
 *
 * 所以这里必须把 successCount 拆出来，并在与 claimedCount 不符时判失败。
 * 这是"HTTP 200 不等于业务成功"在批量场景下的加强版。
 * ═══════════════════════════════════════════════════════════════
 *
 * ⚠ 响应结构假设：{code, status, msg, data:{successCount, failedCount, failures:[...]}}
 *   未经验证。真实结构确认后改本文件的字段名即可。
 *   若服务端**不返回**逐项结果，把这一点提给开发——没有它，
 *   批量接口的有效 TPS 在原理上就无法准确统计（见 README 待确认事项）。
 */

import groovy.json.JsonSlurper

def pre = vars.get('errClass')
if (pre == 'script') {
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage('script error: task pool empty or missing')
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
    vars.put('errClass', 'business')
    vars.put('checkerFailMsg', (json?.msg ?: '') as String)
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage("business: code=${json?.code} msg=${json?.msg}")
    return
}

// ── 部分失败检测 ──
int claimed = (vars.get('claimedCount') ?: '0') as int
def succ = json?.data?.successCount

if (succ == null) {
    // 服务端没给逐项结果 —— 无法判断部分失败。不判失败（避免误报），
    // 但打标签，让报告里能看出"这批的有效笔数其实是未知的"。
    vars.put('bulkOutcome', 'unverifiable')
    vars.put('errClass', 'ok')
    return
}

int successCount = succ as int
vars.put('bulkSuccessCount', successCount as String)

if (successCount != claimed) {
    vars.put('errClass', 'business')
    vars.put('bulkOutcome', 'partial')
    vars.put('checkerFailMsg', "partial: ${successCount}/${claimed} succeeded")
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage(
        "partial failure: claimed=${claimed} success=${successCount} " +
        "failures=${json?.data?.failures}")
    return
}

vars.put('bulkOutcome', 'full')
vars.put('errClass', 'ok')
