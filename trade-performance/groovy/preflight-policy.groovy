/*
 * preflight-policy.groovy
 * 挂载点：setUp Thread Group → HTTP Request "preflight_create" → JSR223 Assertion
 *
 * 职责：把"参考数据失效"从**压测中期的噪音**变成**开跑前的明确失败**。
 *
 * ── 为什么必须真的建一笔 trade ──
 * refdata 查询返回 200、池非空，都只能证明"数据存在"。
 * 只有真实调用 create 才能证明"数据业务上可用"——
 * counterparty 被第三方停用时，GET /refdata 照样把它查出来，是 create 才会拒。
 * 这正是硬编码 CSV 最常踩的坑，也是这一步存在的全部理由。
 *
 * ── 策略由 preflightPolicy 属性决定（config/*.properties）──
 *   abort  数据不可用则整轮无意义，立刻停 —— 正式基线用
 *   prune  剔除失效条目，池中剩余够就继续 —— 【待实现，见下】
 *   warn   记录后继续，判断留给结果分析阶段 —— dev 环境用
 */

import groovy.json.JsonSlurper

def policy = props.getProperty('preflightPolicy') ?: 'warn'

// 池本身就为空时，任何策略都救不了（这不是"数据失效"，是环境没数据）
def poolErr = props.getProperty('refdataPoolError')
if (poolErr) {
    log.error("PREFLIGHT ABORT — ${poolErr}")
    AssertionResult.setFailure(true)
    AssertionResult.setFailureMessage(poolErr)
    ctx.getEngine().stopTest()
    return
}

// ── 判定数据是否业务可用 ──
boolean dataUsable = false
String  detail     = "HTTP ${prev.getResponseCode()}"

if (prev.isSuccessful() && prev.getResponseCode() == '200') {
    try {
        def r = new JsonSlurper().parseText(prev.getResponseDataAsString())
        dataUsable = (r.code == 200 && r.status == 'PENDING APPROVAL')
        detail = "code=${r.code} status=${r.status} msg=${r.msg}"
    } catch (Exception e) {
        detail = "unparseable response — ${e.message}"
    }
}

if (dataUsable) {
    log.info('PREFLIGHT OK — refdata is business-usable')
    return
}

// ── 数据不可用，按策略处置 ──
def msg = "PREFLIGHT FAILED [${policy}] — ${detail}"
AssertionResult.setFailure(true)
AssertionResult.setFailureMessage(msg)

switch (policy) {

    case 'abort':
        // 数据不可用则整轮无意义。停在这里，避免产出一份"错误率 100%"
        // 却被当成性能结论的报告。
        log.error("${msg} — stopping test")
        props.put('preflightOutcome', 'abort')
        ctx.getEngine().stopTest()
        break

    case 'prune':
        // ─────────────────────────────────────────────────────────────
        // TODO【待实现 —— 需要团队决策，不是纯技术问题】
        //
        // 目标：剔除失效条目，池中剩余量够就继续，并在报告中标注降级。
        //
        // 可用上下文：
        //   props.getProperty('perfPortfolios')      JSON 数组，见 build-refdata-pools.groovy
        //   props.getProperty('perfCounterparties')  JSON 数组 [{fmId, name}, ...]
        //   props.getProperty('preflightMinPoolSize') 剩余量下限（config/*.properties）
        //   vars.get('portfolioId') / vars.get('counterpartyFmId')   本次 preflight 用的那一组
        //   props.put('perfPortfolios', JsonOutput.toJson(剩余列表))  回写池
        //
        // 需要你判断的三件事：
        //
        // 1. 剔哪个？preflight 失败只告诉你"这一组不能用"，但不知道是 portfolio 的问题
        //    还是 counterparty 的问题。两个都剔会误伤；逐一重试代价高。
        //
        // 2. 剩多少算够？preflightMinPoolSize 是个数字，但真正的约束是**用例的对照条件**：
        //    PT-CREATE-014 要比较"集中打 1 个 portfolio" vs "分散到 5 个"。
        //    剔到只剩 3 个时，那个对照实验已经不成立了——继续跑会产出一份
        //    看起来正常、实际前提已变的报告。
        //
        // 3. 怎么让下游知道降级了？至少要 props.put('preflightOutcome', 'pruned:N')
        //    并让 run manifest 记进去，否则事后没人知道这份报告是降级跑出来的。
        //
        // 参考实现骨架：
        //   def portfolios = new JsonSlurper().parseText(props.getProperty('perfPortfolios'))
        //   portfolios.remove(vars.get('portfolioId'))
        //   if (portfolios.size() >= minSize) { props.put(...); props.put('preflightOutcome', "pruned:${...}") }
        //   else { ctx.getEngine().stopTest() }
        // ─────────────────────────────────────────────────────────────
        log.error("${msg} — 'prune' policy NOT IMPLEMENTED, falling back to abort")
        props.put('preflightOutcome', 'prune-unimplemented')
        ctx.getEngine().stopTest()
        break

    case 'warn':
    default:
        // 继续跑，但把状态留给结果分析阶段。
        // 前提是分析环节真的有人看 —— 如果没人看，这个策略等于没做校验。
        log.warn("${msg} — continuing anyway (warn policy)")
        props.put('preflightOutcome', 'warn')
        break
}
