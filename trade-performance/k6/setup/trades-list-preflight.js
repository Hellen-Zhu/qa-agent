/*
 * setup/trades-list-preflight.js —— **trades-list 路径**的开跑前守卫
 *
 * 命名约定见 setup/create-trade-preflight.js 头注。
 * 谁在用：scenarios/p05-trades-list.js
 *
 * ── 与 create-trade 守卫的本质差别 ──
 * 读接口没有"静态数据会失效"这个问题类别，所以**不建 trade**。
 * 它要证明的是另外两件事：
 *   1. 这个查询真的查得到行（连不上/不是 JSON → 整轮无意义，立即中止）
 *   2. 库内总量是多少 —— **进入准则 #3 的数据量声明**：
 *      空库或小库的列表结论只能作趋势，不能当容量结论；
 *      不写明总量，P95 和别轮根本没法比。
 *
 * ⚠ 本模块**不 import create-trade 的供数模块** —— 读接口不需要用例池和
 *   .dat，import 了反而会在 init 阶段把 .dat 全读进内存（那个模块是急加载的）。
 */

import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { tradesList } from '../steps/workers/trade-management/trades-list.js';
import { ERR } from '../lib/errors.js';

/**
 * @param {Object} opts  {pageSize, page, status} —— 与主循环用同一组查询参数，
 *                       否则 preflight 验证的不是将要压的那个查询
 * @returns {{startedAt, totalTrades}}  传给每个 VU 的元信息
 */
export function tradesListPreflight(opts) {
  const { pageSize, page, status } = opts;

  console.log(`── preflight: trades-list（读接口）───────────`);
  console.log(`env=${cfg.envName} profile=${cfg.profileName}`);
  console.log(`target=${cfg.workersUrl}/trades  pageSize=${pageSize}`);

  const r = tradesList({ runPhase: 'setup', pageSize, page, status });

  if (r.errClass !== ERR.OK) {
    // 连不上/不是 JSON：压测毫无意义，且跑下去只会产出一份 100% 错误的报告
    exec.test.abort(`PREFLIGHT FAILED — ${r.detail}`);
  }

  if (r.rowCount === 0) {
    console.warn(
      '⚠ 库里查不到任何 trade —— 空库的列表结论无效（进入准则 #3 / A16）。' +
      '本轮只能作脚本验证，不能当性能结论。'
    );
  } else if (r.rowCount < 0) {
    console.warn('⚠ 无法从响应里提取行数 —— 分页包装形态未知，先人工看一眼 body 再压');
  } else {
    console.log(`✓ preflight：返回 ${r.rowCount} 行（${Math.round(r.res.timings.duration)}ms）`);
  }

  // 数据量声明：报告必须写明库内总量，否则 P95 无法和别轮对比
  if (r.total >= 0) {
    console.log(`ℹ 库内 trade 总量 ≈ ${r.total} —— 写进报告（S-10 的数据量档位口径）`);
  } else {
    console.log('ℹ 响应里没有总量元数据 —— 数据量请向 DBA 确认后写进报告');
  }

  return { startedAt: new Date().toISOString(), totalTrades: r.total };
}
