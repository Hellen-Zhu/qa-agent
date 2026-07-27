/*
 * checker-claim-task.groovy
 * 挂载点：checker-flow/{approve,reject}-task.jmx → JSR223 PreProcessor
 * 参数（JSR223 Parameters 字段）：approve | reject
 *
 * 职责：从 claim-once 池领取 **1 个** taskId，并构造单笔请求体。
 *
 * ⚠⚠ 请求体形状是推断值 ⚠⚠
 *    本工程只有 create 的真实 curl。approve/reject 的 body 目前假设为：
 *      approve  {"comment": "..."}        —— 也可能是空体
 *      reject   {"reason": "..."}         —— reason 必填有业务依据（NFR AUDIT-04）
 *    真实契约确认后**只改本文件**，两个 fragment 都自动生效。
 */

import groovy.json.JsonOutput

def action = (Parameters ?: 'approve').trim()

// ⚠ 必须 props.get()，不能 props.getProperty() —— 后者对非 String 值返回 null
def pool = props.get('checkerTaskPool')

if (pool == null) {
    // 池根本没建起来（setUp 没跑 / 跑失败）。这是脚本级错误，不是被测系统的问题。
    vars.put('claimedTaskId', 'POOL_MISSING')
    vars.put('errClass', 'script')
    log.error('checkerTaskPool 不存在 —— setUp 是否执行了 checker-task-pool.jmx？')
    return
}

def id = pool.poll()   // 原子领取：同一个 taskId 不会被两个线程拿到

if (id == null) {
    // 池被领空。继续发请求只会带着一个假 taskId 打过去，制造一批 404/业务拒绝，
    // 把真实的性能数据污染掉。在这里标成脚本错误，让本轮结果按规则作废。
    vars.put('claimedTaskId', 'POOL_EXHAUSTED')
    vars.put('errClass', 'script')
    log.error('checker task pool 已领空 —— 待办任务被消费完了。' +
              '延长 setUp 造数、增大 checkerMinPoolSize，或缩短本轮时长。')
    return
}

vars.put('claimedTaskId', id)
vars.put('claimedCount', '1')

if (action == 'reject') {
    def reason = props.getProperty('checkerRejectReason') ?: 'PERF TEST rejection'
    vars.put('checkerPayload', JsonOutput.toJson([ reason: reason ]))
} else {
    vars.put('checkerPayload', JsonOutput.toJson([ comment: 'PERF TEST approval' ]))
}
