/*
 * scenarios/p05-trades-list.js
 *
 * 【层级】可运行计划 —— 薄壳，自己不定义请求
 * 【测什么】GET /trades —— 全系统请求量最大的接口（S-09 / S-10 的被测对象）
 * 【怎么跑】./k6/run.sh p05-trades-list dev smoke
 *          ./k6/run.sh p05-trades-list dev arrival RATE=4        # 稳态 4.13 TPS
 *          ./k6/run.sh p05-trades-list dev arrival RATE=33       # 设计容量
 *          ./k6/run.sh p05-trades-list dev smoke BLOTTER_PAGE_SIZE=500
 *
 * ══ S-09 扇出审计（安静窗口，逐档单发）════════════════════════
 *   for n in 50 200 500; do
 *     ./k6/run.sh p05-trades-list dev smoke BLOTTER_PAGE_SIZE=$n
 *   done
 *   每档前后取 Prometheus 的 rpc_client_duration_milliseconds_count 差值：
 *     差值恒定  → 扇出 O(1)，健康
 *     差值∝行数 → N+1，33 TPS 列表 = 6,600 QPS gRPC，首要瓶颈
 *   见 GRAFANA.zh.md §5。
 *
 * ══ S-10 数据量伸缩 ═══════════════════════════════════════════
 *   固定 pageSize=200 + arrival RATE，扫数据量档位 1k/50k/250k（等造数工厂）。
 *   SCALE-01：250k 档 P95 ≤ 1k 档的 3 倍；超 10 倍基本可断定全表扫描。
 * ═══════════════════════════════════════════════════════════════
 *
 * ── 与 p02 的两个刻意差别 ──
 * 1. 不 import lib/data.js —— 读接口不需要 CSV/.dat，import 了反而会在
 *    init 阶段把 .dat 全读进内存（data.js 是急加载的）。
 * 2. preflight 不建 trade —— 对读接口，"数据可用"=真的查得到行。
 *    在 setup 里发一次真实查询验证，顺带提取库内总量（进入准则 #3 的
 *    数据量声明：空库/小库的列表结论只能作趋势，不能当容量结论）。
 */

import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { tradesList } from '../steps/workers/trade-management/trades-list.js';
import { ERR } from '../lib/errors.js';
import { makeHandleSummary } from '../lib/summary.js';

const PLAN = 'p05-trades-list';

// ── 命令行维度（run.sh 裸 KEY=value 传入）──
function intEnv(key, fallback) {
  const v = __ENV[key];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  if (isNaN(n)) throw new Error(`-e ${key}=${v} 不是整数`);
  return n;
}

const PAGE_SIZE = intEnv('BLOTTER_PAGE_SIZE', 200); // A17；S-09/S-10 的扫描维度
const PAGE = intEnv('BLOTTER_PAGE', 0);
const SEARCH = __ENV.TRADES_SEARCH || '';
const STATUS = __ENV.STATUS_FILTER || '';

export const options = {
  scenarios: {
    list: Object.assign({ exec: 'tradesListIteration' }, cfg.scenario),
  },

  thresholds: Object.assign(
    {
      oreo_err_script: ['count==0'],
    },
    cfg.thresholds
  ),

  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  discardResponseBodies: false, // 要解析 body 提行数
  tags: {
    plan: PLAN,
    env: cfg.envName,
    profile: cfg.profileName,
  },
};

// ── setUp：读接口版 preflight ─────────────────────────────────
export function setup() {
  console.log(`── preflight（读接口版）──────────────────────`);
  console.log(`target=${cfg.workersUrl}/trades  pageSize=${PAGE_SIZE}`);

  const r = tradesList({ runPhase: 'setup', pageSize: PAGE_SIZE, page: PAGE, status: STATUS });

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

// ── 主循环：一次迭代 = 一次列表查询 ──────────────────────────
export function tradesListIteration() {
  tradesList({
    runPhase: 'main',
    pageSize: PAGE_SIZE,
    page: PAGE,
    search: SEARCH,
    status: STATUS,
  });
}

// ── 收尾 ──────────────────────────────────────────────────────
export const handleSummary = makeHandleSummary(() => ({
  plan: PLAN,
  env: cfg.envName,
  profile: cfg.profileName,
  target: `${cfg.workersUrl}/trades?size=${PAGE_SIZE}`,
}));
