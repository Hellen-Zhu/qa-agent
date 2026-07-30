/*
 * journeys/j01-create-trade.js
 *
 * 【层级】journey —— 把 steps 组合成一条完整前端用户路径；
 *        自己不含 executor / thresholds（那是 scenarios 的职责）
 * 【被谁引用】scenarios/s01-create-trade-e2e.js
 *
 * ── 用户路径 ──
 *   1. 打开 create-trade 页面 → 拉两个下拉框          [refdata × 2]
 *      ↓ think：用户选组合、选交易对手、挑 .dat 文件
 *   2. 风险预览（软依赖，失败不阻断）                  [calc-risk-for-new]
 *      ↓ think：用户看预览
 *   3. 提交                                            [create]
 *      ↓ think：用户看提交结果
 *   4. 查看刚建好的这笔（踩 UC gRPC + risk-engine）    [detail + risk-metrics]
 *
 * ── refdataMode ──
 *   live    真拉下拉框（忠实路径）。refdata 地址未确认前会连接拒绝 ——
 *           那是显式失败，见 scenarios/s01 的 setup 提示。
 *   static  跳过下拉框查询，归属字段取用例行内嵌值
 *           （portfolioId / counterpartyFmId / counterpartyName 就在 create-trade.json 里）。
 *           **已知偏差**：不覆盖 refdata 查询路径，报告必须标注。
 *
 * live 模式两个列表都拉成功时才现场绑定；任一失败则降级回用例内嵌值，
 * 并计 oreo_refdata_fallback —— 这个计数非 0 说明"页面打开就失败"
 * 在真实用户那里也会发生，值得单独看。
 */

import { Counter } from 'k6/metrics';
import { think } from '../lib/think.js';
import { pickCase } from '../steps/workers/trade-management/create-trade-data.js';
import { portfoliosList } from '../steps/refdata/portfolios-list.js';
import { counterpartiesList } from '../steps/refdata/counterparties-list.js';
import { calcRiskForNew } from '../steps/workers/trade-management/calc-risk-for-new.js';
import { createTrade } from '../steps/workers/trade-management/create-trade.js';
import { tradeDetail } from '../steps/workers/trade-management/trade-detail.js';
import { tradeRiskMetrics } from '../steps/workers/trade-management/trade-risk-metrics.js';
import { ERR } from '../lib/errors.js';

export const cRefdataFallback = new Counter('oreo_refdata_fallback');

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * 一次迭代 = 一个用户从打开页面到看完详情的完整动作。
 *
 * @param {Object} opts
 * @param {number} opts.i            全局迭代号（数据游标）
 * @param {string} opts.runPhase     'setup' | 'main'
 * @param {string} opts.refdataMode  'live' | 'static'
 * @returns 与 createTrade 相同的结果对象（含 tradeId / errClass）
 */
export function j01CreateTrade(opts) {
  const { i, runPhase, refdataMode } = opts;
  const caseRow = pickCase(i);

  // ── 1. 打开页面：拉下拉框 ────────────────────────────────
  // refdata 为 null 时下游步骤自动取用例内嵌归属字段（static 模式与降级共用这条路）
  let refdata = null;
  if (refdataMode === 'live') {
    const pf = portfoliosList({ runPhase });
    const cp = counterpartiesList({ runPhase });

    if (pf.errClass === ERR.OK && pf.list.length > 0 &&
        cp.errClass === ERR.OK && cp.list.length > 0) {
      const p = pickRandom(pf.list);
      // ⚠ fmId 与 name 必须来自**同一条**记录 —— 两次独立随机会偶发拼出
      //   A 的 fmId 配 B 的 name，表现为"错误率 3%，无规律"（见步骤文件头注）
      const c = pickRandom(cp.list);
      refdata = {
        portfolioId: String(p.id || ''),
        counterpartyFmId: String(c.fmId || ''),
        counterpartyName: String(c.name || ''),
      };
      // 随机而非取模：E2E 要的是真实分布，不是可复现对照实验
      // （后者是单接口测试的目标，由用例池轮询承担）
    } else {
      cRefdataFallback.add(1); // 降级：下游步骤取用例内嵌值
    }
  }

  think(2000, 3000); // 用户填表：选组合、选交易对手、挑文件

  // ── 2. 风险预览（软依赖：失败不阻断，前端行为一致）──────
  calcRiskForNew({ refdata, caseRow, runPhase });

  think(500, 1500); // 用户看风险预览

  // ── 3. 提交 ─────────────────────────────────────────────
  const created = createTrade({ refdata, caseRow, runPhase });

  think(2000, 3000); // 用户看提交结果

  // ── 4. 查看详情 ─────────────────────────────────────────
  // create 失败时整段跳过：不加这个守卫会发出 GET /trades/NOT_FOUND，
  // 制造一批 404 把真正的 create 失败淹没掉
  if (created.errClass === ERR.OK && created.tradeId !== 'NOT_FOUND') {
    tradeDetail({ tradeId: created.tradeId, runPhase });
    tradeRiskMetrics({ tradeId: created.tradeId, runPhase });
  }

  return created;
}
