/*
 * setup/preflight.js —— 开跑前守卫
 *
 * 【对应】jmx/fragments/setup/csv-refdata-preflight.jmx
 *        + groovy/validate-csv-refdata.groovy
 *        + groovy/preflight-policy.groovy
 *
 * 在 k6 里跑在 setup()：**整个测试开始前执行一次**，返回值传给每个 VU。
 * 与 JMeter 的 setUp Thread Group 语义一致，但少了一层麻烦：
 *   JMeter 的 setUp 与主线程组是**不同的线程**，vars 传不过去，
 *   所有交接只能走全局 props。k6 的 setup() 返回值由运行时序列化后
 *   拷贝给每个 VU —— 没有跨线程共享这个问题类别。
 *
 * ══ 为什么静态 refdata 模式下这一步不能省 ═══════════════════
 * 动态模式下失效数据在 setUp 查 refdata 时**当场暴露**。
 * 静态模式没有那次查询 —— CSV 里的 id 若已失效（counterparty 被第三方停用、
 * portfolio 被归档），请求照发，服务端返回业务拒绝。
 * 报告里表现为"错误率升高"而不是"启动失败"，会被误读成性能问题。
 *
 * 所以这不是可选的加固，是静态模式**唯一**的数据有效性证明。
 * 一行 CSV 证明不了任何事，只有真发一笔 create 才行。
 * ═══════════════════════════════════════════════════════════
 *
 * ── 两道检查的分工（别合并）──
 *   1. 本地检查   CSV **填了没**            不发请求，失败即停
 *   2. preflight  填的值**今天还能用吗**    必须真发一笔
 * 前者防 script 错误，后者防数据失效。前者过不了，后者跑了也没意义。
 */

import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { refdataPairs, createCases, pickCase, pickRefdata } from '../lib/data.js';
import { createTrade, validateInputs } from '../steps/workers/trade-management/create-trade.js';
import { ERR } from '../lib/errors.js';

export function preflight() {
  console.log(`── preflight ─────────────────────────────────`);
  console.log(`env=${cfg.envName} profile=${cfg.profileName}`);
  console.log(`target=${cfg.workersUrl}/trades/create`);
  console.log(`maker=${cfg.makerUserId}`);
  console.log(`refdata rows=${refdataPairs.length}  case rows=${createCases.length}`);

  // ── 数据存在性 ──────────────────────────────────────────
  if (refdataPairs.length === 0 || createCases.length === 0) {
    exec.test.abort(
      `PREFLIGHT FAILED — 数据文件没有数据行：` +
      `${cfg.data.refdataFile}=${refdataPairs.length} 行, ` +
      `${cfg.data.createDataFile}=${createCases.length} 行`
    );
  }

  // ⚠ 耦合检查：两个数组用同一个全局游标取模，行数相同会锁死组合
  //   （N 行 × N 行只跑到 N 种，而不是 N²）。这是数学问题，与工具无关。
  if (refdataPairs.length > 1 && refdataPairs.length === createCases.length) {
    console.warn(
      `⚠ refdata 与 case 行数相同（都是 ${refdataPairs.length}）—— 组合被锁死，` +
      `只会跑到 ${refdataPairs.length} 种而不是 ${refdataPairs.length * refdataPairs.length} 种。` +
      `把行数取成互质即可打散。`
    );
  }

  // ── 检查 1：本地，不发请求 ──────────────────────────────
  // 全部行都查，不只是第一行 —— 第 5 行的占位值同样会在跑到时才炸。
  const allProblems = [];
  for (let i = 0; i < Math.max(refdataPairs.length, createCases.length); i++) {
    const problems = validateInputs(pickRefdata(i), pickCase(i));
    problems.forEach((p) => allProblems.push(`[i=${i}] ${p}`));
    if (i >= 50) break;   // 大数据集时够采样了
  }

  if (allProblems.length > 0) {
    // 这里直接停，不走 warn 分支 —— 占位值会让**每一笔**业务失败，
    // 跑完只会得到一份错误率 100% 的报告。没有"部分可用"可言。
    console.error('PREFLIGHT FAILED — csv 数据不可用：');
    allProblems.slice(0, 10).forEach((p) => console.error('  ' + p));
    exec.test.abort(`csv 数据不可用（${allProblems.length} 处问题，详见上方日志）`);
  }
  console.log('✓ 检查 1/2：CSV 字段齐全，无占位值');

  // ── 检查 2：远端，真发一笔 ──────────────────────────────
  const refdata = pickRefdata(0);
  const caseRow = pickCase(0);
  const r = createTrade({ refdata, caseRow, runPhase: 'setup' });

  const usable = r.errClass === ERR.OK;

  if (usable) {
    console.log(
      `✓ 检查 2/2：refdata 业务可用 — pairId=${refdata.pairId} ` +
      `portfolio=${refdata.portfolioId} → ${r.tradeId} / ${r.taskId} ` +
      `(${Math.round(r.res.timings.duration)}ms)`
    );
  } else {
    const msg = `PREFLIGHT FAILED [${cfg.preflightPolicy}] — ${r.detail}`;
    if (cfg.preflightPolicy === 'abort') {
      // 数据不可用则整轮无意义。停在这里，避免产出一份"错误率 100%"
      // 却被当成性能结论的报告。
      console.error(msg + ' — stopping test');
      exec.test.abort(msg);
    } else {
      // warn：继续跑，但把状态留给结果分析阶段。
      // 前提是分析环节真的有人看 —— 如果没人看，这个策略等于没做校验。
      console.warn(msg + ' — continuing anyway (warn policy)');
    }
  }

  // ── 传给每个 VU 的东西 ───────────────────────────────────
  // 必须 JSON 可序列化。这里只传元信息，数据本身各 VU 从 SharedArray 读。
  return {
    startedAt: new Date().toISOString(),
    preflightOutcome: usable ? 'ok' : cfg.preflightPolicy,
    preflightDurationMs: Math.round(r.res.timings.duration),
    env: cfg.envName,
    profile: cfg.profileName,
    target: `${cfg.workersUrl}/trades/create`,
  };
}
