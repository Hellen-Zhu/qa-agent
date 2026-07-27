/*
 * checker-task-pool-init.groovy
 * 挂载点：setup/checker-task-pool.jmx → "pending" Simple Controller 下的 JSR223 PostProcessor
 *
 * 职责：把 GET /checker/tasks/pending 的响应灌进一个**claim-once 队列**，
 *       供主线程组的 approve / reject / bulk-* 领取。
 *
 * ══ 为什么必须是 claim-once，而不是"随机挑一条" ══════════════════
 * checker task 只能被处理一次。若两个线程挑到同一个 taskId：
 *   第一个成功，第二个收到"该任务已处理"的**业务拒绝**。
 * 在报告里这表现为"错误率 X%，无规律"——它随并发数和运气变化，
 * 是最难定位的一类脚本 bug（看起来像被测系统的并发问题，其实是脚本自己造的）。
 *
 * ConcurrentLinkedQueue.poll() 是原子操作，从结构上保证每个 taskId 只被领走一次。
 * 这与 refdata 池的"随机挑"是相反的设计，因为语义不同：
 *   refdata  可重复使用（一个 portfolio 可以被很多笔 trade 引用）
 *   task     一次性消费（approve 掉就没了）
 * ═══════════════════════════════════════════════════════════════
 *
 * ⚠ props 是 java.util.Properties。存对象必须用 props.put()/props.get()，
 *   **不能用 props.getProperty()** —— 后者只返回 String，对非 String 值返回 null。
 *   这是一个会静默失败的坑：队列存进去了，读出来是 null，然后每次 claim 都"池已空"。
 *
 * ⚠ 分布式压测：props 不跨 slave 传播，每个节点会各自建自己的池。
 *   由于池来自各节点各自的 pending 查询，**不同节点会拿到重叠的 taskId**，
 *   跨节点撞车无法用本机制避免。多节点跑 checker 场景前需要按节点分片
 *   （例如给每个 slave 分配不同的 checker 身份，服务端按身份过滤待办）。
 */

import groovy.json.JsonSlurper
import java.util.concurrent.ConcurrentLinkedQueue

def ids = []
try {
    def data = new JsonSlurper().parseText(prev.getResponseDataAsString())?.data
    // ⚠ JSONPath 假设 $.data[*].taskId，未经真实响应验证。
    //   若字段名不同（如 id / checkerTaskId），只改这一行。
    ids = (data ?: []).collect { (it.taskId ?: it.id) as String }
                      .findAll { it && it != 'null' }
} catch (Exception e) {
    log.error("checker/tasks/pending response is not JSON — ${e.message}")
}

def q = new ConcurrentLinkedQueue<String>(ids)
props.put('checkerTaskPool', q)

int minSize = (props.getProperty('checkerMinPoolSize') ?: '1') as int
if (ids.size() < minSize) {
    // 与 refdata 池同样的处理：池太小不是"数据失效"，是环境根本没有待办任务，
    // 继续跑只会得到一批"池已空"的脚本错误。在这里就说清楚。
    def msg = "CHECKER TASK POOL TOO SMALL: ${ids.size()} tasks, required>=${minSize} — " +
              "环境里没有足够的待审批任务。先用 maker 链路造一批，或放宽 checkerMinPoolSize。"
    log.error(msg)
    props.put('checkerPoolError', msg)
} else {
    props.remove('checkerPoolError')
}

log.info("checker task pool initialised: ${ids.size()} tasks")
