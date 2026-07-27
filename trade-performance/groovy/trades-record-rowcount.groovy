/*
 * trades-record-rowcount.groovy
 * 挂载点：steps/workers/trade-management/trades-list.jmx → JSR223 PostProcessor
 *
 * 职责：把本次返回的行数写进 tradesRowCount，供结果分析按行数切分。
 *
 * ── 为什么这不是可选的 ──
 * KPI Definitions §5.8 要求"列表接口必须标注数据量与返回行数"，理由是
 * **不标行数的列表延迟数字无法解读**：P95=1.2s 在返回 50 行和 500 行时
 * 含义完全不同，也无法用来判断回归。
 *
 * 它还是两个场景的关键自变量：
 *   S-09 扇出审计   下游调用数 ÷ 返回行数 → 判断 O(1) 还是 O(n)
 *   S-10 数据量伸缩 固定行数下比较不同数据量档位的 P95
 *
 * 与查询串一起进 jtl，才能事后确认"我以为取了 200 行，服务端其实给了 20 行"
 * 这类静默偏差 —— 分页参数名猜错时正是这个表现。
 */

import groovy.json.JsonSlurper

int n = -1
try {
    def data = new JsonSlurper().parseText(prev.getResponseDataAsString())?.data
    if (data instanceof List)      n = data.size()
    else if (data?.content != null) n = (data.content as List).size()   // Spring Page 形态
    else if (data?.items != null)   n = (data.items as List).size()
} catch (Exception e) {
    log.warn("GET /trades response is not JSON — ${e.message}")
}

vars.put('tradesRowCount', n as String)

// 行数与请求的 size 不符时留一条线索。不判失败：可能只是库里就这么多数据。
def wanted = props.getProperty('blotterPageSize') ?: '200'
if (n >= 0 && !vars.get('tradesSearch') && n != (wanted as int)) {
    log.info("GET /trades 返回 ${n} 行，请求 size=${wanted} —— " +
             "若差距很大，确认分页参数名是否正确（见 build-trades-query.groovy）")
}
