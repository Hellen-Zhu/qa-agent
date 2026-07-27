/*
 * checker-claim-batch.groovy
 * 挂载点：checker-flow/bulk-{approve,reject}.jmx → JSR223 PreProcessor
 * 参数（JSR223 Parameters 字段）：approve | reject
 *
 * 职责：从 claim-once 池领取 **N 个** taskId（N = checkerBatchSize），构造批量请求体。
 *
 * ══ claimedCount 才是单位工作量耗时的分母 ═══════════════════════
 * 池不足时实际领到的数量会小于 checkerBatchSize。若用 checkerBatchSize 当分母，
 * 批次末尾那几次"只领到 3 笔却按 20 笔算"的请求会把单位耗时算低，
 * 而且是**系统性偏低**——正好发生在池快空、系统压力最大的时候。
 * 所以把真实数量写进 claimedCount，进 jtl 供分析用（NFR PERF-16）。
 * ═══════════════════════════════════════════════════════════════
 *
 * ⚠⚠ 请求体形状是推断值 ⚠⚠
 *    假设 {"taskIds": [...]}，reject 额外带 "reason"。
 *    真实契约确认后**只改本文件**，两个 bulk fragment 都自动生效。
 */

import groovy.json.JsonOutput

def action = (Parameters ?: 'approve').trim()
int want = (props.getProperty('checkerBatchSize') ?: '20') as int

// ⚠ 必须 props.get()，不能 props.getProperty()
def pool = props.get('checkerTaskPool')

if (pool == null) {
    vars.put('claimedCount', '0')
    vars.put('checkerBulkPayload', '{}')
    vars.put('errClass', 'script')
    log.error('checkerTaskPool 不存在 —— setUp 是否执行了 checker-task-pool.jmx？')
    return
}

def ids = []
want.times {
    def id = pool.poll()      // 原子领取，逐个取满 N 个
    if (id != null) ids << id
}

vars.put('claimedCount', ids.size() as String)

if (ids.isEmpty()) {
    vars.put('checkerBulkPayload', '{}')
    vars.put('errClass', 'script')
    log.error("checker task pool 已领空（请求 ${want} 笔，取到 0 笔）—— " +
              '待办任务被消费完了。延长 setUp 造数或缩短本轮时长。')
    return
}

if (ids.size() < want) {
    // 不是错误，但必须记下来：这批的分母比其他批小，混在一起看单位耗时会失真。
    log.warn("batch 不足：请求 ${want} 笔，实际取到 ${ids.size()} 笔（池将空）")
}

def body = [ taskIds: ids ]
if (action == 'reject') {
    body.reason = props.getProperty('checkerRejectReason') ?: 'PERF TEST rejection'
}
vars.put('checkerBulkPayload', JsonOutput.toJson(body))
