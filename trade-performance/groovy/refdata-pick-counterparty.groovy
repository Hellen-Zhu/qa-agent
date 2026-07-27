/*
 * refdata-pick-counterparty.groovy
 * 挂载点：_composites/refdata-load.jmx → "counterparties" Simple Controller 下的 JSR223 PostProcessor
 * （原 pick-counterparty.groovy，随四层重构改名以与 refdata-pool-* 配套）
 *
 * 职责：从 counterparty 列表里随机挑一条，**成对**取出 fmId 和 name。
 *
 * ── 为什么不用两个 JSON Extractor ──
 * 两个提取器各自设 Match No.=0（随机）会各自独立随机，
 * 拼出 A 的 fmId 配 B 的 name。服务端若校验两者一致性，就会业务拒绝——
 * 而且是**偶发**的（随机撞对时就通过），在压测里表现为"错误率 3%，无规律"，
 * 是最难定位的一类脚本 bug。
 *
 * 提取器之间没有"同一条记录"这个概念，配对只能在代码里做。
 *
 * ⚠ 作用域：必须包在 Simple Controller 里与 Include 同级，理由见 refdata-pick-portfolio.groovy。
 */

import groovy.json.JsonSlurper
import java.util.concurrent.ThreadLocalRandom

def list
try {
    list = new JsonSlurper().parseText(prev.getResponseDataAsString())?.data
} catch (Exception e) {
    log.error("refdata/counterparties response is not JSON — ${e.message}")
    vars.put('refdataBound', 'false')
    return
}

if (!list) {
    log.error('refdata/counterparties returned no rows')
    vars.put('counterpartyFmId', 'NOT_FOUND')
    vars.put('counterpartyName', 'NOT_FOUND')
    vars.put('refdataBound', 'false')
    return
}

def cp = list[ThreadLocalRandom.current().nextInt(list.size())]
vars.put('counterpartyFmId', cp.fmId as String)
vars.put('counterpartyName', (cp.name ?: '') as String)

// 告诉下游的 create fragment：数据已由本步骤现场绑定，不要再从全局池挑。
// portfolioId 由同 TX 内先执行的 refdata-pick-portfolio.groovy 设置。
vars.put('refdataBound', vars.get('portfolioId') && vars.get('portfolioId') != 'NOT_FOUND'
                         ? 'true' : 'false')
