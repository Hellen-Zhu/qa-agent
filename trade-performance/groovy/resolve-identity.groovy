/*
 * resolve-identity.groovy
 * 挂载点：主 Thread Group 下的 JSR223 PreProcessor（作用域覆盖该线程组内所有 sampler）
 *
 * 职责：算出本次请求要用的 X-User-Id，写进 effectiveUserId。
 *
 * ── 为什么不在 create 的 PreProcessor 里做 ──
 * E2E journey 里 refdata 的两个查询跑在 create 之前，它们也要带 X-User-Id。
 * 如果身份解析挂在 create 上，那两个查询会用 CSV 原值、create 用覆盖值——
 * 同一次迭代里出现两个身份，等于测了个不存在的场景。
 * 放在 Thread Group 层，作用域覆盖全部 sampler，保证一次迭代内身份一致。
 *
 * ── 本项目没有 login、没有 token ──
 * 权限完全由 X-User-Id 决定。这让工程简单很多（无 setUp 登录、无 token 生命周期、
 * 无 401 重试），但"用哪个用户"仍然是一个负载变量：
 *   userMode=pool   从 accounts.csv 轮换（默认，接近真实）
 *   userMode=fixed  全部线程共用一个 maker
 * 若服务端按 maker 做过滤、计数或加锁，两者压出来的数会显著不同——
 * 这本身就值得作为一个对照用例跑（与 portfolioSelect=fixed 同构）。
 */

def mode = props.getProperty('userMode') ?: 'pool'

if (mode == 'fixed') {
    vars.put('effectiveUserId', props.getProperty('fixedUserId') ?: 'maker@sc.com')
} else {
    // pool 模式：userId 由 CSV Data Set(data/shared/accounts.csv) 提供
    def fromCsv = vars.get('userId')
    if (!fromCsv) {
        log.warn('userMode=pool but userId is not set — accounts.csv missing or misconfigured')
        fromCsv = props.getProperty('fixedUserId') ?: 'maker@sc.com'
    }
    vars.put('effectiveUserId', fromCsv)
}
