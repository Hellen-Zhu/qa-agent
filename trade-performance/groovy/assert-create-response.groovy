/*
 * assert-create-response.groovy
 * 挂载点：HTTP Request "create_trade" → JSR223 Assertion
 *
 * 职责：业务层断言 + 三类错误分离。
 *
 * ── 为什么不能只用 Response Assertion 判 HTTP 200 ──
 * 这个接口业务失败时**照样返回 HTTP 200**，业务状态在 body 的 code / status 里。
 * 只看状态码的报告会显示"错误率 0%"，而实际一条 trade 都没建成。
 * 这是本项目最容易产出误导性报告的地方。
 *
 * ── 三类错误必须分开统计，因为处置方式完全不同 ──
 *   technical  连接失败/超时/5xx     → 系统扛不住，是性能结论
 *   business   HTTP 200 但业务拒绝    → 多半是测试数据失效，不是性能问题
 *   script     提取器拿不到值/解析异常 → 脚本 bug，结果整体作废
 * 混在一个"错误率"里的报告没法用：12% 错误率到底该找开发还是该修数据？
 */

import groovy.json.JsonSlurper

def resp = prev.getResponseDataAsString()
def code = prev.getResponseCode()

// ── 类别 1：技术失败 ──
if (!prev.isSuccessful() || code != '200') {
    vars.put('errClass', 'technical')
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage("technical: HTTP ${code}")
    return
}

// ── 类别 3：脚本/解析失败 ──
def json
try {
    json = new JsonSlurper().parseText(resp)
} catch (Exception e) {
    vars.put('errClass', 'script')
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage("script: response is not JSON — ${e.message}")
    return
}

// ── 类别 2：业务拒绝 ──
if (json.code != 200 || json.status != 'PENDING APPROVAL') {
    vars.put('errClass', 'business')
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage("business: code=${json.code} status=${json.status} msg=${json.msg}")
    return
}

// ── 成功路径：结构完整性 ──
// tradeId 必须是 TRD-<数字>。校验格式而不只是非空，是因为提取器失败时
// 默认值 "NOT_FOUND" 也是非空字符串，会被"非空"这种弱断言放过去。
def tradeId = json.data?.trade?.id
if (!(tradeId ==~ /^TRD-\d+$/)) {
    vars.put('errClass', 'script')
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage("script: unexpected tradeId format — '${tradeId}'")
    return
}

vars.put('errClass', 'ok')
