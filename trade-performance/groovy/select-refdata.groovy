/*
 * select-refdata.groovy
 * 挂载点：主 Thread Group → HTTP Request "create_trade" 的 JSR223 PreProcessor（第 1 个）
 *
 * 职责：每次迭代从全局池里挑一组 portfolio / counterparty / userId，写进本线程的 vars。
 *
 * 选取策略全部走 property，不写死 —— 这样同一份脚本能服务两类相反的用例：
 *   portfolioSelect=roundRobin  分散（默认，常规容量测试）
 *   portfolioSelect=fixed       集中（PT-CREATE-014 同 portfolio 竞争）
 *   userMode=pool               分散 maker（默认）
 *   userMode=fixed              集中同一 maker（测 per-user 锁 / 计数器竞争）
 */

import groovy.json.JsonSlurper

// ── 上游已绑定则跳过 ──
// E2E 场景里 refdata 查询是**被测链路的一部分**（真实前端确实要拉下拉框数据），
// steps/refdata-load.jmx 会现场提取并设好这三个变量，同时置 refdataBound=true。
// 单接口容量测试没有这一步，才从全局池里挑。
// 一个 fragment 服务两类相反的用例，靠的就是这个开关 —— 没有参数化的 fragment 复用不了。
if (vars.get('refdataBound') == 'true') {
    return
}

// ── 池可用性检查 ──
// 走到这里说明 preflight 用的是 warn/prune 策略放行了，但池可能仍是空的。
// 直接 return 会让后面的 payload 构建拿到 null，请求带着 "null" 字面量发出去——
// 那是最难排查的一类失败（HTTP 200，业务拒绝，日志里看不出所以然）。
// 所以这里必须显式中止本次迭代。
def rawP = props.getProperty('perfPortfolios')
def rawC = props.getProperty('perfCounterparties')
if (!rawP || !rawC) {
    log.error('refdata pool missing — setUp did not run or failed. Aborting iteration.')
    ctx.getThread().stop()
    return
}

def portfolios = new JsonSlurper().parseText(rawP)
def cps        = new JsonSlurper().parseText(rawC)
if (portfolios.isEmpty() || cps.isEmpty()) {
    log.error('refdata pool empty. Aborting iteration.')
    ctx.getThread().stop()
    return
}

// ── 选取 ──
// 用 threadNum 而非随机数：可复现。同一份 profile 跑两次，线程 N 拿到的永远是同一个
// portfolio，两次结果可直接对比。随机数会让"这次慢是因为数据不同还是系统不同"无法回答。
int tn = ctx.getThreadNum()

int pIdx = (props.getProperty('portfolioSelect') == 'fixed') ? 0 : (tn % portfolios.size())
def cp   = cps[tn % cps.size()]

vars.put('portfolioId',      portfolios[pIdx] as String)
vars.put('counterpartyFmId', cp.fmId as String)
vars.put('counterpartyName', cp.name as String)

// 身份（X-User-Id）不在这里处理 —— 见 groovy/resolve-identity.groovy。
// 它必须挂在 Thread Group 层，否则 E2E 里 refdata 查询和 create 会用不同身份。
