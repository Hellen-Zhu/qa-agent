/*
 * scenarios/p02-trade-create.js
 *
 * 【层级】可运行计划 —— 薄壳，自己不定义请求
 * 【对应】jmx/api/p02-trade-create.jmx
 * 【测什么】POST /trades/create 的纯服务端能力
 * 【怎么跑】./k6/run.sh p02-trade-create dev smoke
 *
 * ── 与 E2E 场景的关键差别（与 JMeter 侧一致）──
 * 1. **完全不查 refdata** —— portfolio / counterparty 由 CSV 直接供数。
 *    E2E 里 refdata 是被测链路的一部分；单接口测试里它是噪音。
 * 2. **不加 think time** —— 测的是"服务端一秒能处理多少"，不是用户体验。
 * 3. **不含 view-trade-details** —— 同理。
 *
 * ══ k6 相对 JMeter 的三个结构性简化 ═════════════════════════════
 * 1. 没有 Transaction Controller ⇒ **没有"事务行 + 采样行"双计数问题**。
 *    JMeter 里算 TPS 必须小心不要把两者相加；这里 http_reqs 就是请求数。
 * 2. setup() 不占用 scenario 迭代 ⇒ **preflight 不会消耗 CSV 第一行**，
 *    也不会混进主循环的耗时统计（它自带 runPhase=setup 标签，天然可分）。
 * 3. import 天然保证契约只有一份 ⇒ 不需要 validate.py 的 R2 规则去查重复。
 * ═══════════════════════════════════════════════════════════════
 */

import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { pickCase, pickRefdata } from '../lib/data.js';
import { createTrade } from '../steps/workers/trade-management/create-trade.js';
import { preflight } from '../setup/preflight.js';
import { buildTextSummary } from '../lib/summary.js';

const PLAN = 'p02-trade-create';

export const options = {
  scenarios: {
    // profile 里的 scenario 直接就是 k6 的 executor 配置，不做二次翻译。
    // 换负载模型 = 换 -e PROFILE=xxx，脚本一行不改（三维正交）。
    create: Object.assign({ exec: 'createTradeIteration' }, cfg.scenario),
  },

  thresholds: Object.assign(
    {
      // 这一条是**任何 profile 都必须成立**的底线，不由 profile 决定：
      // script 错误 = 脚本 bug，本轮结果作废。
      // technical / business 的容忍度因 profile 而异（smoke 要求 0，
      // ladder 过了拐点出现 technical 恰恰是要测的结论），所以放 profile 里。
      oreo_err_script: ['count==0'],
    },
    cfg.thresholds
  ),

  // 默认摘要不含 P50 之外的分位，显式指定
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],

  // 我们要解析响应体做业务判定，不能丢
  discardResponseBodies: false,

  // 所有指标默认带上环境/profile 标签，便于在 Grafana 里区分不同轮次
  tags: {
    plan: PLAN,
    env: cfg.envName,
    profile: cfg.profileName,
  },
};

// ── setUp：开跑前守卫 ─────────────────────────────────────────
export function setup() {
  return preflight();
}

// ── 主循环：一次迭代 = 一笔 create ────────────────────────────
export function createTradeIteration() {
  // 全局单调计数器，语义等同 JMeter 的 shareMode.all（一个全局游标）
  const i = exec.scenario.iterationInTest;

  createTrade({
    refdata: pickRefdata(i),
    caseRow: pickCase(i),
    runPhase: 'main',
    // 身份固定 maker，不轮换（NFR SEC-02 见 config/dev.properties）。
    // 需要"分散 maker vs 集中同一 maker"的对照实验时，
    // 在这里按 exec.vu.idInTest 取不同账号即可 —— 但那是另一个实验。
  });
}

// ── 收尾 ──────────────────────────────────────────────────────
export function handleSummary(data) {
  const meta = {
    plan: PLAN,
    env: cfg.envName,
    profile: cfg.profileName,
    target: `${cfg.workersUrl}/trades/create`,
  };

  const out = {
    stdout: buildTextSummary(data, meta),
  };

  // run.sh 会把 RESULT_DIR 传进来；直接 k6 run 时只打屏幕
  const dir = __ENV.RESULT_DIR;
  if (dir) {
    out[`${dir}/summary.txt`] = buildTextSummary(data, meta);
    out[`${dir}/summary.json`] = JSON.stringify(data, null, 2);
  }
  return out;
}
