/*
 * validate-csv-refdata.groovy
 * 挂载点：setup/csv-refdata-preflight.jmx → JSR223 Sampler（preflight create 之前）
 *
 * 职责：静态 refdata 模式下的第一道守卫 —— 确认 CSV 里的值是**真值**而非占位符。
 *
 * ── 为什么静态化之后必须多这一道 ──
 * 动态模式里"数据不存在"会在 setUp 查 refdata 时当场暴露（池为空 → refdataPoolError）。
 * 静态模式没有那次查询，占位值会一路畅通地发到服务端，
 * 表现为**每一笔都业务失败**——报告里是"错误率 100%"，不是"启动失败"。
 * 两者的排查成本差一个数量级。
 *
 * ⚠ 与 preflight create 的分工（别合并）：
 *   本文件      查"CSV 填了没" —— 纯本地检查，不发请求，失败即停
 *   preflight   查"填的值今天还能用" —— 必须真发一笔 create 才能知道
 *   前者防script 错误，后者防数据失效。前者过不了，后者跑了也没意义。
 */

def REQUIRED = ['portfolioId', 'counterpartyFmId', 'counterpartyName']

// 占位符白名单。大小写不敏感 —— 手填时 tbc/Tbc 都出现过。
def PLACEHOLDER = ~/(?i)^\s*(tbc|todo|xxx+|n\/a|待定|placeholder)\s*$/

def missing = []
def placeholder = []

REQUIRED.each { name ->
    def v = vars.get(name)
    if (!v || !v.trim() || v.startsWith('${')) {
        // startsWith('${') 说明 CSV Data Set 根本没生效（文件路径错 / 列名对不上）。
        // JMeter 对解析不掉的 ${var} 不报错，直接把字面量当值用 —— 必须自己抓。
        missing << name
    } else if (v ==~ PLACEHOLDER) {
        placeholder << "${name}=${v.trim()}"
    }
}

if (!missing && !placeholder) {
    SampleResult.setResponseMessage(
        "csv refdata ok — pairId=${vars.get('pairId')} portfolio=${vars.get('portfolioId')}")
    log.info("CSV REFDATA OK — pairId=${vars.get('pairId')}")
    return
}

// ── 失败 ──
def reason = []
if (missing)     reason << "字段未取到:${missing.join(',')}(检查 refdataFile 路径与 variableNames 列名)"
if (placeholder) reason << "仍是占位值:${placeholder.join(',')}(见 data/refdata/README.md 怎么填)"
def msg = "PREFLIGHT FAILED — csv refdata 不可用：${reason.join(' | ')}"

log.error(msg)
SampleResult.setSuccessful(false)
SampleResult.setResponseCode('CSV_REFDATA_INVALID')
SampleResult.setResponseMessage(msg)

// 写进这个属性是为了与动态模式共用同一条上报通道（preflight-policy.groovy 读它）。
props.put('refdataPoolError', "csv=${reason.join(' | ')}")

// 这里直接停，不走 preflightPolicy 的 warn/abort 分支 —— 因为无可挽救：
// 占位值会让**每一笔**请求业务失败，跑完只会得到一份错误率 100% 的报告。
// 动态模式的 warn 策略有意义（部分数据失效仍可测），这里没有"部分"可言。
ctx.getEngine().stopTest()
