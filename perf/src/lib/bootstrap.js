// k6 场景装配层：集中 init 阶段的配置加载与 options/handleSummary 组装，
// 让场景文件只剩业务编排（meta + 参数池 + 一次业务动作）。
// 本模块使用 k6 运行时全局量（open()/__ENV），只能被 k6 加载——
// 纯逻辑模块（config.js/sla.js/report.js 等）保持 Node 可加载，职责勿混淆。
// open() 路径一律经 import.meta.resolve() 锚定到本文件——k6 的裸相对路径
// 目前相对主脚本解析、未来版本将改为相对模块解析，显式锚定在两种规则下行为一致。
import { parseEnvConfig } from './config.js';
import { buildProfile } from '../profiles/index.js';
import { buildThresholds } from './sla.js';
import { summarize, toMarkers } from './report.js';

export const ENV = __ENV.ENV || 'local';
export const TESTID = __ENV.TESTID || 'local-run';

// 每次 k6 运行只有一个环境：cfg 在 init 阶段一次性加载，场景直接 import 使用。
// baseUrl 不在此导出——场景不接触 URL，服务地址由 api 层经 serviceBaseUrl(cfg, svc) 解析。
export const cfg = parseEnvConfig(open(import.meta.resolve(`../../config/environments/${ENV}.json`)));

// 每个 API 一个专属数据文件：data/<service>/<scenario>.json，
// 压该 API 所需的全部参数池都在这一个文件里（仅 init 阶段可调用——open() 在 VU 阶段不可用）
export function loadData(path) {
  return JSON.parse(open(import.meta.resolve(`../../data/${path}.json`)));
}

// data/datfiles/<file> 二进制 dat 模板（仅 init 阶段可调用）
export function loadDat(file) {
  return open(import.meta.resolve(`../../data/datfiles/${file}`), 'b');
}

// 标准 options 组装：负载 profile（PROFILE/RATE/DURATION/MAX_VUS 经 __ENV 覆盖）
// + config/slas/<slaFile>.json 中指定条目的 thresholds + 统一分位数配置
export function buildOptions(slaFile, slaKey) {
  const sla = JSON.parse(open(import.meta.resolve(`../../config/slas/${slaFile}.json`)));
  const entry = sla[slaKey];
  if (!entry) throw new Error(`unknown SLA key: ${slaKey} in ${slaFile}`);
  return {
    scenarios: { main: buildProfile(__ENV.PROFILE || 'smoke', __ENV) },
    thresholds: buildThresholds(entry),
    summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)'],
  };
}

// 标准 handleSummary：stdout 标记 JSON（run.sh 从日志提取后出报告）。
// 场景以 `export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js'` 复用。
export function stdHandleSummary(data) {
  return { stdout: toMarkers(summarize(data, TESTID)) };
}
