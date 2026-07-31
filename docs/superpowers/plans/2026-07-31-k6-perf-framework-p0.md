# k6 性能测试框架 P0 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 qa 仓库 `perf/` 目录建成 k6 性能测试框架 P0：trades-query / trades-create 两个场景、Prometheus remote write 集成、k8s Job 执行层（run.sh + --tags 筛选）、JSON/HTML 报告。

**Architecture:** 框架分两层——纯逻辑模块（config/users/data/payloads/profiles/sla/report，零 k6 依赖）与 k6 依赖层（http/metrics/api/scenarios）。执行层为普通 k8s Job（envsubst 渲染模板），报告经 stdout 标记从日志提取。本地验证手段为 `k6 inspect`（执行完整 init：全部 import 与 `open()`，不发压）、`run.sh --dry-run` 与 JSON 校验；真实环境首跑 smoke 即框架首次端到端验证。设计依据：`qa/docs/superpowers/specs/2026-07-31-k6-perf-framework-design.md`。

**Tech Stack:** k6（本地 ≥0.55）、Node ≥20（仅作 run.sh 辅助解析，零 npm 依赖）、bash、kubectl + envsubst、Prometheus remote write、Grafana。

## Global Constraints

- 所有路径相对 `qa/perf/`；所有命令默认在 `qa/perf/` 下执行；提交在 qa 仓库进行。
- **不交付**：mock 服务、Dockerfile、单元测试文件（用户明确裁剪）。k8s 镜像/脚本注入由公司侧机制提供（见环境清单）。
- **占位符纪律**：仓库内一切主机地址统一用 `localhost` 占位，业务数据（counterparty、身份账号等）统一用明显的假值；真实值仅在公司内网填写，不入库。
- **离线约束**：任何脚本不得 import 远程 jslib；只允许 k6 内置模块与本仓库文件。
- **纯逻辑模块**（`src/lib/config.js`、`src/lib/users.js`、`src/lib/data.js`、`src/payloads/factory.js`、`src/profiles/index.js`、`src/lib/sla.js`、`src/lib/report.js`）**禁止 import `k6/*`**；k6 依赖模块仅限 `src/lib/http.js`、`src/lib/metrics.js`、`src/api/**`、`src/scenarios/**`。
- 指标 tag 约定：每个请求必须带 `name`、`service`、`module` tag；`testid` 由 run.sh 通过 `--tag testid=<testid>` 注入。
- 每个任务至少一次 git 提交，提交信息格式 `feat(perf): ...` / `docs(perf): ...`。
- 已知接口事实：`POST /api/v1/trades/create` 为 multipart/form-data，含 `trade`（JSON 字符串）与 `datFile`（二进制）两个 part；身份经 `X-User-Id` 请求头传递，角色分 maker / checker。

---

### Task 1: 脚手架与配置文件

**Files:**
- Create: `perf/package.json`、`perf/.gitignore`、`perf/config/environments/local.json`、`perf/config/environments/dev.json`、`perf/config/slas/trade-svc/trades.json`、`perf/data/params/counterparties.json`、`perf/data/params/query-filters.json`、`perf/data/datfiles/FX_TRF.dat`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - 环境文件结构：`{ name, whitelist: string[], promRwUrl: string, services: {svc: url}, users: {maker: string[], checker: string[]} }`
  - SLA 文件结构：`{ query: {name,p95,p99,errorRate}, create: {...} }`
  - `package.json` 仅声明 `"type": "module"`（让 Node 以 ESM 加载 `src/lib/*.js`，供 tools 复用报告模块；不引入任何依赖与测试脚本）

- [ ] **Step 1: 建目录与文件**

```bash
mkdir -p perf/config/environments perf/config/slas/trade-svc perf/data/params perf/data/datfiles
```

`perf/package.json`：

```json
{
  "name": "perf-framework",
  "private": true,
  "type": "module"
}
```

`perf/.gitignore`：

```
reports/
```

`perf/config/environments/local.json`：

```json
{
  "name": "local",
  "whitelist": ["localhost", "127.0.0.1"],
  "promRwUrl": "",
  "services": { "trade-svc": "http://localhost:9089" },
  "users": {
    "maker": ["maker1@example.com", "maker2@example.com"],
    "checker": ["checker1@example.com"]
  }
}
```

`perf/config/environments/dev.json`（**主机与账号均为占位符**，内网启用时填真实值并同步 whitelist——见环境清单）：

```json
{
  "name": "dev",
  "whitelist": ["localhost", "127.0.0.1"],
  "promRwUrl": "",
  "services": { "trade-svc": "http://localhost:9089" },
  "users": {
    "maker": ["maker1@example.com", "maker2@example.com"],
    "checker": ["checker1@example.com"]
  }
}
```

（`promRwUrl` 留空是运行时行为开关：为空时 run.sh 不挂 Prometheus 输出，等运维给出 remote-write receiver 地址后填入即生效——对应 spec 遗留问题 #1。）

`perf/config/slas/trade-svc/trades.json`（数值为占位水位，spec 遗留问题 #2 确认后调整）：

```json
{
  "query": { "name": "GET /api/v1/trades", "p95": 300, "p99": 800, "errorRate": 0.01 },
  "create": { "name": "POST /api/v1/trades/create", "p95": 800, "p99": 2000, "errorRate": 0.01 }
}
```

`perf/data/params/counterparties.json`（占位数据）：

```json
[
  { "counterpartyFmId": "CP-000001", "counterpartyName": "PERF CP A" },
  { "counterpartyFmId": "CP-000002", "counterpartyName": "PERF CP B" }
]
```

`perf/data/params/query-filters.json`：

```json
[
  { "status": "LIVE" },
  { "status": "PENDING" },
  { "counterpartyFmId": "CP-000001" },
  {}
]
```

```bash
printf 'PLACEHOLDER FX TRF DAT - replace with real template inside company network\n' > perf/data/datfiles/FX_TRF.dat
```

- [ ] **Step 2: 校验全部 JSON 可解析**

Run:

```bash
cd perf && node -e "
for (const f of ['config/environments/local.json','config/environments/dev.json','config/slas/trade-svc/trades.json','data/params/counterparties.json','data/params/query-filters.json'])
  JSON.parse(require('fs').readFileSync(f,'utf8'));
console.log('all valid')"
```

Expected: `all valid`

- [ ] **Step 3: 提交**

```bash
git add perf/package.json perf/.gitignore perf/config perf/data
git commit -m "feat(perf): 框架脚手架与配置（环境/SLA/参数池，全部占位数据）"
```

---

### Task 2: 纯逻辑模块

**Files:**
- Create: `perf/src/lib/config.js`、`perf/src/lib/users.js`、`perf/src/lib/data.js`、`perf/src/payloads/factory.js`、`perf/src/profiles/index.js`、`perf/src/lib/sla.js`、`perf/src/lib/report.js`

**Interfaces:**
- Consumes: Task 1 的配置文件结构
- Produces（后续任务按此签名调用）:
  - `parseEnvConfig(rawText) -> cfg`；`assertWhitelisted(url, whitelist, label?)`；`serviceBaseUrl(cfg, service) -> string`
  - `pickUser(cfg, role, vu) -> string`；`pick(pool, vu, iter) -> any`
  - `datFileFor(product) -> string`；`uniqueRef(vu, iter, runId) -> string`；`buildTradePart(counterparties, vu, iter, runId) -> object`
  - `buildProfile(name, env) -> k6 scenario 对象`（识别 `RATE`/`DURATION`/`MAX_VUS`，maxVUs 硬上限 500，全 arrival-rate）
  - `buildThresholds(slaEntry) -> k6 thresholds 对象`（含 `abortOnFail` 熔断）
  - `summarize(data, testid) -> summary`；`toMarkers(summary) -> string`；`fromLogs(text) -> summary`；`toHtml(summary) -> string`

- [ ] **Step 1: 实现 config.js** `perf/src/lib/config.js`

```js
// 纯配置解析与白名单校验。文件读取发生在场景脚本的 init 阶段（k6 open()），
// 这里只处理文本 —— 因此本模块可同时被 k6 与 Node 加载。
// 注意：k6 运行时没有 WHATWG URL，主机名用字符串解析。
function hostOf(url) {
  return url.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
}

export function assertWhitelisted(url, whitelist, label = url) {
  const host = hostOf(url);
  const ok = whitelist.some((w) => host === w || host.endsWith(`.${w}`));
  if (!ok) throw new Error(`target not whitelisted: ${label} -> ${host}`);
}

export function parseEnvConfig(rawText) {
  const cfg = JSON.parse(rawText);
  for (const key of ['name', 'whitelist', 'promRwUrl', 'services', 'users']) {
    if (!(key in cfg)) throw new Error(`config missing field: ${key}`);
  }
  for (const [svc, url] of Object.entries(cfg.services)) {
    assertWhitelisted(url, cfg.whitelist, svc);
  }
  return cfg;
}

export function serviceBaseUrl(cfg, service) {
  const url = cfg.services[service];
  if (!url) throw new Error(`unknown service: ${service}`);
  return url;
}
```

- [ ] **Step 2: 实现 users.js 与 data.js**

`perf/src/lib/users.js`：

```js
// 身份池：系统无 token 认证，统一 X-User-Id 头。按 VU 轮询保证多身份分布且同 VU 稳定。
export function pickUser(cfg, role, vu) {
  const pool = (cfg.users || {})[role];
  if (!pool || pool.length === 0) throw new Error(`no users for role: ${role}`);
  return pool[Math.abs(vu) % pool.length];
}
```

`perf/src/lib/data.js`：

```js
// 参数池确定性选取：vu*31+iter 让不同 VU/迭代散布到不同参数，避免全场压同一条热点。
export function pick(pool, vu, iter) {
  if (!Array.isArray(pool) || pool.length === 0) throw new Error('empty param pool');
  return pool[(Math.abs(vu) * 31 + Math.abs(iter)) % pool.length];
}
```

- [ ] **Step 3: 实现 payload 工厂** `perf/src/payloads/factory.js`

```js
import { pick } from '../lib/data.js';

// 产品类型 → dat 模板文件。扩产品 = data/datfiles/ 加文件 + 此处注册。
const DAT_BY_PRODUCT = { TRF: 'FX_TRF.dat' };

export function datFileFor(product) {
  const f = DAT_BY_PRODUCT[product];
  if (!f) throw new Error(`no dat template for product: ${product}`);
  return f;
}

export function uniqueRef(vu, iter, runId) {
  return `PERF-${runId}-${vu}-${iter}`;
}

// trade JSON part。字段集合对齐真实 create 接口；
// portfolioId=PERF_TEST 是压测数据标记（spec 遗留问题 #3，字段可换）；
// clientRef 承载唯一标记（真实字段名待确认，spec 遗留问题 #3/#4）。
export function buildTradePart(counterparties, vu, iter, runId) {
  const cp = pick(counterparties, vu, iter);
  return {
    basic: {
      portfolioId: 'PERF_TEST',
      counterpartyFmId: cp.counterpartyFmId,
      counterpartyName: cp.counterpartyName,
      notionalCurrency: '',
      clientRef: uniqueRef(vu, iter, runId),
    },
  };
}
```

- [ ] **Step 4: 实现负载 profile 构建器** `perf/src/profiles/index.js`

```js
// 五种标准负载形状。默认 open model（arrival-rate）：被测系统变慢时压力不衰减，
// 避免 coordinated omission。RATE/DURATION/MAX_VUS 可经 __ENV 覆盖。
const HARD_MAX_VUS = 500;

const PROFILES = {
  smoke: () => ({
    executor: 'constant-arrival-rate',
    rate: 2, timeUnit: '1s', duration: '1m',
    preAllocatedVUs: 5, maxVUs: 10,
  }),
  load: (o) => ({
    executor: 'ramping-arrival-rate',
    startRate: 0, timeUnit: '1s',
    preAllocatedVUs: 20, maxVUs: o.maxVUs,
    stages: [
      { duration: '2m', target: o.rate },
      { duration: o.duration, target: o.rate },
      { duration: '1m', target: 0 },
    ],
  }),
  stress: (o) => ({
    executor: 'ramping-arrival-rate',
    startRate: 0, timeUnit: '1s',
    preAllocatedVUs: 50, maxVUs: o.maxVUs,
    stages: [
      { duration: '2m', target: o.rate },
      { duration: '2m', target: o.rate * 2 },
      { duration: '2m', target: o.rate * 3 },
      { duration: '2m', target: o.rate * 4 },
      { duration: '1m', target: 0 },
    ],
  }),
  spike: (o) => ({
    executor: 'ramping-arrival-rate',
    startRate: 0, timeUnit: '1s',
    preAllocatedVUs: 50, maxVUs: o.maxVUs,
    stages: [
      { duration: '10s', target: o.rate * 5 },
      { duration: '1m', target: o.rate * 5 },
      { duration: '10s', target: o.rate },
      { duration: '2m', target: o.rate },
    ],
  }),
  soak: (o) => ({
    executor: 'constant-arrival-rate',
    rate: o.rate, timeUnit: '1s', duration: '2h',
    preAllocatedVUs: 30, maxVUs: o.maxVUs,
  }),
};

export function buildProfile(name, env = {}) {
  const make = PROFILES[name];
  if (!make) throw new Error(`unknown profile: ${name} (want ${Object.keys(PROFILES).join('/')})`);
  const o = {
    rate: Number(env.RATE || 20),
    duration: env.DURATION || '10m',
    maxVUs: Math.min(Number(env.MAX_VUS || 100), HARD_MAX_VUS),
  };
  return make(o);
}
```

- [ ] **Step 5: 实现 SLA 构建器** `perf/src/lib/sla.js`

```js
// SLA 条目 → k6 thresholds。错误率阈值 abortOnFail：被测环境劣化到阈值即停止施压，
// 保护共享环境（延迟 30s 评估，避开启动抖动误杀）。
export function buildThresholds(s) {
  for (const k of ['name', 'p95', 'p99', 'errorRate']) {
    if (!(k in s)) throw new Error(`SLA missing ${k}`);
  }
  return {
    [`http_req_duration{name:${s.name}}`]: [`p(95)<${s.p95}`, `p(99)<${s.p99}`],
    http_req_failed: [{ threshold: `rate<${s.errorRate}`, abortOnFail: true, delayAbortEval: '30s' }],
    checks: ['rate>0.99'],
  };
}
```

- [ ] **Step 6: 实现报告模块** `perf/src/lib/report.js`

```js
// 报告纯逻辑：k6 与 Node 双端可加载。
// 链路：场景 handleSummary 用 toMarkers 写 stdout → run.sh 从日志提取（fromLogs）
// → 存 reports/<testid>.json → render-report 生成 HTML。
// （Job Pod 结束后 kubectl cp 拿不到容器内文件，故走 stdout。）
const START = '==K6_SUMMARY_JSON_START==';
const END = '==K6_SUMMARY_JSON_END==';

function val(data, name, key, dflt) {
  const m = data.metrics[name];
  return m && m.values && m.values[key] !== undefined ? m.values[key] : dflt;
}

export function summarize(data, testid) {
  return {
    testid,
    requests: val(data, 'http_reqs', 'count', 0),
    rps: val(data, 'http_reqs', 'rate', 0),
    latencyMs: {
      p50: val(data, 'http_req_duration', 'med', null),
      p95: val(data, 'http_req_duration', 'p(95)', null),
      p99: val(data, 'http_req_duration', 'p(99)', null),
    },
    errorRate: val(data, 'http_req_failed', 'rate', 0),
    checksRate: val(data, 'checks', 'rate', 1),
    thresholdFailures: Object.entries(data.metrics)
      .filter(([, m]) => m.thresholds && Object.values(m.thresholds).some((t) => !t.ok))
      .map(([name]) => name),
  };
}

export function toMarkers(summary) {
  return `\n${START}\n${JSON.stringify(summary)}\n${END}\n`;
}

export function fromLogs(text) {
  const i = text.lastIndexOf(START);
  const j = text.lastIndexOf(END);
  if (i === -1 || j === -1 || j < i) throw new Error('no summary markers in logs');
  return JSON.parse(text.slice(i + START.length, j).trim());
}

export function toHtml(s) {
  const verdict = s.thresholdFailures.length === 0 ? 'PASS' : 'FAIL';
  const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  return `<!doctype html><meta charset="utf-8"><title>${s.testid}</title>
<h1>${s.testid} &mdash; ${verdict}</h1><table border="1" cellpadding="6">
${row('requests', s.requests)}${row('rps', Number(s.rps).toFixed(1))}
${row('p50 (ms)', s.latencyMs.p50)}${row('p95 (ms)', s.latencyMs.p95)}${row('p99 (ms)', s.latencyMs.p99)}
${row('error rate', s.errorRate)}${row('checks rate', s.checksRate)}
${row('failed thresholds', s.thresholdFailures.join(', ') || 'none')}
</table>`;
}
```

- [ ] **Step 7: 加载性验证（非测试文件，一次性命令）**

Run:

```bash
cd perf && node --input-type=module -e "
import { parseEnvConfig, serviceBaseUrl } from './src/lib/config.js';
import { pickUser } from './src/lib/users.js';
import { buildTradePart, datFileFor } from './src/payloads/factory.js';
import { buildProfile } from './src/profiles/index.js';
import { buildThresholds } from './src/lib/sla.js';
import { toMarkers, fromLogs } from './src/lib/report.js';
import { readFileSync } from 'node:fs';
const cfg = parseEnvConfig(readFileSync('config/environments/local.json','utf8'));
serviceBaseUrl(cfg, 'trade-svc');
pickUser(cfg, 'maker', 1);
datFileFor('TRF');
buildTradePart(JSON.parse(readFileSync('data/params/counterparties.json','utf8')), 1, 0, 'r1');
buildProfile('load', { RATE: '50' });
buildThresholds(JSON.parse(readFileSync('config/slas/trade-svc/trades.json','utf8')).query);
const s = { testid: 't', thresholdFailures: [] };
fromLogs('x' + toMarkers(s) + 'y');
console.log('all modules load & run');
"
```

Expected: `all modules load & run`

- [ ] **Step 8: 提交**

```bash
git add perf/src/lib perf/src/payloads perf/src/profiles
git commit -m "feat(perf): 纯逻辑模块（配置/身份/参数/工厂/profile/SLA/报告）"
```

---

### Task 3: k6 客户端层与两个 P0 场景

**Files:**
- Create: `perf/src/lib/metrics.js`、`perf/src/lib/http.js`、`perf/src/api/trade-svc/trades.js`、`perf/src/scenarios/trades-query.js`、`perf/src/scenarios/trades-create.js`

**Interfaces:**
- Consumes: Task 2 全部纯逻辑模块
- Produces:
  - `metrics.js`：`bookingDuration`（Trend `trade_booking_duration`）、`bookingErrors`（Counter `trade_booking_errors`）、`bizErrors`（Counter `business_errors`）
  - `http.js`：`get(cfg, service, path, opts)` / `postJson(cfg, service, path, body, opts)` / `postMultipart(cfg, service, path, formData, opts)`；opts = `{name(必填), module, user, params, headers, bizCheck}`
  - `api/trade-svc/trades.js`：`queryTrades(cfg, filter, user) -> res`、`createTrade(cfg, tradePart, datBin, datName, user) -> res`
  - 场景约定（后续场景照此模板）：`export const meta = {tags:[...]}`（静态字面量）；init 阶段 `open()` 配置/SLA/参数池；`options = {scenarios:{main: buildProfile(...)}, thresholds, summaryTrendStats}`；`export default function` 一次业务动作；`handleSummary` 输出标记 JSON

- [ ] **Step 1: 确认 k6 已安装**

Run: `k6 version || brew install k6 && k6 version`
Expected: 输出 k6 版本（≥ v0.55）

- [ ] **Step 2: 实现 metrics.js** `perf/src/lib/metrics.js`

```js
import { Trend, Counter } from 'k6/metrics';

// 业务级指标：区分「HTTP 层健康」与「业务层健康」
export const bookingDuration = new Trend('trade_booking_duration', true);
export const bookingErrors = new Counter('trade_booking_errors');
export const bizErrors = new Counter('business_errors');
```

- [ ] **Step 3: 实现 http.js** `perf/src/lib/http.js`

```js
import k6http from 'k6/http';
import { check } from 'k6';
import { serviceBaseUrl } from './config.js';
import { bizErrors } from './metrics.js';

// 统一 HTTP 管道：所有 API 调用唯一出口。
// opts: { name(必填,指标tag), module, user, params(query对象), headers, bizCheck(res=>bool) }
function request(method, cfg, service, path, body, opts) {
  if (!opts || !opts.name) throw new Error('http: opts.name tag is required');
  const entries = opts.params ? Object.entries(opts.params) : [];
  const qs = entries.length
    ? '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    : '';
  const url = serviceBaseUrl(cfg, service) + path + qs;
  const params = {
    headers: Object.assign(
      { Accept: 'application/json' },
      opts.user ? { 'X-User-Id': opts.user } : {},
      opts.headers || {},
    ),
    tags: { name: opts.name, service, module: opts.module || 'default' },
  };
  const res = method === 'GET' ? k6http.get(url, params) : k6http.post(url, body, params);
  const httpOk = res.status >= 200 && res.status < 300;
  const bizOk = httpOk && (!opts.bizCheck || opts.bizCheck(res));
  check(res, { [`${opts.name} ok`]: () => bizOk });
  if (httpOk && !bizOk) bizErrors.add(1, params.tags);
  return res;
}

export function get(cfg, service, path, opts) {
  return request('GET', cfg, service, path, null, opts);
}

export function postJson(cfg, service, path, body, opts) {
  const o = Object.assign({}, opts);
  o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
  return request('POST', cfg, service, path, JSON.stringify(body), o);
}

export function postMultipart(cfg, service, path, formData, opts) {
  // k6 对含 http.file 的对象 body 自动生成 multipart 边界
  return request('POST', cfg, service, path, formData, opts);
}
```

- [ ] **Step 4: 实现 API 客户端层** `perf/src/api/trade-svc/trades.js`

```js
import http from 'k6/http';
import * as client from '../../lib/http.js';
import { bookingDuration, bookingErrors } from '../../lib/metrics.js';

const SVC = 'trade-svc';
const MOD = 'trades';

export function queryTrades(cfg, filter, user) {
  return client.get(cfg, SVC, '/api/v1/trades', {
    name: 'GET /api/v1/trades', module: MOD, user, params: filter,
    bizCheck: (r) => r.json('trades') !== undefined,
  });
}

export function createTrade(cfg, tradePart, datBin, datName, user) {
  const form = {
    trade: JSON.stringify(tradePart),
    datFile: http.file(datBin, datName, 'application/octet-stream'),
  };
  const res = client.postMultipart(cfg, SVC, '/api/v1/trades/create', form, {
    name: 'POST /api/v1/trades/create', module: MOD, user,
    bizCheck: (r) => r.json('tradeId') !== undefined,
  });
  bookingDuration.add(res.timings.duration);
  if (res.status < 200 || res.status >= 300) bookingErrors.add(1);
  return res;
}
```

（`bizCheck` 中 create 响应含 `tradeId` 的假设需在真实环境首跑时核对，已列入环境清单。）

- [ ] **Step 5: 实现 trades-query 场景** `perf/src/scenarios/trades-query.js`

```js
import { parseEnvConfig } from '../lib/config.js';
import { buildProfile } from '../profiles/index.js';
import { buildThresholds } from '../lib/sla.js';
import { pickUser } from '../lib/users.js';
import { pick } from '../lib/data.js';
import { queryTrades } from '../api/trade-svc/trades.js';
import { summarize, toMarkers } from '../lib/report.js';

export const meta = { tags: ['P0', 'trade-svc', 'read'] };

const ENV = __ENV.ENV || 'local';
const cfg = parseEnvConfig(open(`../../config/environments/${ENV}.json`));
const SLA = JSON.parse(open('../../config/slas/trade-svc/trades.json'));
const FILTERS = JSON.parse(open('../../data/params/query-filters.json'));

export const options = {
  scenarios: { main: buildProfile(__ENV.PROFILE || 'smoke', __ENV) },
  thresholds: buildThresholds(SLA.query),
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)'],
};

export default function () {
  const user = pickUser(cfg, 'maker', __VU);
  const filter = pick(FILTERS, __VU, __ITER);
  queryTrades(cfg, filter, user);
}

export function handleSummary(data) {
  return { stdout: toMarkers(summarize(data, __ENV.TESTID || 'local-run')) };
}
```

- [ ] **Step 6: 实现 trades-create 场景** `perf/src/scenarios/trades-create.js`

```js
import { parseEnvConfig } from '../lib/config.js';
import { buildProfile } from '../profiles/index.js';
import { buildThresholds } from '../lib/sla.js';
import { pickUser } from '../lib/users.js';
import { buildTradePart, datFileFor } from '../payloads/factory.js';
import { createTrade } from '../api/trade-svc/trades.js';
import { summarize, toMarkers } from '../lib/report.js';

export const meta = { tags: ['P0', 'trade-svc', 'write'] };

const ENV = __ENV.ENV || 'local';
const PRODUCT = __ENV.PRODUCT || 'TRF';
const RUN_ID = __ENV.TESTID || 'local-run';
const cfg = parseEnvConfig(open(`../../config/environments/${ENV}.json`));
const SLA = JSON.parse(open('../../config/slas/trade-svc/trades.json'));
const CPS = JSON.parse(open('../../data/params/counterparties.json'));
const DAT_NAME = datFileFor(PRODUCT);
const DAT_BIN = open(`../../data/datfiles/${DAT_NAME}`, 'b');

export const options = {
  scenarios: { main: buildProfile(__ENV.PROFILE || 'smoke', __ENV) },
  thresholds: buildThresholds(SLA.create),
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)'],
};

export default function () {
  const user = pickUser(cfg, 'maker', __VU);
  const trade = buildTradePart(CPS, __VU, __ITER, RUN_ID);
  createTrade(cfg, trade, DAT_BIN, DAT_NAME, user);
}

export function handleSummary(data) {
  return { stdout: toMarkers(summarize(data, RUN_ID)) };
}
```

- [ ] **Step 7: k6 inspect 验证（执行完整 init，不发压）**

Run:

```bash
cd perf
k6 inspect -e ENV=local src/scenarios/trades-query.js
k6 inspect -e ENV=local src/scenarios/trades-create.js
```

Expected: 两个场景均输出解析后的 options JSON（可见 scenarios.main 与 thresholds）、退出码 0。inspect 会真实执行全部 import 与 `open()`——验证模块图、配置文件路径、dat 文件加载、profile/SLA 构建全链路。
（若 `open()` 报路径错误：k6 的 open 相对主脚本目录解析，确认从 `perf/` 目录执行且路径为 `../../config/...`。）

- [ ] **Step 8: 提交**

```bash
git add perf/src/lib/metrics.js perf/src/lib/http.js perf/src/api perf/src/scenarios
git commit -m "feat(perf): k6 客户端层（三动词统一管道）与 trades-query/trades-create 场景"
```

---

### Task 4: 场景 meta 提取器、run.sh 与 k8s Job 模板

**Files:**
- Create: `perf/tools/scenario-meta.mjs`、`perf/tools/extract-summary.mjs`、`perf/tools/render-report.mjs`、`perf/deploy/run.sh`（可执行）、`perf/deploy/job.yaml`

**Interfaces:**
- Consumes: Task 2 `fromLogs`/`toHtml`；Task 3 场景的静态 `meta` 约定与环境文件
- Produces:
  - `extractMeta(source) -> object|null`；`listScenarios(dir, requiredTags) -> string[]`（AND 语义，按文件名排序）；CLI `node tools/scenario-meta.mjs <dir> <tag1,tag2>`
  - CLI `node tools/extract-summary.mjs <run.log> <out.json>`；`node tools/render-report.mjs <summary.json>`（生成同名 .html）
  - `./deploy/run.sh (-s <scenario> | --tags <t1,t2>) [-p profile] [-e env] [-r rate] [-d duration] [--local] [--dry-run]`：`--tags` 由 run.sh 消费不传给 k6；k6 `--tag testid=` 由 run.sh 注入；`promRwUrl` 非空才挂 prometheus 输出（k8s 经 `K6_OUT`）；多场景串行、独立 testid/报告、汇总表、任一 FAIL 退出码 1
  - `job.yaml` envsubst 变量：`TESTID SCENARIO PROFILE ENV_NAME IMAGE PROM_RW_URL K6_OUT_VALUE RATE_OPT DURATION_OPT`；`ttlSecondsAfterFinished: 3600`、`backoffLimit: 0`、limits cpu 2 / mem 2Gi；镜像来源与脚本注入方式为公司侧实施项（环境清单）

- [ ] **Step 1: 实现 scenario-meta.mjs** `perf/tools/scenario-meta.mjs`

```js
// Cucumber 风格 tag 筛选的基础：从场景源码提取 `export const meta = {...};`。
// 场景文件 import 了 k6 模块，Node 无法直接执行，因此靠源码解析 + 字面量求值。
// 约束：meta 必须是静态对象字面量（不嵌套对象）。
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

export function extractMeta(source) {
  const m = source.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!m) return null;
  return new Function(`return (${m[1]});`)();
}

export function listScenarios(dir, requiredTags) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => ({
      name: basename(f, '.js'),
      meta: extractMeta(readFileSync(join(dir, f), 'utf8')),
    }))
    .filter((s) => s.meta && Array.isArray(s.meta.tags)
      && requiredTags.every((t) => s.meta.tags.includes(t)))
    .map((s) => s.name);
}

if (process.argv[1] && process.argv[1].endsWith('scenario-meta.mjs')) {
  const [dir, tags] = process.argv.slice(2);
  const names = listScenarios(dir || 'src/scenarios', (tags || '').split(',').filter(Boolean));
  for (const n of names) console.log(n);
}
```

- [ ] **Step 2: 实现报告提取/渲染 CLI**

`perf/tools/extract-summary.mjs`：

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { fromLogs } from '../src/lib/report.js';

const [logPath, outPath] = process.argv.slice(2);
if (!logPath || !outPath) {
  console.error('usage: node tools/extract-summary.mjs <run.log> <out.json>');
  process.exit(2);
}
const summary = fromLogs(readFileSync(logPath, 'utf8'));
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(outPath);
```

`perf/tools/render-report.mjs`：

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { toHtml } from '../src/lib/report.js';

const jsonPath = process.argv[2];
if (!jsonPath) {
  console.error('usage: node tools/render-report.mjs reports/<testid>.json');
  process.exit(2);
}
const summary = JSON.parse(readFileSync(jsonPath, 'utf8'));
const out = jsonPath.replace(/\.json$/, '.html');
writeFileSync(out, toHtml(summary));
console.log(out);
```

- [ ] **Step 3: 写 job.yaml** `perf/deploy/job.yaml`

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: k6-${TESTID}
  labels:
    app: k6-perf
    testid: "${TESTID}"
spec:
  ttlSecondsAfterFinished: 3600
  backoffLimit: 0
  template:
    metadata:
      labels:
        app: k6-perf
        testid: "${TESTID}"
    spec:
      restartPolicy: Never
      containers:
        - name: k6
          image: ${IMAGE}
          workingDir: /perf
          command: ["k6", "run",
            "--tag", "testid=${TESTID}",
            "-e", "ENV=${ENV_NAME}",
            "-e", "PROFILE=${PROFILE}",
            "-e", "TESTID=${TESTID}",
            "-e", "RATE=${RATE_OPT}",
            "-e", "DURATION=${DURATION_OPT}",
            "src/scenarios/${SCENARIO}.js"]
          env:
            - name: K6_OUT
              value: "${K6_OUT_VALUE}"
            - name: K6_PROMETHEUS_RW_SERVER_URL
              value: "${PROM_RW_URL}"
            - name: K6_PROMETHEUS_RW_TREND_STATS
              value: "p(95),p(99)"
          resources:
            requests:
              cpu: "1"
              memory: "1Gi"
            limits:
              cpu: "2"
              memory: "2Gi"
```

（镜像 `${IMAGE}` 须内含 k6 与 `/perf` 下的 config/src/data；镜像构建或 ConfigMap 挂载由公司侧实施——本仓库不交付 Dockerfile，见环境清单。）

- [ ] **Step 4: 写 run.sh** `perf/deploy/run.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."   # 定位到 perf/ 根

SCENARIO="" TAGS="" PROFILE="smoke" ENV_NAME="local" RATE="" DURATION="" LOCAL=0 DRY=0
IMAGE="${K6_IMAGE:-perf-k6:latest}"
NAMESPACE="${K6_NAMESPACE:-perf}"

usage() {
  cat <<'EOF'
用法: deploy/run.sh (-s <scenario> | --tags <t1,t2>) [-p profile] [-e env] [-r rate] [-d duration] [--local] [--dry-run]
  -s        单场景名（src/scenarios/<name>.js）
  --tags    按场景 meta.tags 过滤批量执行（逗号=与）
  -p        负载 profile: smoke|load|stress|spike|soak（默认 smoke）
  -e        环境名（config/environments/<env>.json，默认 local）
  -r / -d   覆盖目标速率 / 稳态时长
  --local   本机 k6 直跑（默认提交 k8s Job）
  --dry-run 只打印将执行的命令/渲染的 manifest
注意: --tags 是本脚本参数，与 k6 的 --tag（指标标签）无关，不会传给 k6。
EOF
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s) SCENARIO="$2"; shift 2 ;;
    --tags) TAGS="$2"; shift 2 ;;
    -p) PROFILE="$2"; shift 2 ;;
    -e) ENV_NAME="$2"; shift 2 ;;
    -r) RATE="$2"; shift 2 ;;
    -d) DURATION="$2"; shift 2 ;;
    --local) LOCAL=1; shift ;;
    --dry-run) DRY=1; shift ;;
    *) usage ;;
  esac
done

[[ -n "$SCENARIO" && -n "$TAGS" ]] && usage
[[ -z "$SCENARIO" && -z "$TAGS" ]] && usage
[[ -f "config/environments/${ENV_NAME}.json" ]] || { echo "未知环境: ${ENV_NAME}" >&2; exit 1; }

PROM_RW_URL="$(node -p "JSON.parse(require('fs').readFileSync('config/environments/${ENV_NAME}.json','utf8')).promRwUrl || ''")"
K6_OUT_VALUE=""
[[ -n "$PROM_RW_URL" ]] && K6_OUT_VALUE="experimental-prometheus-rw"

if [[ -n "$TAGS" ]]; then
  SCENARIOS="$(node tools/scenario-meta.mjs src/scenarios "$TAGS")"
  [[ -z "$SCENARIOS" ]] && { echo "没有场景匹配 tags: $TAGS" >&2; exit 1; }
else
  [[ -f "src/scenarios/${SCENARIO}.js" ]] || { echo "场景不存在: ${SCENARIO}" >&2; exit 1; }
  SCENARIOS="$SCENARIO"
fi

mkdir -p reports
SUMMARY_ROWS=()

postprocess() {
  local testid="$1"
  node tools/extract-summary.mjs "reports/${testid}.log" "reports/${testid}.json"
  node tools/render-report.mjs "reports/${testid}.json"
}

run_local() {
  local sc="$1" testid="$2"
  local args=(run --tag "testid=${testid}" -e "ENV=${ENV_NAME}" -e "PROFILE=${PROFILE}" -e "TESTID=${testid}")
  [[ -n "$RATE" ]] && args+=(-e "RATE=${RATE}")
  [[ -n "$DURATION" ]] && args+=(-e "DURATION=${DURATION}")
  [[ -n "$PROM_RW_URL" ]] && args+=(-o experimental-prometheus-rw)
  if [[ "$DRY" == 1 ]]; then
    echo "DRY(local): k6 ${args[*]} src/scenarios/${sc}.js"
    return 0
  fi
  K6_PROMETHEUS_RW_SERVER_URL="$PROM_RW_URL" K6_PROMETHEUS_RW_TREND_STATS="p(95),p(99)" \
    k6 "${args[@]}" "src/scenarios/${sc}.js" 2>&1 | tee "reports/${testid}.log" || true
  postprocess "$testid"
}

run_k8s() {
  local sc="$1" testid="$2"
  export TESTID="$testid" SCENARIO="$sc" PROFILE ENV_NAME IMAGE PROM_RW_URL K6_OUT_VALUE
  export RATE_OPT="${RATE:-}" DURATION_OPT="${DURATION:-}"
  if [[ "$DRY" == 1 ]]; then
    envsubst < deploy/job.yaml
    return 0
  fi
  envsubst < deploy/job.yaml | kubectl -n "$NAMESPACE" apply -f -
  kubectl -n "$NAMESPACE" wait --for=condition=complete --timeout=4h "job/k6-${testid}" || true
  kubectl -n "$NAMESPACE" logs "job/k6-${testid}" > "reports/${testid}.log"
  postprocess "$testid"
}

for sc in $SCENARIOS; do
  TESTID="${sc}-$(date +%Y%m%d-%H%M%S)"
  echo "==> ${sc} (testid=${TESTID}, profile=${PROFILE}, env=${ENV_NAME})"
  if [[ "$LOCAL" == 1 ]]; then run_local "$sc" "$TESTID"; else run_k8s "$sc" "$TESTID"; fi
  if [[ "$DRY" == 0 && -f "reports/${TESTID}.json" ]]; then
    VERDICT="$(node -p "JSON.parse(require('fs').readFileSync('reports/${TESTID}.json','utf8')).thresholdFailures.length ? 'FAIL' : 'PASS'")"
    SUMMARY_ROWS+=("${VERDICT}  ${sc}  reports/${TESTID}.html")
  fi
  sleep 1   # 保证下一个 testid 时间戳不同
done

if [[ "$DRY" == 0 && "${#SUMMARY_ROWS[@]}" -gt 0 ]]; then
  echo
  echo "==== 汇总 ===="
  printf '%s\n' "${SUMMARY_ROWS[@]}"
  for r in "${SUMMARY_ROWS[@]}"; do
    [[ "$r" == FAIL* ]] && exit 1
  done
fi
exit 0
```

```bash
chmod +x perf/deploy/run.sh
```

- [ ] **Step 5: 验证**

前置：macOS 若无 envsubst，先 `brew install gettext && brew link --force gettext`（envsubst 属 gettext 包）。

Run: `cd perf && bash -n deploy/run.sh && node --check tools/scenario-meta.mjs && node --check tools/extract-summary.mjs && node --check tools/render-report.mjs && echo syntax-ok`
Expected: `syntax-ok`

Run: `cd perf && node tools/scenario-meta.mjs src/scenarios P0`
Expected: 输出 `trades-create` 与 `trades-query` 各一行（按文件名排序）。

Run: `cd perf && ./deploy/run.sh --tags P0 -p load -e dev --dry-run`
Expected: 依次输出两份渲染后的 Job manifest；含 `name: k6-trades-create-` 与 `name: k6-trades-query-`、`ENV=dev`、`PROFILE=load`；`K6_OUT` 值为空（dev 的 promRwUrl 为空）。

Run: `cd perf && ./deploy/run.sh -s trades-query -p smoke -e local --local --dry-run`
Expected: 一行 `DRY(local): k6 run --tag testid=trades-query-... src/scenarios/trades-query.js`，不含 `--tags`、不含 `-o experimental-prometheus-rw`。

Run: `cd perf && ./deploy/run.sh --tags NOPE -e local --dry-run; echo "exit=$?"`
Expected: `没有场景匹配 tags: NOPE`，exit=1。

- [ ] **Step 6: 提交**

```bash
git add perf/tools perf/deploy
git commit -m "feat(perf): run.sh（tag 筛选/本地与 k8s 双路径/汇总表）、Job 模板与报告工具"
```

---

### Task 5: Grafana dashboards

**Files:**
- Create: `perf/dashboards/k6-prometheus-19665.json`、`perf/dashboards/perf-trade-business.json`

**Interfaces:**
- Consumes: Task 3 的自定义指标名（Prometheus 侧：`k6_trade_booking_duration_p95/p99`、`k6_trade_booking_errors_total`、`k6_business_errors_total`，均带 `testid`/`service`/`module` 标签）
- Produces: 两份入库 dashboard JSON——官方 19665 固定版本（防线上漂移）+ 自建业务指标面板（testid 变量下钻）

- [ ] **Step 1: 下载官方 dashboard 固定版本**

```bash
cd perf && mkdir -p dashboards
curl -fsSL "https://grafana.com/api/dashboards/19665/revisions/latest/download" \
  -o dashboards/k6-prometheus-19665.json
```

（无外网时：从现网 Grafana 已装的 19665 dashboard 手动 Export JSON 落到同一路径。）

- [ ] **Step 2: 写业务指标 dashboard** `perf/dashboards/perf-trade-business.json`

```json
{
  "title": "Perf - Trade Business Metrics",
  "uid": "perf-trade-biz",
  "schemaVersion": 39,
  "tags": ["perf", "k6"],
  "time": { "from": "now-1h", "to": "now" },
  "templating": {
    "list": [
      {
        "name": "testid",
        "type": "query",
        "query": "label_values(k6_http_reqs_total, testid)",
        "refresh": 2,
        "sort": 2
      }
    ]
  },
  "panels": [
    {
      "title": "trade_booking_duration p95/p99 (ms)",
      "type": "timeseries",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "targets": [
        { "expr": "k6_trade_booking_duration_p95{testid=\"$testid\"}", "legendFormat": "p95" },
        { "expr": "k6_trade_booking_duration_p99{testid=\"$testid\"}", "legendFormat": "p99" }
      ]
    },
    {
      "title": "business / booking errors per second",
      "type": "timeseries",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "targets": [
        { "expr": "rate(k6_business_errors_total{testid=\"$testid\"}[1m])", "legendFormat": "business errors" },
        { "expr": "rate(k6_trade_booking_errors_total{testid=\"$testid\"}[1m])", "legendFormat": "booking errors" }
      ]
    }
  ]
}
```

- [ ] **Step 3: 校验 JSON**

Run: `cd perf && node -e "for (const f of ['dashboards/k6-prometheus-19665.json','dashboards/perf-trade-business.json']) JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('all valid')"`
Expected: `all valid`。（面板在真实 Grafana 上的显示效果属集群侧验证，列入环境清单。）

- [ ] **Step 4: 提交**

```bash
git add perf/dashboards
git commit -m "feat(perf): Grafana dashboards（官方 19665 固定版 + 业务指标面板）"
```

---

### Task 6: 文档、环境清单与最终验证

**Files:**
- Create: `perf/README.md`、`perf/docs/env-checklist.md`

**Interfaces:**
- Consumes: 前面全部任务
- Produces: 使用文档；集群侧验证清单（本地无法验证的事项全部显式列出）；最终静态验证全通过

- [ ] **Step 1: 写 README** `perf/README.md`

```markdown
# perf — k6 性能测试框架

FX Structured Products Trading System 服务端压测框架。
设计文档：`../docs/superpowers/specs/2026-07-31-k6-perf-framework-design.md`。

## 快速开始

```bash
# 本地静态验证（不发压）
k6 inspect -e ENV=local src/scenarios/trades-query.js
./deploy/run.sh --tags P0 -p smoke -e local --dry-run

# 内网压 dev 环境（先按 docs/env-checklist.md 完成启用项）
./deploy/run.sh -s trades-query -p smoke -e dev            # 首跑必须 smoke
./deploy/run.sh -s trades-query -p load -e dev -r 50 -d 10m
./deploy/run.sh --tags P0 -p load -e dev                   # 批量 P0 + 汇总表

# 本机直跑（不经 k8s）
./deploy/run.sh -s trades-query -p smoke -e dev --local
```

## 目录结构

- `config/environments/` 环境（服务地址映射、白名单、promRwUrl、身份池）；**仓库内全部为 localhost/示例占位，真实值仅在内网填写；没有也不允许有 prod**
- `config/slas/` 按 服务/模块 组织的 SLA 阈值（当前为占位水位，见环境清单）
- `src/lib` 框架层（纯逻辑模块不依赖 k6）；`src/api/<service>/<module>.js` API 客户端层
- `src/payloads` multipart 组装工厂；`data/datfiles/` 产品 dat 模板（占位，须替换）
- `src/profiles` smoke/load/stress/spike/soak；`src/scenarios` 场景入口
- `deploy/` run.sh 与 Job 模板（镜像/脚本注入由公司侧机制提供）；`dashboards/` Grafana JSON
- `tools/` meta 提取、报告提取/渲染

## 约定

- 场景文件必须导出静态 `meta = { tags: [...] }`；`P0/P1/P2` tag 表达优先级
- `run.sh --tags` 是框架参数（用例选择）；k6 的 `--tag` 是指标标签，由 run.sh 注入 testid，用户不手写
- 新增 API：在 `src/api/<service>/` 加函数（统一走 `lib/http.js` 三动词）；新增产品：`data/datfiles/` 加 dat + `payloads/factory.js` 注册

## 真实环境启用

见 `docs/env-checklist.md`——本仓库无 mock 与单元测试，**内网首跑 smoke 即框架首次端到端验证**，务必小流量先行并逐项核对清单。
```

- [ ] **Step 2: 写环境清单** `perf/docs/env-checklist.md`

```markdown
# 真实环境启用前检查清单

本地已验证：JSON 配置、纯逻辑模块加载、`k6 inspect`（完整 init：import 图 + open() 文件）、
run.sh dry-run（tag 筛选、Job manifest 渲染）。
以下事项本地无法验证，首次对 dev/uat 压测前逐项确认（编号对应设计文档第 11 节遗留问题）：

- [ ] 真实服务地址：`config/environments/dev.json` 的 services 填真实 host:port，whitelist 同步加真实域（仓库内保持 localhost 占位，真实值不入库或按公司规范管理）
- [ ] Prometheus 开启 `--web.enable-remote-write-receiver`，地址填入 `promRwUrl`（遗留问题 #1）
- [ ] SLA 目标值与业务方确认，替换 `config/slas/` 占位水位（遗留问题 #2）
- [ ] 压测数据标记与开发确认：当前用 portfolioId=PERF_TEST + basic.clientRef 承载唯一标记，需确认字段有效且对下游无副作用（遗留问题 #3）
- [ ] 用真实 FX_TRF.dat 替换 `data/datfiles/` 占位文件；验证同一 dat 高频重复提交是否触发幂等/去重/日期校验，若需参数化做模板替换（遗留问题 #4）
- [ ] create 响应结构核对：`bizCheck` 假设响应含 `tradeId` 字段，首跑时确认
- [ ] 5 个微服务清单（服务名/地址/模块）补入 `config/environments/` 与 `src/api/`（遗留问题 #6）
- [ ] X-User-Id 身份（maker/checker 真实账号）填入环境文件并确认在目标环境有效
- [ ] k8s 脚本注入方式（本仓库不交付 Dockerfile）：公司镜像流程内置 k6 + `/perf` 内容（workingDir 与 job.yaml 一致），或 ConfigMap 挂载——二选一实施，镜像地址经 `K6_IMAGE` 传入；`K6_NAMESPACE` 建立并有 Job 创建权限
- [ ] 两份 dashboard 导入现网 Grafana，确认 testid 变量与业务指标面板出数
- [ ] 服务端指标串联配置（依赖现网信息）：业务 dashboard 底部补服务端资源面板（PromQL 参照现有服务端 dashboard，按 service 过滤）；顶部加带 `?from=${__from}&to=${__to}` 的 dashboard link 跳转到各服务端 dashboard
- [ ] 压测环境 trade 表存量数据接近生产量级（空表查询无参考价值）
- [ ] 首跑顺序：smoke（1 分钟）→ 确认 Grafana 出数、报告生成、服务端无异常 → 再 load
```

- [ ] **Step 3: 最终静态验证汇总**

```bash
cd perf
k6 inspect -e ENV=local src/scenarios/trades-query.js > /dev/null && echo inspect-query-ok
k6 inspect -e ENV=local src/scenarios/trades-create.js > /dev/null && echo inspect-create-ok
./deploy/run.sh --tags P0 -p smoke -e local --dry-run > /dev/null && echo dryrun-ok
grep -RIn 'http://' config src deploy data | grep -v localhost && echo "发现非 localhost 地址" || echo no-internal-hosts
```

Expected: `inspect-query-ok`、`inspect-create-ok`、`dryrun-ok`、`no-internal-hosts`（perf/ 内所有 http 地址均为 localhost 占位）。

- [ ] **Step 4: 提交**

```bash
git add perf/README.md perf/docs/env-checklist.md
git commit -m "docs(perf): 使用文档与真实环境启用清单"
```

---

## Spec 覆盖对照（自检记录）

| Spec 章节 | 实现任务 |
|---|---|
| §2 总体架构（k8s Job / remote write / 执行层可替换） | Task 4 |
| §3 仓库结构 / src 收纳规则 / JSON 参数池 | Task 1、2、4、5 |
| §3.1 多微服务组织（服务→目录、services 映射、service/module tag） | Task 1、3 |
| §3.2 优先级 tag 表达 | Task 3、4 |
| §4 负载模型（open model、五 profile、maxVUs 上限、参数覆盖） | Task 2、4 |
| §5 身份池 / http 三动词 / 双层断言 / 业务指标 | Task 2、3 |
| §6 数据管理（multipart 工厂、唯一性、查询多样性、PERF_TEST 标记、环境清单） | Task 1、2、6 |
| §7 SLA / 熔断 / 白名单 / Job 资源与 ttl | Task 1、2、4 |
| §8 可观测性（remote write、testid、19665 + 业务面板） | Task 4、5 |
| §8 服务端指标串联（混排面板/时间窗跳转；依赖现网信息） | Task 6（env-checklist 集群侧配置项；annotation 标注为 P1 不在本计划） |
| §9 报告（handleSummary → JSON/HTML） | Task 2、3、4 |
| §10 执行方式（run.sh、--tags、本地一致性、汇总表） | Task 4 |
| §11 遗留问题 → 显式清单 | Task 6（env-checklist.md） |

裁剪记录（用户决策，2026-07-31）：不做 mock 服务、不交付 Dockerfile、不写单元测试文件、仓库内一律占位符——k6 层的行为正确性（multipart 组装、报告链路）改由内网首跑 smoke 验证。
P1（lifecycle/seeding/基线对比）与 P2（混合场景/WebSocket/CI）不在本计划内，按 spec 优先级另立计划。
