/*
 * lib/config.js —— 三维正交的合并点
 *
 *   维度一 计划    scenarios/*.js          "测什么"
 *   维度二 环境    config/<ENV>.json       "打哪个环境"      -e ENV=dev
 *   维度三 负载    profiles/<PROFILE>.json "施加多大压力"    -e PROFILE=baseline
 *   命令行覆盖     -e VUS=8 -e DURATION=180s               优先级最高
 *
 * ⚠ 本文件只能在 init 上下文求值 —— open() 是 init-only。
 *   模块顶层就是 init 上下文，所以这里没问题；但**不要**在 default 函数里 import 它之外的东西。
 *
 * ⚠ open() 的相对路径以**本文件所在目录**为基准（k6/lib/），不是当前工作目录。
 *   所以 run.sh 不需要为了路径而 cd（但仍然 cd，理由见 run.sh）。
 */

const ENV_NAME = __ENV.ENV || 'dev';
const PROFILE_NAME = __ENV.PROFILE || 'smoke';

const envCfg = JSON.parse(open(`../config/${ENV_NAME}.json`));
const profileCfg = JSON.parse(open(`../profiles/${PROFILE_NAME}.json`));

/** 命令行 -e 覆盖：只覆盖显式给出的键，未给出的保持配置文件的值 */
function pick(envKey, fallback) {
  const v = __ENV[envKey];
  return v === undefined || v === '' ? fallback : v;
}

function pickInt(envKey, fallback) {
  const v = __ENV[envKey];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  if (isNaN(n)) throw new Error(`-e ${envKey}=${v} 不是整数`);
  return n;
}

// ── 服务寻址 ──────────────────────────────────────────────────
// 刻意保持"每个服务各自寻址"的结构（config/*.json 里 5 个 svc）。
// 不设全局 host：忘记指定服务的请求会直接失败，而不是静默打到别的服务上。
const svc = envCfg.services;

function baseUrl(name) {
  const s = svc[name];
  if (!s) throw new Error(`config/${ENV_NAME}.json 里没有服务 '${name}'`);
  return `${s.protocol}://${s.host}:${s.port}${s.basePath}`;
}

/*
 * JSON 不支持注释，而这些配置**必须**能写清楚"为什么是这个值" ——
 * 约定：下划线开头的键是注释，进 k6 之前一律剥掉。
 *
 * ⚠ 这一步不能省：k6 会把 thresholds 的每个键当成**指标名**，
 *   留一个 "_comment" 在里面会直接报 "threshold for a non-existent metric"。
 */
function stripComments(obj) {
  const out = {};
  Object.keys(obj || {}).forEach((k) => {
    if (!k.startsWith('_')) out[k] = obj[k];
  });
  return out;
}

// ── 负载模型 ──────────────────────────────────────────────────
// profile 里的 scenario 直接就是 k6 的 executor 配置 —— 不做二次翻译，
// 这样 profiles/*.json 读起来就是 k6 文档里的东西，没有中间层要维护。
const scenario = stripComments(profileCfg.scenario);

// 常用维度允许命令行覆盖（阶梯加压时只改这几个）
if (__ENV.VUS !== undefined && scenario.vus !== undefined) scenario.vus = pickInt('VUS', scenario.vus);
if (__ENV.DURATION !== undefined && scenario.duration !== undefined) scenario.duration = pick('DURATION', scenario.duration);
if (__ENV.RATE !== undefined && scenario.rate !== undefined) scenario.rate = pickInt('RATE', scenario.rate);
if (__ENV.ITERATIONS !== undefined && scenario.iterations !== undefined) scenario.iterations = pickInt('ITERATIONS', scenario.iterations);

export const cfg = {
  envName: ENV_NAME,
  profileName: PROFILE_NAME,

  baseUrl,
  workersUrl: baseUrl('workers'),

  // 身份：固定 maker / checker，不轮换。理由见 config/dev.json 与 NFR SEC-02。
  makerUserId: pick('MAKER_USER_ID', envCfg.identity.makerUserId),
  checkerUserId: pick('CHECKER_USER_ID', envCfg.identity.checkerUserId),

  dynRun: String(envCfg.dynRun === undefined ? false : envCfg.dynRun),

  requestTimeout: pick('REQUEST_TIMEOUT', envCfg.timeouts.request),

  // abort | warn（prune 未实现）
  preflightPolicy: pick('PREFLIGHT_POLICY', envCfg.preflightPolicy || 'warn'),

  scenario,
  thresholds: stripComments(profileCfg.thresholds),
  profileDescription: profileCfg.description || '',
};
