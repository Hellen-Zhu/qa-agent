/*
 * resolve-dat-file.groovy
 * 挂载点：steps/workers/trade-management/create-trade.jmx → JSR223 PreProcessor（最先执行）
 *
 * 职责：决定本次请求上传哪个 .dat，产出 effectiveDatFile。
 *
 * ── 为什么需要它 ──
 * create 这个 fragment 有多个调用方，datFile 的来源不保证一致。
 * 早期版本靠"在 preflight 里复制一份 sampler、把 File.path 写成属性"来解决，
 * 代价是 create 的契约存在两份。现在把差异收敛到这一个变量上，
 * sampler 只有一份，所有调用方共用。
 *
 * ── 当前实际走哪条分支（2026-07 核对）──
 * p02 / s01 的 CSV Data Set 都挂在 **TestPlan 层级**，而计划级配置元件对
 * **所有**线程组生效，包括 setUp —— 所以 setUp 线程同样拿得到 vars.datFile，
 * 走的是 CSV 分支，preflightDatFile 回退分支目前不会触发。
 *
 * 这是好事，别"优化"掉：preflight 用的 .dat 与主循环完全相同，
 * 它证明的就是主循环将要用的那个文件可用。用一个固定的 preflight 文件反而更弱。
 *
 * ⚠ 由此带来一个真实副作用：CSV Data Set 是 shareMode.all（全局游标），
 *   **setUp 会消耗掉第一行**，主循环线程 0 拿到的是第二行。
 *   行数少时这会打乱"哪个线程用哪组数据"的预期，排查时记得算上这一行偏移。
 *
 * 回退分支保留的理由：将来若有调用方把 CSV 挂在线程组级（而非计划级），
 * setUp 就真的没有 datFile 了。这时靠 -JpreflightDatFile=... 即可，无需改脚本。
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
    // 走到这里说明 CSV 没生效。两种可能，日志要能区分：
    //   1. 调用方本来就没挂 CSV（预期内的回退）
    //   2. CSV 挂了但路径写错 / 列名对不上 —— 这时 fromCsv 是 '${datFile}' 字面量
    // 第 2 种是脚本 bug，不该被静默兜住，所以升级成 warn。
    vars.put('effectiveDatFile', fromProp)
    if (fromCsv && fromCsv.startsWith('${')) {
        log.warn("datFile 未被解析（拿到字面量 '${fromCsv}'）—— " +
                 "检查 createDataFile 路径与 CSV Data Set 的 variableNames。" +
                 "本次回退到 ${fromProp}")
    } else {
        log.info("no datFile from CSV, using preflightDatFile=${fromProp}")
    }
}
