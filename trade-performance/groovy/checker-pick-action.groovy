/*
 * checker-pick-action.groovy
 * 挂载点：journeys/j03-checker-approve.jmx → "pending" Simple Controller 下的 JSR223 PostProcessor
 *
 * 职责：为本次迭代抽签决定 checker 是 approve 还是 reject，写入 vars.checkerAction。
 *
 * ══ 为什么不用两个 If Controller 各自 ${__Random} ══════════════════
 * 直觉写法是：
 *   If reject  : ${__jexl3(${__Random(1,100)} <= 5)}
 *   If approve : ${__jexl3(${__Random(1,100)} >  5)}
 * 但这是**两次独立抽签**。两个条件都为真或都为假的情况会真实发生
 * （约 0.25% 双执行 + 约 4.75% 都不执行），于是：
 *   - 有些迭代一个任务被 approve 又被 reject（第二个必然业务拒绝）
 *   - 有些迭代什么都不做，但仍占用一次迭代和一次 pending 查询
 * 两种偏差都不大，但都会以"低频无规律错误"的形式出现 —— 正是最难定位的那类。
 *
 * 抽一次签、存进变量、两个 If 读同一个值，从结构上互斥。
 * ═══════════════════════════════════════════════════════════════
 *
 * 拒绝率来自 Workload Modeling A8（v0 = 5%）。
 * reject 路径更贵（snapshot 恢复 + 审计写入），所以这个比例直接影响
 * 审批链路的整体成本，是一条必须登记的负载模型假设。
 */

import java.util.concurrent.ThreadLocalRandom

int rejectRate = (props.getProperty('checkerRejectRate') ?: '5') as int
int roll = ThreadLocalRandom.current().nextInt(100) + 1   // 1..100

vars.put('checkerAction', roll <= rejectRate ? 'reject' : 'approve')
