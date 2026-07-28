/*
 * resolve-dat-file.groovy
 * 挂载点：steps/workers/trade-management/create-trade.jmx → JSR223 PreProcessor（最先执行）
 *
 * 职责：决定本次请求上传哪个 .dat，产出 effectiveDatFile。
 *
 * ── 为什么需要它 ──
 * create 这个 fragment 有两个调用方，而它们的 datFile 来源不同：
 *   主链路 / 单接口   CSV Data Set 提供 vars.datFile
 *   setUp 前置校验    没有 CSV（setUp Thread Group 不挂 CSV Data Set），
 *                     只能用属性 preflightDatFile
 *
 * 早期版本靠"在 preflight 里复制一份 sampler、把 File.path 写成属性"来解决，
 * 代价是 create 的契约存在两份。现在把差异收敛到这一个变量上，
 * sampler 只有一份，两个调用方共用。
 *
 * ⚠ 不要把这个判断写进 File.path 的 ${} 表达式里：
 *   JMeter 函数嵌套在文件路径上求值时机不确定，且出错时是"文件不存在"这种
 *   与真实缺文件无法区分的报错。放在 PreProcessor 里可以显式 log。
 */

def fromCsv = vars.get('datFile')
def fromProp = props.getProperty('preflightDatFile') ?: 'products/FX_TRF/fx_trf_01.dat'

if (fromCsv && fromCsv.trim() && !fromCsv.startsWith('${')) {
    vars.put('effectiveDatFile', fromCsv.trim())
} else {
    // 没有 CSV → 走 preflight 路径
    vars.put('effectiveDatFile', fromProp)
    log.info("no datFile from CSV, using preflightDatFile=${fromProp}")
}
