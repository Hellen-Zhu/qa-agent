/*
 * alias-target-trade-id.groovy
 * 挂载点：journeys/j02-blotter-browse.jmx → view-trade-details 之前的 JSR223 PreProcessor
 *
 * 职责：把 targetTradeId 复制给 tradeId。
 *
 * ── 为什么需要这么一个小脚本 ──
 * 两个 fragment 契约里的变量名不同，这是历史演进造成的：
 *   view-trade-details（create 链路）  读 tradeId       —— 由 create 的提取器产出
 *   trades-pick-one（blotter 链路）    产出 targetTradeId —— 与 trigger-event 契约一致
 *
 * 有三种解法：
 *   ① 改 view-trade-details 读 targetTradeId  → 会破坏 j01（create 产出的是 tradeId）
 *   ② 让 trades-pick-one 写 tradeId          → 会与 trigger-event 的契约冲突
 *   ③ 在调用方做一次别名                      → 两个 fragment 的契约都不动
 *
 * 选 ③，因为**契约变更的代价随引用方数量增长**，而别名只影响本 journey 一处。
 * 这是"调用方吸收差异"原则的又一个应用，与 refdata 的 pick/pool 是同一个思路。
 *
 * ⚠ 若将来变量命名统一（比如全部改叫 tradeId），本文件应当删掉，
 *   而不是留着当兼容层 —— 兼容层活得越久，越没人记得为什么存在。
 */

def target = vars.get('targetTradeId')
vars.put('tradeId', (target && target != 'NOT_FOUND') ? target : 'NOT_FOUND')
