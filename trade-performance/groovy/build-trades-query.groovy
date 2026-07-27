/*
 * build-trades-query.groovy
 * 挂载点：steps/workers/trade-management/trades-list.jmx → JSR223 PreProcessor
 *
 * 职责：构造 GET /trades 的查询串，产出 tradesQuery。
 *
 * ── 为什么查询串要在这里拼，而不是在 path 里写死 ──
 * 校验规则 R2 剥掉 query string 后查重，所以 blotter 列表与 search 定位
 * **必须**共用一份 fragment（它们是同一个端点、同一份契约）。
 * 差异只能由变量表达：
 *   tradesSearch 有值  → search 定位（create 之后确认这笔能查到）
 *   tradesSearch 无值  → blotter 列表（按 blotterPageSize 取整页）
 *
 * ⚠ 参数名为推断值：假设 size / page / search。真实参数名确认后只改本文件。
 *   猜错的表现：服务端忽略未知参数、返回默认页 —— 这是**会静默错**的一类，
 *   所以首次 smoke 必须人工核对返回行数是否等于 blotterPageSize。
 */

import java.net.URLEncoder

def parts = []

def search = vars.get('tradesSearch')
if (search && search.trim() && !search.startsWith('${')) {
    // 定位模式：按业务引用查一笔
    parts << "search=" + URLEncoder.encode(search.trim(), 'UTF-8')
} else {
    // blotter 模式：取整页。size 同时是 S-09 扇出审计与 S-10 数据量伸缩的扫描维度。
    parts << "size=" + (props.getProperty('blotterPageSize') ?: '200')
    parts << "page=" + (vars.get('blotterPage') ?: '0')
}

def status = props.getProperty('blotterStatusFilter')
if (status) parts << "status=" + URLEncoder.encode(status, 'UTF-8')

vars.put('tradesQuery', parts.join('&'))
