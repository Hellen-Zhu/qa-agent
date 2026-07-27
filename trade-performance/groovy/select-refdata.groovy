/*
 * select-refdata.groovy
 * 挂载点：主 Thread Group → HTTP Request "create_trade" 的 JSR223 PreProcessor（第 1 个）
 *
 * 职责：确保本次迭代的 portfolio / counterparty 已就位，写进本线程的 vars。
 *
 * ── 三个来源，一个出口 ──
 * 下游（build-trade-payload）只认 vars.portfolioId 等三个变量，不关心它们从哪来。
 * 本脚本就是那个收敛点：
 *   refdataBound=true      E2E 已现场查好（_composites/refdata-load.jmx）→ 什么都不做
 *   refdataSource=csv      CSV Data Set 已供数（p02）                    → 只校验
 *   否则（pool，默认）      从 setUp 建的全局池里挑                        → 挑一组
 * 加一种来源只加一个分支，create-trade.jmx 一行都不用改 —— 这是把"选数"
 * 独立成一个 PreProcessor 而不是写进 build-trade-payload 的理由。
 *
 * 选取策略全部走 property，不写死 —— 这样同一份脚本能服务两类相反的用例：
 *   portfolioSelect=roundRobin  分散（默认，常规容量测试）
 *   portfolioSelect=fixed       集中（PT-CREATE-014 同 portfolio 竞争）
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

// ── 静态模式：CSV Data Set 已经供好数，本脚本只做校验，不覆盖 ──
// refdataSource 用**计划级 UDV**（vars）而非全局属性：同一次跑批里 E2E 计划与
// 单接口计划可能并存，用全局属性会互相污染。属性形式保留为命令行临时覆盖手段。
//
// 这里必须显式判空。CSV Data Set 的文件路径写错时 JMeter 不报错，
// vars 会保留 ${portfolioId} 字面量，请求照发，服务端返回业务拒绝 ——
// 那是压测里最难定位的一类失败（HTTP 200，错误率高，日志看不出所以然）。
def source = vars.get('refdataSource') ?: props.getProperty('refdataSource') ?: 'pool'
if (source == 'csv') {
    def bad = ['portfolioId', 'counterpartyFmId', 'counterpartyName'].findAll {
        def v = vars.get(it)
        !v || !v.trim() || v.startsWith('${')
    }
    if (bad) {
        log.error("refdataSource=csv 但 ${bad.join(',')} 未取到 —— " +
                  "检查 refdataFile 路径与 CSV Data Set 的 variableNames。Aborting iteration.")
        vars.put('errClass', 'script')
        ctx.getThread().stop()
    }
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

// 身份（X-User-Id）不在这里处理 —— 它是线程组级 UDV effectiveUserId，
// 与 runPhase 在同一个 Arguments 元件里声明。
// 必须在 Thread Group 层而不是 sampler 层：E2E 里 refdata 查询跑在 create 之前，
// 挂在 create 上会让同一次迭代出现两个身份，等于测了个不存在的场景。
