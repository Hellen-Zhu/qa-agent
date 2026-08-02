// k6 场景装配层：集中 init 阶段的配置加载与 options/handleSummary 组装，
// 让场景文件只剩业务编排（meta + 数据 + 一次业务动作）。
// 本模块使用 k6 运行时全局量（open()/__ENV），只能被 k6 加载——
// 纯逻辑模块（config.js/sla.js/report.js/rows.js）保持 Node 可加载，职责勿混淆。
// open() 路径一律经 import.meta.resolve() 锚定到本文件。
import { parseEnvConfig } from './config.js';
import { buildThresholds } from './sla.js';
import { summarize, buildTextSummary, compareBaseline } from './report.js';

export const ENV = __ENV.ENV || 'local';
export const PROFILE = __ENV.PROFILE || 'smoke';
export const TESTID = __ENV.TESTID || 'local-run';
// runner 传入（run.sh -e SCENARIO）；裸 k6 run 无此值 → 跳过基线对比
const SCENARIO = __ENV.SCENARIO || '';

// ── 基线加载：baselines/<scenario>_<env>_<profile>.json ─────
// 基线就是某轮可信运行晋升来的 summary.json（spec §9）。组合键含 env+profile——
// 跨环境或跨负载档的对比没有意义。无基线是常态（open 抛错→null，静默跳过）；
// 有文件但损坏则响亮失败（JSON.parse 抛出，init 报错拒跑），坏基线不许静默降级。
function loadBaseline() {
  if (!SCENARIO) return null;
  let raw = null;
  try {
    raw = open(import.meta.resolve(`../../baselines/${SCENARIO}_${ENV}_${PROFILE}.json`));
  } catch (_) {
    return null;
  }
  return JSON.parse(raw);
}
const BASELINE = loadBaseline();

const HARD_MAX_VUS = 500;

// 每次 k6 运行只有一个环境：cfg 在 init 阶段一次性加载，场景直接 import 使用。
// baseUrl 不在此导出——场景不接触 URL，服务地址由 api 层经 serviceBaseUrl(cfg, svc) 解析。
export const cfg = parseEnvConfig(open(import.meta.resolve(`../../config/environments/${ENV}.json`)));

// data/<path>.json 数据文件（仅 init 阶段可调用——open() 在 VU 阶段不可用）
export function loadData(path) {
  return JSON.parse(open(import.meta.resolve(`../../data/${path}.json`)));
}

/** JSON 无注释语法，约定 _ 开头的键是注释，进 k6 前必须剥除——
 *  k6 把 thresholds 下每个键当指标名，留着 _comment 会直接报错 */
export function stripComments(obj) {
  const out = {};
  Object.keys(obj || {}).forEach((k) => {
    if (!k.startsWith('_')) out[k] = obj[k];
  });
  return out;
}

function intEnv(key) {
  const v = __ENV[key];
  if (v === undefined || v === '') return undefined;
  const n = parseInt(v, 10);
  if (isNaN(n)) throw new Error(`-e ${key}=${v} 不是整数`);
  return n;
}

// 覆盖仅作用于 profile scenario 中存在的同名标量键（stages 字面量不受覆盖影响，
// 见各 profile 的 _override 注释）；maxVUs 施加全局硬上限，防误配置打挂共享环境
function applyOverrides(sc) {
  const rate = intEnv('RATE');
  const vus = intEnv('VUS');
  const maxVUs = intEnv('MAX_VUS');
  if (sc.rate !== undefined && rate !== undefined) sc.rate = rate;
  if (sc.vus !== undefined && vus !== undefined) sc.vus = vus;
  if (sc.duration !== undefined && __ENV.DURATION) sc.duration = __ENV.DURATION;
  if (sc.maxVUs !== undefined && maxVUs !== undefined) sc.maxVUs = maxVUs;
  if (sc.maxVUs !== undefined) sc.maxVUs = Math.min(sc.maxVUs, HARD_MAX_VUS);
  return sc;
}

/*
 * 标准 options 组装。thresholds 三层叠加（spec §4/§7）：
 *   1. 底线（任何 profile 都必须成立）：perf_err_script count==0——脚本错误=本轮作废
 *   2. profile 级（profiles/<name>.json 的 thresholds 块）：业务成功率 verdict/熔断两级线
 *   3. API 级（config/slas/）：perf_success_duration 分位数 SLA——探索型 profile（拐点/
 *      崩塌形态是测量目标本身）可用顶层 "apiSla": false 豁免这一层，仍强制校验 slaKey
 *      存在（配错 key 必须快速失败，不因豁免而被掩盖）
 *   4. extra：场景专属附加（如 query 的空库守卫）
 */
export function buildOptions(slaFile, slaKey, extraThresholds) {
  const profile = JSON.parse(open(import.meta.resolve(`../../profiles/${PROFILE}.json`)));
  const scenario = applyOverrides(stripComments(profile.scenario));
  const sla = JSON.parse(open(import.meta.resolve(`../../config/slas/${slaFile}.json`)));
  const entry = sla[slaKey];
  if (!entry) throw new Error(`unknown SLA key: ${slaKey} in ${slaFile}`);
  const apiSla = profile.apiSla !== false;
  return {
    scenarios: { main: scenario },
    thresholds: Object.assign(
      { perf_err_script: ['count==0'] },
      stripComments(profile.thresholds || {}),
      apiSla ? buildThresholds(entry) : {},
      extraThresholds || {},
    ),
    // 文本摘要各列（P50/P90/P95/P99/max/avg + 样本数）都要有值，缺谁谁列空
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  };
}

// 标准 handleSummary（导出后 k6 不再打默认摘要，本函数负责全部输出）：
//   stdout 文本摘要；RESULT_DIR（runner 传入）非空时由 k6 直接写盘
//   summary.txt（同文本）+ summary.json（机读，runner 提取 verdict 定退出码）。
// 裸 `k6 run` 不传 RESULT_DIR，只打终端——行为与 trade-performance 一致。
// 场景以 `export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js'` 复用。
export function stdHandleSummary(data) {
  const s = summarize(data, TESTID);
  // 基线对比：只提示不改判定（verdict 权威=阈值；BASELINE_TOL_PCT 覆盖延迟容差）
  let cmp = null;
  if (BASELINE) {
    cmp = compareBaseline(s, BASELINE, parseInt(__ENV.BASELINE_TOL_PCT || '', 10));
    s.baseline = cmp;
  }
  const text = buildTextSummary(data, { testid: TESTID, env: ENV, profile: PROFILE }, cmp);
  const out = { stdout: text };
  const dir = __ENV.RESULT_DIR;
  if (dir) {
    out[`${dir}/summary.txt`] = text;
    out[`${dir}/summary.json`] = JSON.stringify(s, null, 2);
  }
  return out;
}
