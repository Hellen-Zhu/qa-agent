/*
 * scenarios/s01-create-trade-e2e.js
 *
 * 【层级】可运行计划 —— 薄壳：executor + thresholds + 收尾，路径逻辑在 journey
 * 【测什么】S-03：Create Trade 完整前端链路（PERF-07 / PERF-11 / PERF-19）
 * 【怎么跑】./k6/run.sh s01-create-trade-e2e dev smoke
 *          ./k6/run.sh s01-create-trade-e2e dev smoke REFDATA_MODE=static
 *          ./k6/run.sh s01-create-trade-e2e dev arrival RATE=1 DURATION=600s REFDATA_MODE=static
 *
 * ── 与 p02 的本质区别 ──
 * p02 测"服务端一秒能处理多少 create"；本场景测"一个真实用户的完整
 * 动作序列压在系统上是什么样"——含 refdata 查询、风险预览、think time、
 * 详情回看。**两者的数字不可互相替换**：E2E 的 create P95 里混着
 * 同链路其它请求对资源的挤占，那正是它存在的意义。
 *
 * ── REFDATA_MODE（默认 live）──
 * refdata 服务地址在 config/dev.json 仍是 localhost 占位（NFR 待确认 #12）。
 * live 模式在地址确认前会在 setup 里显式失败，并提示两条路：
 *   1) 找架构确认 refdata 地址，填进 config/dev.json（正解）
 *   2) REFDATA_MODE=static 先跑（降级：归属字段取用例内嵌值，
 *      不覆盖下拉框查询，报告必须标注偏差）
 *
 * ── ⚠ 数据副作用 ──
 * 每次迭代真实创建一笔 PENDING APPROVAL trade。长时运行一律用 arrival
 * 到达率形态，禁止 constant-vus 满打（计划 §6.3 门槛 5）。
 */

import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { j01CreateTrade } from '../journeys/j01-create-trade.js';
import { portfoliosList } from '../steps/refdata/portfolios-list.js';
import { preflight } from '../setup/preflight.js';
import { ERR } from '../lib/errors.js';
import { buildTextSummary } from '../lib/summary.js';

const PLAN = 's01-create-trade-e2e';

const REFDATA_MODE = __ENV.REFDATA_MODE || 'live';
if (REFDATA_MODE !== 'live' && REFDATA_MODE !== 'static') {
  throw new Error(`REFDATA_MODE=${REFDATA_MODE} 无效，只接受 live | static`);
}

export const options = {
  scenarios: {
    e2e: Object.assign({ exec: 'journeyIteration' }, cfg.scenario),
  },

  thresholds: Object.assign(
    {
      oreo_err_script: ['count==0'],

      // ── 分步耗时的哨兵阈值 ──────────────────────────────
      // 'max>=0' 恒真，存在的唯一意义是让 k6 为这些 tag 组合生成子指标，
      // summary 才有"分步耗时"段（k6 只为声明过阈值的组合出子指标）。
      // summary.js 会把它们从阈值判定清单里滤掉。
      'oreo_success_duration{name:workers_trademgmt_create}': ['max>=0'],
      'oreo_success_duration{name:workers_trademgmt_calcriskfornew}': ['max>=0'],
      'oreo_success_duration{name:workers_trademgmt_detail}': ['max>=0'],
      'oreo_success_duration{name:workers_trademgmt_riskmetrics}': ['max>=0'],
      'oreo_success_duration{name:refdata_portfolios_list}': ['max>=0'],
      'oreo_success_duration{name:refdata_counterparties_list}': ['max>=0'],
    },
    cfg.thresholds
  ),

  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  discardResponseBodies: false,
  tags: {
    plan: PLAN,
    env: cfg.envName,
    profile: cfg.profileName,
    refdataMode: REFDATA_MODE, // 结果必须能区分是不是降级跑出来的
  },
};

// ── setUp ─────────────────────────────────────────────────────
export function setup() {
  // live 模式先探 refdata 通不通 —— 不通时给出明确的两条路，
  // 而不是让主循环跑出一堆 fallback 再让人猜为什么
  if (REFDATA_MODE === 'live') {
    const probe = portfoliosList({ runPhase: 'setup' });
    if (probe.errClass !== ERR.OK) {
      exec.test.abort(
        `PREFLIGHT FAILED — refdata 不可达（${probe.detail}）。` +
        `config/${cfg.envName}.json 的 refdata 地址可能仍是占位值（NFR 待确认 #12）。` +
        `两条路：① 向架构确认地址后填入 config；② 临时用 REFDATA_MODE=static 跑` +
        `（降级：不覆盖下拉框查询，报告须标注偏差）`
      );
    }
    console.log(`✓ refdata 可达（${probe.list.length} 个 portfolio）`);
  } else {
    console.warn('⚠ REFDATA_MODE=static —— 不覆盖 refdata 查询路径，报告必须标注此偏差');
  }

  // create 路径的标准 preflight（数据校验 + 真建一笔）
  return preflight();
}

// ── 主循环：一次迭代 = 一个用户的完整动作 ────────────────────
export function journeyIteration() {
  j01CreateTrade({
    i: exec.scenario.iterationInTest,
    runPhase: 'main',
    refdataMode: REFDATA_MODE,
  });
}

// ── 收尾 ──────────────────────────────────────────────────────
export function handleSummary(data) {
  const meta = {
    plan: PLAN,
    env: cfg.envName,
    profile: cfg.profileName,
    target: `${cfg.workersUrl} (E2E: refdata ×2 → calc-risk → create → detail → risk-metrics, refdataMode=${REFDATA_MODE})`,
  };

  const out = { stdout: buildTextSummary(data, meta) };
  const dir = __ENV.RESULT_DIR;
  if (dir) {
    out[`${dir}/summary.txt`] = buildTextSummary(data, meta);
    out[`${dir}/summary.json`] = JSON.stringify(data, null, 2);
  }
  return out;
}
