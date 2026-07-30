/*
 * setup/create-trade-preflight.js —— **create-trade 路径**的开跑前守卫
 *
 * ── 命名约定 ──
 *   setup/<被测路径>-preflight.js  导出 <被测路径>Preflight()
 *   与 lib/<被测路径>-data.js 成对：数据怎么来、怎么证明它今天还能用。
 * 守卫是**跟着被测路径走的**，不是全局设施 —— p05 压列表接口就不该跑
 * 一个建 trade 的守卫，它有自己的 setup/trades-list-preflight.js。
 *
 * 谁在用：scenarios/p02-trade-create.js、scenarios/s01-create-trade-e2e.js
 * —— 两个场景都创建 trade，共用同一个守卫是对的（守卫绑路径，不绑场景）。
 *
 * 跑在 setup()：**整个测试开始前执行一次**，返回值由运行时序列化后
 * 拷贝给每个 VU。
 *
 * ══ 为什么静态供数下这一步不能省 ═══════════════════════════
 * live 模式下失效数据在 setup 查 refdata 时**当场暴露**。
 * 静态供数没有那次查询 —— 数据文件里的 id 若已失效（counterparty 被
 * 第三方停用、portfolio 被归档），请求照发，服务端返回业务拒绝。
 * 报告里表现为"错误率升高"而不是"启动失败"，会被误读成性能问题。
 *
 * 所以这不是可选的加固，是静态供数**唯一**的数据有效性证明。
 * 一条静态数据证明不了任何事，只有真发一笔 create 才行。
 * ═══════════════════════════════════════════════════════════
 *
 * ── 两道检查的分工（别合并）──
 *   1. 本地检查   数据文件**填了没**        不发请求，失败即停
 *   2. preflight  填的值**今天还能用吗**    必须真发一笔
 * 前者防 script 错误，后者防数据失效。前者过不了，后者跑了也没意义。
 */

import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { createCases, pickCase, DATA_FILE, DAT_NAME_MODE } from '../steps/workers/trade-management/create-trade-data.js';
import { createTrade, validateInputs } from '../steps/workers/trade-management/create-trade.js';
import { ERR } from '../lib/errors.js';

export function createTradePreflight() {
  console.log(`── preflight: create-trade ───────────────────`);
  console.log(`env=${cfg.envName} profile=${cfg.profileName}`);
  console.log(`target=${cfg.workersUrl}/trades/create`);
  console.log(`maker=${cfg.makerUserId}`);
  console.log(`data=${DATA_FILE}  rows=${createCases.length}`);
  if (DAT_NAME_MODE === 'unique') {
    // 偏差必须在日志和报告里都刺眼：生产用户不会改名上传
    console.warn(
      '⚠ DAT_NAME_MODE=unique — 上传文件名加唯一后缀，绕服务端临时文件竞态缺陷。' +
      '报告必须标注偏差；缺陷修复后关掉本开关做并发复测（回归验证）'
    );
  }

  // ── 数据存在性 ──────────────────────────────────────────
  if (createCases.length === 0) {
    exec.test.abort(`PREFLIGHT FAILED — 数据文件没有数据行：${DATA_FILE}`);
  }

  // ── 检查 1：本地，不发请求 ──────────────────────────────
  // 全部行都查，不只是第一行 —— 第 5 行的占位值同样会在跑到时才炸。
  const allProblems = [];
  for (let i = 0; i < createCases.length; i++) {
    const problems = validateInputs(pickCase(i));
    problems.forEach((p) => allProblems.push(`[第${pickCase(i).__row}行] ${p}`));
    if (i >= 50) break;   // 大数据集时够采样了
  }

  if (allProblems.length > 0) {
    // 这里直接停，不走 warn 分支 —— 占位值会让**每一笔**业务失败，
    // 跑完只会得到一份错误率 100% 的报告。没有"部分可用"可言。
    console.error('PREFLIGHT FAILED — 静态数据不可用：');
    allProblems.slice(0, 10).forEach((p) => console.error('  ' + p));
    exec.test.abort(`静态数据不可用（${allProblems.length} 处问题，详见上方日志）`);
  }
  console.log('✓ 检查 1/2：数据字段齐全，无占位值');

  // ── 检查 2：远端，真发一笔 ──────────────────────────────
  const caseRow = pickCase(0);
  const r = createTrade({ caseRow, runPhase: 'setup' });

  const usable = r.errClass === ERR.OK;

  if (usable) {
    console.log(
      `✓ 检查 2/2：数据业务可用 — 第${caseRow.__row}行 ` +
      `portfolio=${caseRow.portfolioId} → ${r.tradeId} / ${r.taskId} ` +
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
    dataFile: DATA_FILE,
    env: cfg.envName,
    profile: cfg.profileName,
    target: `${cfg.workersUrl}/trades/create`,
  };
}
