/*
 * refdata-pick-portfolio.groovy
 * 挂载点：_composites/refdata-load.jmx → "portfolios" Simple Controller 下的 JSR223 PostProcessor
 *
 * 职责：从 portfolios 响应里**随机挑一条**当作本次迭代的入参。
 *
 * ── 为什么提取逻辑在调用方而不在原子 fragment 里 ──
 * 同一个 GET /refdata/portfolios 有两种用法：
 *   本文件（journey）  随机挑一条 → vars.portfolioId
 *   pool 版（setUp）   取全部建池 → props.perfPortfolios
 * 把提取器塞进原子 fragment 就必须为第二种用法再复制一份 fragment，
 * 接口契约立刻变成两份。所以原子只管请求，提取由调用方挂。
 *
 * ⚠ 作用域：本 PostProcessor 必须包在 Simple Controller 里，与 Include 同级。
 *   直接挂在 Transaction Controller 下会作用到该 TX 内**全部** sampler，
 *   于是它也会去解析 counterparties 的响应 —— 拿不到 id，静默写入 NOT_FOUND。
 *
 * ⚠ JSONPath 假设 $.data[*].id，未经真实响应验证（见 README「第一次跑之前」#1）。
 */

import groovy.json.JsonSlurper
import java.util.concurrent.ThreadLocalRandom

def list
try {
    list = new JsonSlurper().parseText(prev.getResponseDataAsString())?.data
} catch (Exception e) {
    log.error("refdata/portfolios response is not JSON — ${e.message}")
    vars.put('portfolioId', 'NOT_FOUND')
    vars.put('refdataBound', 'false')
    return
}

if (!list) {
    log.error('refdata/portfolios returned no rows')
    vars.put('portfolioId', 'NOT_FOUND')
    vars.put('refdataBound', 'false')
    return
}

// 随机而非 threadNum 取模：E2E 场景要的是真实分布，不是可复现的对照实验
// （后者是单接口测试的目标，由 select-refdata.groovy 的 roundRobin 承担）。
def p = list[ThreadLocalRandom.current().nextInt(list.size())]
vars.put('portfolioId', (p.id ?: 'NOT_FOUND') as String)
