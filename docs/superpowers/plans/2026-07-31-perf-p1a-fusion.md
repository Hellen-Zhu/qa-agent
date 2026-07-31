# perf P1a 融合改造实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地与 trade-performance 框架的融合修订（spec §4-§7/§13）：写路径用例行数据模型 + preflight、错误三分类引擎、全局游标轮换、profile JSON 化与两级熔断、SLA 指标源切换、报告/dashboard/文档同步。

**Architecture:** 在 P0 骨架上做测量层重构：数据从"字段池"改为"用例行"（`lib/rows.js` 解析契约 + `api/trade-svc/trades-data.js` 池实例化）；响应处理从二值 bizCheck 改为 `lib/errors.js` 三分类引擎（api 层注入各自契约）；`profiles/` 升为顶层 JSON 声明式（bootstrap 装配剥注释/覆盖/封顶/阈值三层叠加）。执行层（run.sh/job.yaml/报告提取管道）不动。设计依据：`docs/superpowers/specs/2026-07-31-k6-perf-framework-design.md`（commit 171f065 修订版）。

**Tech Stack:** k6 ≥0.55（本地 v2.1.0）、Node ≥20（零 npm 依赖）、bash。

## Global Constraints

- 所有路径相对 `perf/`（worktree `/Users/jliu/hellen/qa/.claude/worktrees/perf-p0/perf/`）；命令在 `perf/` 下执行；提交在 feat/perf-p0 分支。
- **不交付**：单元测试文件、mock 服务、Dockerfile（P0 既有裁剪仍有效）。验证手段 = `k6 inspect`（执行完整 init）、真实本地 smoke（对 localhost 连接拒绝，验证 technical 分类路径与报告管道）、Node 加载检查、dry-run。
- **纯逻辑模块**（禁止 import `k6/*`，Node 可加载）：`src/lib/config.js`、`users.js`、`data.js`、`rows.js`、`sla.js`、`report.js`。**k6 侧模块**：`src/lib/http.js`、`errors.js`、`bootstrap.js`、`src/api/**`、`src/scenarios/**`、`src/setup/**`。`src/lib/metrics.js` 与 `src/payloads/` 本次删除。
- 指标统一 `perf_` 前缀；tag 只允许有界取值（name/service/module/runPhase/row/productType/errClass/reason），严禁 tradeId 等每请求唯一值进 tag。
- **占位符纪律**：主机一律 localhost；用例数据用**形式合法的假值**（能过 preflight 的占位符模式检查，本地 smoke 才能跑通链路），`note` 字段注明非真实采集；字符串 `oreo`（内部系统代号）不得出现在任何文件。
- 每任务至少一次提交，格式 `feat(perf):`/`refactor(perf):`/`docs(perf):`，提交信息以此行结尾：Claude-Session: https://claude.ai/code/session_013dQSHE3JrPva6kbQTdJvky
- open() 路径一律 `import.meta.resolve()` 锚定（P0 已确立，k6 会对裸相对路径告警）。

---

### Task 1: rows.js 解析契约与用例行数据

**Files:**
- Create: `perf/src/lib/rows.js`、`perf/data/trade-svc/README.md`、`perf/data/datfiles/products/FX_TRF/fx_trf_01.dat`（由现有文件 git mv）
- Modify: `perf/data/trade-svc/trades-create.json`（整体替换）、`perf/src/lib/data.js`（整体替换）、`perf/.gitignore`
- Delete: `perf/data/datfiles/FX_TRF.dat`（mv 走）

**Interfaces:**
- Consumes: 无
- Produces:
  - `rowsFromJson(text: string, sourceName: string) -> Array<Object>`（顶层数组或 `{rows:[...]}`；`_` 开头键剥除；标量值转去空白字符串，null/undefined→''；注入 `__row` 1 起始行号；结构错误 throw 且信息含 sourceName）
  - `pickAt(pool: any[], i: number) -> any`（全局游标取数，空池 throw `empty param pool`）
  - 用例文件契约：`data/trade-svc/trades-create.json` 为 `{_comment, rows:[{datFile, productType, notionalCurrency, portfolioId, counterpartyFmId, counterpartyName, note}]}`，datFile 相对 `data/datfiles/`

- [ ] **Step 1: 实现 rows.js** `perf/src/lib/rows.js`

```js
// JSON 数据文件解析契约（纯逻辑，Node 可加载）。
// 顶层为数组，或含 rows 数组的对象；「_」开头的键（顶层与行内）是注释，装载时剥除；
// 标量值一律转为去空白字符串（null/undefined → ''）——payload 是否发数值由组装方决定；
// 自动注入 __row（1 起始行号）作为行身份，用于指标 tag 与 preflight 报错定位。
// 注意 note 不带下划线——它是真实数据列（记采集时间与来源），不要写成 _note。
export function rowsFromJson(text, sourceName) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `${sourceName} 不是合法 JSON — ${e.message}。` +
      `常见原因：JSON 不允许注释与尾逗号——注释写成 _ 开头的键`
    );
  }

  let rows;
  if (Array.isArray(doc)) rows = doc;
  else if (doc && Array.isArray(doc.rows)) rows = doc.rows;
  else {
    throw new Error(`${sourceName} 结构错误：顶层应为数组，或含 rows 数组的对象（其余 _ 开头键为注释）`);
  }

  return rows.map((r, idx) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error(`${sourceName} 第 ${idx + 1} 行不是对象——每行应为 {"字段": "值"}`);
    }
    const out = { __row: idx + 1 };
    Object.keys(r).forEach((k) => {
      if (k.startsWith('_')) return;
      const v = r[k];
      out[k] = v === null || v === undefined ? '' : String(v).trim();
    });
    return out;
  });
}
```

- [ ] **Step 2: 重写 data.js** `perf/src/lib/data.js`

```js
// 参数池确定性取数：i 为全局单调游标（exec.scenario.iterationInTest），
// 均匀覆盖且可复现——取代旧的 vu*31+iter 哈希（有偏斜、arrival 模型下不可复现）。
export function pickAt(pool, i) {
  if (!Array.isArray(pool) || pool.length === 0) throw new Error('empty param pool');
  return pool[Math.abs(i) % pool.length];
}
```

- [ ] **Step 3: 用例行数据与 dat 目录迁移**

```bash
mkdir -p data/datfiles/products/FX_TRF
git mv data/datfiles/FX_TRF.dat data/datfiles/products/FX_TRF/fx_trf_01.dat
```

`perf/data/trade-svc/trades-create.json` 整体替换为：

```json
{
  "_comment": [
    "create 用例池：一行 = 一个完整可跑用例（dat 引用 + 归属字段内嵌同一行）。",
    "纪律：整行必须同源采集自同一份真实 curl（系统 Web 界面建单 + DevTools Copy as cURL），",
    "禁止跨行/跨文件拼装字段——手工组合可能是现实中不存在的归属关系（见本目录 README.md）。",
    "datFile 相对 data/datfiles/。当前为本地联调占位假值（形式合法、可过 preflight），",
    "内网启用时逐行替换为真实采集值，并在 note 记录采集时间与来源。"
  ],
  "rows": [
    {
      "datFile": "products/FX_TRF/fx_trf_01.dat",
      "productType": "FX_TRF",
      "notionalCurrency": "USD",
      "portfolioId": "PERF-PF-A",
      "counterpartyFmId": "CP-000001",
      "counterpartyName": "PERF CP A",
      "note": "本地占位（2026-07-31），非真实采集"
    },
    {
      "datFile": "products/FX_TRF/fx_trf_01.dat",
      "productType": "FX_TRF",
      "notionalCurrency": "USD",
      "portfolioId": "PERF-PF-A",
      "counterpartyFmId": "CP-000002",
      "counterpartyName": "PERF CP B",
      "note": "本地占位（2026-07-31），非真实采集"
    }
  ]
}
```

- [ ] **Step 4: 数据纪律 README** `perf/data/trade-svc/README.md`

```markdown
# trade-svc 数据文件

- `trades-query.json` — 查询字段池：`{ filters: [...] }`。字段间无有效性关联，池内自由轮换。
- `trades-create.json` — create 用例池：一行 = 一个完整可跑用例。行号 `__row` 装载时自动注入，
  作为指标 tag（哪行数据坏了直接从指标切出）；无人工维护的 id 列。

## 为什么归属字段内嵌一行，且必须同源

静态供数没有 live 查询兜底，**任何手工拼装都可能造出现实中不存在的组合**——
portfolio 属于 A 台、counterparty 未在 A 台开户。服务端业务拒绝在报告里呈现为
"错误率升高"，看起来像性能问题，实际是数据问题，极难定位。因此：

- `counterpartyFmId` 与 `counterpartyName` 服务端做一致性校验，禁止两处拼凑；
- 三个归属字段必须**整组来自同一份真实 curl**（系统 Web 界面建单，DevTools 对
  `POST /trades/create` Copy as cURL）——这一份 curl 同时给出：配对的归属真值、
  真实 .dat 文件（另存到 `../datfiles/products/<productType>/`）、payload 结构与 header 集合。

## 数据有效性由两层机制守护（preflight 不发请求）

- 开跑前：大轮次同一会话先跑 `smoke`——真实建一笔，这才是"API 此刻接受这份数据"的验证；
- 跑起来后：长时 profile 的业务成功率宽松熔断线（`rate>0.50` + abortOnFail）——
  数据失效表现为整体性业务拒绝，无论发生在启动时还是第 3 小时，几分钟内自动止损。

## 刷新时机

不定期刷新，但以下情况必须重新采集：换环境（id 不跨环境）；smoke 的 create 开始失败或
长跑被业务成功率熔断；错误里出现大量 "counterparty not found / not entitled" 类拒绝。
采集时间与来源记在 `note` 字段。

## 变体池（对照实验）

如 portfolio 级锁竞争：复制 `trades-create.json` 为变体（全部行填同一组归属值），
`CREATE_DATA_FILE=data/trade-svc/<变体>.json` 覆盖切换，不改脚本。

⚠ 采集来的 curl/响应样本放本目录 `_samples/`（已 gitignore）——DevTools 导出含会话
cookie 与真实业务数据，**不入库**。
```

`perf/.gitignore` 追加一行：

```
data/**/_samples/
```

- [ ] **Step 5: 验证（Node 直测纯模块）**

Run:

```bash
cd perf && node --input-type=module -e "
import { rowsFromJson } from './src/lib/rows.js';
import { pickAt } from './src/lib/data.js';
import { readFileSync } from 'node:fs';
const rows = rowsFromJson(readFileSync('data/trade-svc/trades-create.json','utf8'), 'trades-create.json');
if (rows.length !== 2) throw new Error('want 2 rows');
if (rows[0].__row !== 1 || rows[1].__row !== 2) throw new Error('__row 注入错误');
if (rows[0].counterpartyFmId !== 'CP-000001') throw new Error('字段值错误');
if ('_comment' in rows[0]) throw new Error('注释键未剥除');
if (pickAt(rows, 0).__row !== 1 || pickAt(rows, 3).__row !== 2) throw new Error('pickAt 轮换错误');
let threw = false; try { rowsFromJson('{bad', 'x'); } catch (e) { threw = /不是合法 JSON/.test(e.message); }
if (!threw) throw new Error('坏 JSON 未报错');
console.log('rows-and-pickat-ok');
" && test -f data/datfiles/products/FX_TRF/fx_trf_01.dat && echo dat-moved-ok
```

Expected: `rows-and-pickat-ok`、`dat-moved-ok`

- [ ] **Step 6: 提交**

```bash
git add -A perf/data perf/src/lib/rows.js perf/src/lib/data.js perf/.gitignore
git commit -m "feat(perf): 用例行数据契约（rows.js/__row/同源纪律）与全局游标取数"
```

（注意：此刻 `src/scenarios/trades-query.js` 仍引用旧 `pick`，`k6 inspect` 会失败——Task 3 修复；本任务验收以上述 Node 检查为准。）

---

### Task 2: 错误三分类引擎与 http.js 瘦身

**Files:**
- Create: `perf/src/lib/errors.js`
- Modify: `perf/src/lib/http.js`（整体替换）
- Delete: `perf/src/lib/metrics.js`

**Interfaces:**
- Consumes: Task 1 无直接依赖；`serviceBaseUrl(cfg, service)`（既有 config.js）
- Produces:
  - `ERR = { OK:'ok', TECHNICAL:'technical', BUSINESS:'business', SCRIPT:'script' }`
  - `classifyResponse(res, tags, spec?) -> {errClass, detail, reason, body}`（spec.business(body)=>null|{reason,detail}；spec.shape(body)=>null|问题描述；分支顺序=分类优先级：technical→not-json→business→shape）
  - `classifyRead(res, tags, validate) -> 同上`（只读端点简写：仅 shape 校验）
  - `reasonFrom(body, patterns) -> string`、`techReason(res) -> string`、`recordOutcome(errClass, tags, res, reason?)`、`logFailure(...)`
  - 指标：`perf_ok`/`perf_err_technical`/`perf_err_business`/`perf_err_script`（Counter，互斥，总和=请求数）、`perf_business_success`（Rate）、`perf_success_duration`（Trend，仅业务成功请求）
  - http.js 三动词签名不变，但**返回值改为 `{res, tags}`**；不再做任何 check/指标记录（分类是 api 层职责）；新增 `opts.tags` 附加低基数 tag；query 键也做 encodeURIComponent

- [ ] **Step 1: 实现 errors.js** `perf/src/lib/errors.js`

```js
/*
 * lib/errors.js — 错误三分类引擎（k6 侧模块）
 *
 * 本系统业务失败也返回 HTTP 200（业务状态在 body 的 code/status 字段），
 * 只看状态码的报告会显示"0% 错误"而实际一笔未成。三类必须分开呈现：
 *   technical  连接失败/超时/5xx → 系统扛不住，这才是性能结论
 *   business   HTTP 200 但业务拒绝 → 通常是测试数据失效，不是性能问题
 *   script     响应非 JSON/结构不符 → 脚本缺陷，本轮结果作废
 *
 * 引擎不认识任何具体 API：业务契约（成功判据、拒绝归因模式表）由 api 层
 * 经 spec 回调注入。tag 只允许有界取值——reason 来自模式表槽位 + 服务端
 * code 枚举 + HTTP 状态码；严禁把自由文本 msg 或 tradeId 类唯一值当 tag。
 */
import { Counter, Rate, Trend } from 'k6/metrics';

export const cOk = new Counter('perf_ok');
export const cTechnical = new Counter('perf_err_technical');
export const cBusiness = new Counter('perf_err_business');
export const cScript = new Counter('perf_err_script');

// verdict 与熔断都看它，而不是 http_req_failed
export const rBusinessSuccess = new Rate('perf_business_success');

// 只统计业务成功请求的耗时：快速拒绝会拉低分位数使容量虚高，SLA 以此为准
export const tSuccessDuration = new Trend('perf_success_duration', true);

export const ERR = {
  OK: 'ok',
  TECHNICAL: 'technical',
  BUSINESS: 'business',
  SCRIPT: 'script',
};

/** 业务拒绝归因：模式表槽位 → 服务端 code 枚举兜底（均有界） */
export function reasonFrom(body, patterns) {
  const msg = String((body && body.msg) || '');
  for (let i = 0; i < (patterns || []).length; i++) {
    if (patterns[i].re.test(msg)) return patterns[i].reason;
  }
  const code = body && body.code;
  return typeof code === 'number' ? 'code-' + code : 'code-unknown';
}

export function techReason(res) {
  // status=0 是连接层失败（超时/拒绝/DNS）；error_code 是 k6 的有界错误枚举
  return res.status > 0 ? 'http-' + res.status : 'net-' + (res.error_code || 0);
}

/*
 * 限流现场日志：每 VU 每 (errClass, reason) 组合只完整打印前 3 条——
 * 高并发大面积失败时日志 I/O 不反噬压力机；计数看指标，逐请求明细走结果文件。
 * 每 VU 一个 JS VM，模块级对象天然按 VU 隔离。
 */
const LOG_CAP = 3;
const logSeen = {};

export function logFailure(errClass, reason, detail, tags) {
  const key = errClass + '|' + reason;
  const n = (logSeen[key] = (logSeen[key] || 0) + 1);
  if (n > LOG_CAP) return;
  const t = tags || {};
  const tail = n === LOG_CAP ? `（该类日志达 ${LOG_CAP} 条上限，此后静默；计数看指标）` : '';
  console.warn(`✗ [${errClass}/${reason}] ${t.name || 'NA'} vu=${__VU} row=${t.row || 'NA'} ${detail}${tail}`);
}

/** 每请求的分类结果统一入账：新 api 不得自建 Counter 复刻三分类，一律走这里 */
export function recordOutcome(errClass, tags, res, reason) {
  const t = Object.assign({}, tags, { errClass });
  if (reason && errClass !== ERR.OK) t.reason = reason;
  const ok = errClass === ERR.OK;

  if (ok) cOk.add(1, t);
  else if (errClass === ERR.TECHNICAL) cTechnical.add(1, t);
  else if (errClass === ERR.BUSINESS) cBusiness.add(1, t);
  else cScript.add(1, t);

  rBusinessSuccess.add(ok, tags);
  if (ok) tSuccessDuration.add(res.timings.duration, tags);
}

/** 通用分类引擎。分支顺序即分类优先级（technical → not-json → business → shape），勿调整 */
export function classifyResponse(res, tags, spec) {
  const s = spec || {};
  const t = tags || {};

  if (res.status !== 200) {
    const reason = techReason(res);
    const detail = `technical: HTTP ${res.status}${res.error ? ' ' + res.error : ''}`;
    recordOutcome(ERR.TECHNICAL, t, res, reason);
    logFailure(ERR.TECHNICAL, reason, detail, t);
    return { errClass: ERR.TECHNICAL, detail, reason, body: null };
  }

  let body;
  try {
    body = res.json();
  } catch (e) {
    const detail = `script: 响应不是 JSON — ${e.message}`;
    recordOutcome(ERR.SCRIPT, t, res, 'not-json');
    logFailure(ERR.SCRIPT, 'not-json', detail, t);
    return { errClass: ERR.SCRIPT, detail, reason: 'not-json', body: null };
  }

  if (s.business) {
    const rej = s.business(body);
    if (rej) {
      recordOutcome(ERR.BUSINESS, t, res, rej.reason);
      logFailure(ERR.BUSINESS, rej.reason, rej.detail, t);
      return { errClass: ERR.BUSINESS, detail: rej.detail, reason: rej.reason, body };
    }
  }

  if (s.shape) {
    const problem = s.shape(body);
    if (problem) {
      const detail = `script: ${problem}`;
      recordOutcome(ERR.SCRIPT, t, res, 'shape');
      logFailure(ERR.SCRIPT, 'shape', detail, t);
      return { errClass: ERR.SCRIPT, detail, reason: 'shape', body };
    }
  }

  recordOutcome(ERR.OK, t, res);
  return { errClass: ERR.OK, detail: 'ok', reason: '', body };
}

/** 只读端点简写：暂无可断言的业务拒绝形态，契约只有结构校验（结构不符=script 类） */
export function classifyRead(res, tags, validate) {
  return classifyResponse(res, tags, { shape: validate });
}
```

- [ ] **Step 2: 瘦身 http.js** `perf/src/lib/http.js` 整体替换：

```js
import k6http from 'k6/http';
import { serviceBaseUrl } from './config.js';

// 统一 HTTP 管道：所有 API 调用唯一出口，只负责"把请求发出去"——
// baseUrl 解析、默认请求头、低基数指标 tag。响应分类是 api 层的契约职责
// （lib/errors.js），因此返回 {res, tags} 交给调用方送入分类引擎。
// opts: { name(必填,指标tag), module, user, params(query对象), headers, tags(附加低基数tag) }
function request(method, cfg, service, path, body, opts) {
  if (!opts || !opts.name) throw new Error('http: opts.name tag is required');
  const entries = opts.params ? Object.entries(opts.params) : [];
  const qs = entries.length
    ? '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';
  const url = serviceBaseUrl(cfg, service) + path + qs;
  const params = {
    headers: Object.assign(
      { Accept: 'application/json' },
      opts.user ? { 'X-User-Id': opts.user } : {},
      opts.headers || {},
    ),
    tags: Object.assign(
      { name: opts.name, service, module: opts.module || 'default' },
      opts.tags || {},
    ),
  };
  const res = method === 'GET' ? k6http.get(url, params) : k6http.post(url, body, params);
  return { res, tags: params.tags };
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
  // 含 http.file() 的对象 body 由 k6 自动编码 multipart 并生成 boundary；
  // 严禁手写 Content-Type——手写值没有 boundary，会覆盖生成值导致服务端无法分包
  return request('POST', cfg, service, path, formData, opts);
}
```

- [ ] **Step 3: 删除 metrics.js**

```bash
git rm perf/src/lib/metrics.js
```

- [ ] **Step 4: 验证（语法层）**

Run: `cd perf && node --check src/lib/errors.js && node --check src/lib/http.js && grep -c "perf_" src/lib/errors.js && echo syntax-ok`
Expected: 语法通过、grep 计数 ≥6（六个 perf_ 指标声明各占一行）、`syntax-ok`。
（运行时行为在 Task 3 的真实 smoke 中验证——api 层接入前 inspect 会因场景仍 import 已删除的 metrics.js 而失败，属预期中间态。）

- [ ] **Step 5: 提交**

```bash
git add perf/src/lib/errors.js perf/src/lib/http.js
git commit -m "feat(perf): 错误三分类引擎（perf_* 指标/reason 归因/限流日志），http.js 收敛为纯发送管道"
```

---

### Task 3: 用例池实例化、api 层契约接入、场景与 preflight

**Files:**
- Create: `perf/src/api/trade-svc/trades-data.js`、`perf/src/setup/create-trade-preflight.js`
- Modify: `perf/src/api/trade-svc/trades.js`（整体替换）、`perf/src/scenarios/trades-query.js`（整体替换）、`perf/src/scenarios/trades-create.js`（整体替换）、`perf/src/lib/bootstrap.js`（删除 loadDat，其余暂不动）
- Delete: `perf/src/payloads/factory.js`（及空目录）

**Interfaces:**
- Consumes: Task 1 `rowsFromJson`/`pickAt`；Task 2 `classifyResponse`/`classifyRead`/`reasonFrom`/`ERR` 与 http.js 新返回值 `{res, tags}`；既有 `cfg`/`loadData`/`buildOptions`/`stdHandleSummary`/`pickUser`
- Produces:
  - `trades-data.js`：`DATA_FILE`（实际生效的数据文件路径，`CREATE_DATA_FILE` 可覆盖）、`createCases`（SharedArray）、`pickCase(i)`、`getDat(relPath)`、`datBaseName(relPath)`
  - `trades.js`：`queryTrades(cfg, filter, user) -> 分类结果`、`createTrade(cfg, caseRow, user, runPhase) -> 分类结果`、`buildTradePayload(caseRow) -> string`、`validateInputs(caseRow) -> string[]`、`tradesRows`（Trend `perf_trades_rows`，空库守卫）
  - `createTradePreflight() -> {startedAt, dataFile}`（占位符/缺字段/空池 → `exec.test.abort`，逐行报 `__row`；不发任何请求）
  - 场景取数一律 `exec.scenario.iterationInTest` 全局游标

- [ ] **Step 1: 实现 trades-data.js** `perf/src/api/trade-svc/trades-data.js`

```js
/*
 * create 路径的数据供给：用例池实例化 + dat 预载。
 * 通用解析机制在 lib/rows.js；本文件只做路径专属的两件事。
 * k6 约束：open() 仅 init 阶段可用 → 全部 dat 必须装载时一次读入；
 * SharedArray 只能存 JSON 可序列化数据 → 行数据进 SharedArray（全 VU 一份），
 * 二进制 dat 进不了 → 每 VU 复制一份，内存 ≈ VU 数 × dat 总字节，大文件警惕。
 */
import { SharedArray } from 'k6/data';
import { rowsFromJson } from '../../lib/rows.js';

function envOr(key, fallback) {
  const v = __ENV[key];
  return v === undefined || v === '' ? fallback : v;
}

// 变体池切换（对照实验）不改脚本：CREATE_DATA_FILE=data/trade-svc/<变体>.json
export const DATA_FILE = envOr('CREATE_DATA_FILE', 'data/trade-svc/trades-create.json');
if (!DATA_FILE.endsWith('.json')) {
  throw new Error(`数据文件必须是 .json: ${DATA_FILE}（契约见 lib/rows.js）`);
}

export const createCases = new SharedArray('create-cases', () =>
  rowsFromJson(open(import.meta.resolve(`../../../${DATA_FILE}`)), DATA_FILE)
);

/** 全局游标轮换：i 用 exec.scenario.iterationInTest——均匀覆盖且可复现 */
export function pickCase(i) {
  if (createCases.length === 0) throw new Error(`${DATA_FILE} 没有数据行`);
  return createCases[Math.abs(i) % createCases.length];
}

// ── dat 按行引用预载：只加载数据文件实际引用的文件 ──
const DAT_ROOT = '../../../data/datfiles/';
const datBinaries = {};
for (let i = 0; i < createCases.length; i++) {
  const rel = String(createCases[i].datFile || '').replace(/\\/g, '/');
  if (!rel || datBinaries[rel] !== undefined) continue;
  datBinaries[rel] = open(import.meta.resolve(DAT_ROOT + rel), 'b');
}

export function getDat(relPath) {
  const b = datBinaries[String(relPath || '').replace(/\\/g, '/')];
  if (b === undefined) {
    throw new Error(`dat 未预载: ${relPath}——检查 ${DATA_FILE} 的 datFile 字段与 data/datfiles/ 是否一致`);
  }
  return b;
}

/** multipart 上传文件名取路径末段（路径分隔符统一 /，防 Windows 反斜杠混入文件名） */
export function datBaseName(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}
```

- [ ] **Step 2: 重写 api 层** `perf/src/api/trade-svc/trades.js` 整体替换：

```js
import http from 'k6/http';
import { Trend } from 'k6/metrics';
import * as client from '../../lib/http.js';
import { classifyResponse, classifyRead, reasonFrom, ERR } from '../../lib/errors.js';
import { getDat, datBaseName } from './trades-data.js';

const SVC = 'trade-svc';
const MOD = 'trades';

// 空库守卫：每个响应的行数进 Trend，场景挂阈值 avg>0——
// 空库上的查询数字无意义，且行数恒 0 也说明字段名猜错了，本轮同样无证明力
export const tradesRows = new Trend('perf_trades_rows');

export function queryTrades(cfg, filter, user) {
  const { res, tags } = client.get(cfg, SVC, '/api/v1/trades', {
    name: 'GET /api/v1/trades', module: MOD, user, params: filter,
  });
  const out = classifyRead(res, tags, (body) =>
    Array.isArray(body.trades) ? null : `响应缺少 trades 数组 — keys=${Object.keys(body || {}).slice(0, 8).join(',')}`
  );
  if (out.errClass === ERR.OK) tradesRows.add(out.body.trades.length, tags);
  return out;
}

/*
 * ── create 的响应契约（trade-performance 实测校准版；业务分类属于本文件，
 *    lib/errors.js 只是引擎）──
 * 成功 = HTTP 200 + code=200 + status='PENDING APPROVAL' + data.trade.id ~ TRD-\d+
 * 内网首跑须确认契约未随版本变化（env-checklist）。
 */
const REJECT_PATTERNS = [
  // 服务端上传临时文件按时间戳命名，同一瞬间并发上传互删临时文件 → "dat not found"
  //（撞上时的绕行开关与归因见 spec §11-4；正则匹配真实服务端报错，可能含中文，勿翻译）
  { reason: 'dat-missing', re: /(dat|file).*(not\s*found|missing|不存在)|找不到/i },
];

/** trade 字段（multipart 的普通表单字段）。必须 JSON.stringify——
 *  真实 counterparty 名称含 * 与非 ASCII，手拼字符串迟早产出非法 JSON */
export function buildTradePayload(caseRow) {
  return JSON.stringify({
    basic: {
      portfolioId: caseRow.portfolioId,
      counterpartyFmId: caseRow.counterpartyFmId,
      counterpartyName: caseRow.counterpartyName,
      notionalCurrency: caseRow.notionalCurrency || '',
    },
  });
}

// 占位符模式：不含 PERF 前缀——专用 PERF portfolio 是合法真值（spec §6）
const PLACEHOLDER = /^\s*(tbc|todo|xxx+|n\/a|待定|placeholder)\s*$/i;

/** 静态供数模式下不可省：字段未解析/占位符照发请求 → 服务端业务拒绝 →
 *  报告呈现为"错误率升高"而非"脚本错了"，最难排查的失败类 */
export function validateInputs(caseRow) {
  const problems = [];
  ['portfolioId', 'counterpartyFmId', 'counterpartyName'].forEach((k) => {
    const v = caseRow[k];
    if (!v || !String(v).trim()) problems.push(`${k} 未解析（检查数据文件路径与字段名，见 ./trades-data.js）`);
    else if (PLACEHOLDER.test(v)) problems.push(`${k}='${v}' 仍是占位符（见 data/trade-svc/README.md）`);
  });
  if (!caseRow.datFile || !String(caseRow.datFile).trim()) {
    problems.push('datFile 未解析（检查数据文件路径与字段名，见 ./trades-data.js）');
  }
  return problems;
}

/** 发送一笔 create。唯一请求出口——preflight 与主循环共享本契约。 */
export function createTrade(cfg, caseRow, user, runPhase) {
  const body = {
    trade: buildTradePayload(caseRow),
    datFile: http.file(getDat(caseRow.datFile), datBaseName(caseRow.datFile), 'application/octet-stream'),
  };
  const { res, tags } = client.postMultipart(cfg, SVC, '/api/v1/trades/create', body, {
    name: 'POST /api/v1/trades/create', module: MOD, user,
    // 低基数 tag：row=数据行号（__row），坏行直接从指标切出；严禁 tradeId 类唯一值
    tags: {
      runPhase: runPhase || 'main',
      row: String(caseRow.__row || 0),
      productType: caseRow.productType || 'NA',
    },
  });
  return classifyResponse(res, tags, {
    business: (b) =>
      b.code !== 200 || b.status !== 'PENDING APPROVAL'
        ? {
            reason: reasonFrom(b, REJECT_PATTERNS),
            detail: `business: code=${b.code} status=${b.status} msg=${String(b.msg || '').slice(0, 160)}`,
          }
        : null,
    shape: (b) => {
      const id = b.data && b.data.trade ? String(b.data.trade.id || '') : '';
      return /^TRD-\d+$/.test(id) ? null : `tradeId 格式异常 — '${id}'`;
    },
  });
}
```

- [ ] **Step 3: 实现 preflight** `perf/src/setup/create-trade-preflight.js`

```js
/*
 * create 路径的本地数据闸：setup() 中运行，整轮开始前一次。
 * 只回答一个问题且不发任何请求："数据文件填好了吗"——占位符、缺字段、空池。
 * 这些问题会让每一次迭代以同样方式失败，在这里拦截零成本且能报出精确行号。
 * "数据今天是否仍有效"由 smoke 会话纪律 + 长跑熔断线回答（见 data/trade-svc/README.md）。
 */
import exec from 'k6/execution';
import { createCases, pickCase, DATA_FILE } from '../api/trade-svc/trades-data.js';
import { validateInputs } from '../api/trade-svc/trades.js';

export function createTradePreflight() {
  console.log('── preflight: create 用例池本地校验 ──');
  console.log(`data=${DATA_FILE} rows=${createCases.length}`);

  if (createCases.length === 0) {
    exec.test.abort(`PREFLIGHT FAILED — 数据文件无数据行: ${DATA_FILE}`);
  }

  const all = [];
  for (let i = 0; i < createCases.length && i < 50; i++) {
    validateInputs(pickCase(i)).forEach((p) => all.push(`[row ${pickCase(i).__row}] ${p}`));
  }
  if (all.length > 0) {
    console.error('PREFLIGHT FAILED — 静态数据不可用:');
    all.slice(0, 10).forEach((p) => console.error('  ' + p));
    exec.test.abort(`静态数据不可用（${all.length} 处问题，见上方日志）`);
  }
  console.log('✓ 本地数据校验通过：字段完整、无占位符');

  // 返回值须 JSON 可序列化（k6 会复制给每个 VU）
  return { startedAt: new Date().toISOString(), dataFile: DATA_FILE };
}
```

- [ ] **Step 4: 场景改造**

`perf/src/scenarios/trades-query.js` 整体替换：

```js
import exec from 'k6/execution';
import { cfg, loadData, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickAt } from '../lib/data.js';
import { queryTrades } from '../api/trade-svc/trades.js';

export const meta = { tags: ['P0', 'trade-svc', 'read'] };

const DATA = loadData('trade-svc/trades-query');

// perf_trades_rows avg>0：空库守卫（空库上的查询数字无意义）
export const options = buildOptions('trade-svc/trades', 'query', {
  perf_trades_rows: ['avg>0'],
});

export default function () {
  const i = exec.scenario.iterationInTest;
  queryTrades(cfg, pickAt(DATA.filters, i), pickUser(cfg, 'maker', __VU));
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
```

`perf/src/scenarios/trades-create.js` 整体替换：

```js
import exec from 'k6/execution';
import { cfg, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickCase } from '../api/trade-svc/trades-data.js';
import { createTrade } from '../api/trade-svc/trades.js';
import { createTradePreflight } from '../setup/create-trade-preflight.js';

export const meta = { tags: ['P0', 'trade-svc', 'write'] };

export const options = buildOptions('trade-svc/trades', 'create');

export function setup() {
  return createTradePreflight();
}

export default function () {
  const i = exec.scenario.iterationInTest;
  const user = pickUser(cfg, 'maker', __VU);
  createTrade(cfg, pickCase(i), user, 'main');
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
```

注意：`buildOptions` 第三参数（附加阈值）在 Task 4 前的现版 bootstrap 已存在同名双参函数——本任务同时给 bootstrap 的 `buildOptions` 增加第三参数并删除 `loadDat`（dat 加载已移入 trades-data.js）。bootstrap 中 `buildOptions` 的返回对象改为：

```js
    thresholds: Object.assign({}, buildThresholds(entry), extraThresholds || {}),
```

（签名 `buildOptions(slaFile, slaKey, extraThresholds)`；Task 4 再整体重写 bootstrap 接入 profile JSON。）

- [ ] **Step 5: 删除 factory**

```bash
git rm perf/src/payloads/factory.js
rmdir perf/src/payloads 2>/dev/null || true
```

- [ ] **Step 6: 验证（inspect + 真实 smoke 双场景）**

```bash
cd perf
k6 inspect -e ENV=local src/scenarios/trades-query.js > /dev/null && echo inspect-query-ok
k6 inspect -e ENV=local src/scenarios/trades-create.js > /dev/null && echo inspect-create-ok
k6 run --tag testid=t3-create -e ENV=local -e PROFILE=smoke -e TESTID=t3-create src/scenarios/trades-create.js 2>&1 | tee /tmp/t3c.log | grep -E 'preflight|本地数据校验|K6_SUMMARY_JSON_START' | head -5
grep -c 'perf_err_technical' /tmp/t3c.log
```

Expected：两个 inspect 退出码 0；smoke 输出含 preflight 日志（`✓ 本地数据校验通过`）与 summary 标记；`perf_err_technical` 出现在 k6 汇总（对 localhost 连接拒绝→technical 分类生效）。再跑同样验证 trades-query：无 preflight 行；`perf_trades_rows` 以阈值判定形式出现且判 FAIL——本地无服务、无成功样本，`avg>0` 不成立，这正是空库守卫的预期语义。

- [ ] **Step 7: 提交**

```bash
git add -A perf/src
git commit -m "refactor(perf): 用例池实例化+api 契约接入三分类引擎+preflight+全局游标"
```

---

### Task 4: profile JSON 化、bootstrap 装配与 SLA 切源

**Files:**
- Create: `perf/profiles/smoke.json`、`baseline.json`、`load.json`、`ladder.json`、`stress.json`、`spike.json`、`soak.json`
- Modify: `perf/src/lib/bootstrap.js`（整体替换）、`perf/src/lib/sla.js`（整体替换）、`perf/config/slas/trade-svc/trades.json`
- Delete: `perf/src/profiles/index.js`（及空目录）

**Interfaces:**
- Consumes: Task 3 场景对 `buildOptions(slaFile, slaKey, extraThresholds?)` 的调用（签名不变）；`stdHandleSummary`/`loadData`/`cfg` 导出不变
- Produces:
  - profile JSON 契约：`{ name, description, _*(注释), scenario:{k6 executor 原文}, thresholds:{...} }`；装配剥 `_` 键
  - bootstrap：`PROFILE`（`__ENV.PROFILE || 'smoke'`）、覆盖仅作用于 scenario 中存在的同名标量键（RATE→rate、VUS→vus、DURATION→duration、MAX_VUS→maxVUs）、maxVUs 硬上限 500、thresholds 三层叠加 = `{perf_err_script:['count==0']}`（底线）+ profile 级 + API 级 + extra
  - `buildThresholds(slaEntry{name,p95,p99}) -> { 'perf_success_duration{name:<api>}': [...] }`（errorRate 字段废除——错误率属 profile 级）

- [ ] **Step 1: 七个 profile JSON**（`mkdir -p perf/profiles`）

`perf/profiles/smoke.json`：

```json
{
  "name": "smoke",
  "description": "脚本、数据、链路此刻通不通。大轮次前同一会话必跑——这同时是静态数据仍然有效的真实验证。",
  "scenario": {
    "executor": "constant-arrival-rate",
    "rate": 2, "timeUnit": "1s", "duration": "1m",
    "preAllocatedVUs": 5, "maxVUs": 10
  },
  "thresholds": {
    "perf_business_success": ["rate>0.99"]
  }
}
```

`perf/profiles/baseline.json`：

```json
{
  "name": "baseline",
  "description": "单用户基准——系统空闲时一笔要多久。一切对比的分母，并发目标的推导输入。没有它，'P95 慢了 30%' 没有意义。",
  "_sample_size": "样本数 = 时长/单笔耗时。单笔 20s 时 300s 只有 15 个样本，P95 无意义；样本不足加 -e DURATION=1800s。",
  "scenario": {
    "executor": "constant-vus",
    "vus": 1, "duration": "300s"
  },
  "thresholds": {}
}
```

`perf/profiles/load.json`：

```json
{
  "name": "load",
  "description": "预期流量下是否满足 SLA。升-稳-降，稳态段为 SLA 观测窗。",
  "_override": "命令行覆盖仅作用于标量键：本 profile 的 stages 为字面量，换目标速率请编辑本文件或复制变体。速率档位应从生产真实流量推导，推导过程写在这里。",
  "scenario": {
    "executor": "ramping-arrival-rate",
    "startRate": 0, "timeUnit": "1s",
    "preAllocatedVUs": 20, "maxVUs": 100,
    "stages": [
      { "duration": "2m", "target": 20 },
      { "duration": "10m", "target": 20 },
      { "duration": "1m", "target": 0 }
    ]
  },
  "thresholds": {
    "_circuitBreaker": "两级线：严格线是跑完后的 verdict；宽松线+abortOnFail 是熔断器，只杀整体性业务拒绝（数据失效）的必死之局。宽松是刻意的——低吞吐下零星合法瞬时失败不能中止长跑；delayAbortEval 先让样本量积起来。",
    "perf_business_success": [
      { "threshold": "rate>0.99" },
      { "threshold": "rate>0.50", "abortOnFail": true, "delayAbortEval": "3m" }
    ]
  }
}
```

`perf/profiles/ladder.json`：

```json
{
  "name": "ladder",
  "description": "closed 模型阶梯升 VU——找容量拐点（TPS 不再随 VU 上升、P95 陡升即拐点）。",
  "_closed_model": "closed 模型：VU 发一收一，服务端变慢压力随之衰减，系统性低估过载后果。只用于找拐点；拐点之后的行为用 stress（open 模型）。",
  "_verdict": "只挂熔断线不挂 verdict 线：ladder 的通过标准是找到拐点而非验收；拐点之后的技术错误恰是要测量的对象，刻意不因此熔断。",
  "scenario": {
    "executor": "ramping-vus",
    "startVUs": 1, "gracefulRampDown": "30s",
    "stages": [
      { "duration": "60s", "target": 2 }, { "duration": "300s", "target": 2 },
      { "duration": "60s", "target": 4 }, { "duration": "300s", "target": 4 },
      { "duration": "60s", "target": 8 }, { "duration": "300s", "target": 8 },
      { "duration": "60s", "target": 12 }, { "duration": "300s", "target": 12 }
    ]
  },
  "thresholds": {
    "perf_business_success": [
      { "threshold": "rate>0.50", "abortOnFail": true, "delayAbortEval": "3m" }
    ]
  }
}
```

`perf/profiles/stress.json`：

```json
{
  "name": "stress",
  "description": "open 模型阶梯倍增——拐点之后系统怎么塌（arrival-rate 下队列真实堆积）。",
  "_verdict": "同 ladder：技术错误是测量对象，只挂业务成功率熔断线。",
  "scenario": {
    "executor": "ramping-arrival-rate",
    "startRate": 0, "timeUnit": "1s",
    "preAllocatedVUs": 50, "maxVUs": 200,
    "stages": [
      { "duration": "2m", "target": 20 },
      { "duration": "2m", "target": 40 },
      { "duration": "2m", "target": 60 },
      { "duration": "2m", "target": 80 },
      { "duration": "1m", "target": 0 }
    ]
  },
  "thresholds": {
    "perf_business_success": [
      { "threshold": "rate>0.50", "abortOnFail": true, "delayAbortEval": "3m" }
    ]
  }
}
```

`perf/profiles/spike.json`：

```json
{
  "name": "spike",
  "description": "突发流量：瞬间打至高位再回落（如行情剧烈波动时的集中交易）。",
  "scenario": {
    "executor": "ramping-arrival-rate",
    "startRate": 0, "timeUnit": "1s",
    "preAllocatedVUs": 50, "maxVUs": 200,
    "stages": [
      { "duration": "10s", "target": 100 },
      { "duration": "1m", "target": 100 },
      { "duration": "10s", "target": 20 },
      { "duration": "2m", "target": 20 }
    ]
  },
  "thresholds": {
    "perf_business_success": [
      { "threshold": "rate>0.99" },
      { "threshold": "rate>0.50", "abortOnFail": true, "delayAbortEval": "3m" }
    ]
  }
}
```

`perf/profiles/soak.json`：

```json
{
  "name": "soak",
  "description": "长时间中等负载 ≥2 小时——泄漏/资源耗尽类劣化。",
  "_data": "静态数据失效表现为整体性业务拒绝——宽松熔断线无论失效发生在启动时还是第 3 小时都会在几分钟内止损（preflight 只管'填没填'，不管'今天还有效吗'）。",
  "scenario": {
    "executor": "constant-arrival-rate",
    "rate": 10, "timeUnit": "1s", "duration": "2h",
    "preAllocatedVUs": 30, "maxVUs": 100
  },
  "thresholds": {
    "perf_business_success": [
      { "threshold": "rate>0.99" },
      { "threshold": "rate>0.50", "abortOnFail": true, "delayAbortEval": "3m" }
    ]
  }
}
```

- [ ] **Step 2: 重写 bootstrap.js** `perf/src/lib/bootstrap.js` 整体替换：

```js
// k6 场景装配层：集中 init 阶段的配置加载与 options/handleSummary 组装，
// 让场景文件只剩业务编排（meta + 数据 + 一次业务动作）。
// 本模块使用 k6 运行时全局量（open()/__ENV），只能被 k6 加载——
// 纯逻辑模块（config.js/sla.js/report.js/rows.js）保持 Node 可加载，职责勿混淆。
// open() 路径一律经 import.meta.resolve() 锚定到本文件。
import { parseEnvConfig } from './config.js';
import { buildThresholds } from './sla.js';
import { summarize, toMarkers } from './report.js';

export const ENV = __ENV.ENV || 'local';
export const PROFILE = __ENV.PROFILE || 'smoke';
export const TESTID = __ENV.TESTID || 'local-run';

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
 *   3. API 级（config/slas/）：perf_success_duration 分位数 SLA
 *   4. extra：场景专属附加（如 query 的空库守卫）
 */
export function buildOptions(slaFile, slaKey, extraThresholds) {
  const profile = JSON.parse(open(import.meta.resolve(`../../profiles/${PROFILE}.json`)));
  const scenario = applyOverrides(stripComments(profile.scenario));
  const sla = JSON.parse(open(import.meta.resolve(`../../config/slas/${slaFile}.json`)));
  const entry = sla[slaKey];
  if (!entry) throw new Error(`unknown SLA key: ${slaKey} in ${slaFile}`);
  return {
    scenarios: { main: scenario },
    thresholds: Object.assign(
      { perf_err_script: ['count==0'] },
      stripComments(profile.thresholds || {}),
      buildThresholds(entry),
      extraThresholds || {},
    ),
    summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)'],
  };
}

// 标准 handleSummary：stdout 标记 JSON（run.sh 从日志提取后出报告）。
// 场景以 `export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js'` 复用。
export function stdHandleSummary(data) {
  return { stdout: toMarkers(summarize(data, TESTID)) };
}
```

- [ ] **Step 3: 重写 sla.js** `perf/src/lib/sla.js` 整体替换：

```js
// SLA 条目 → API 级分位数阈值。挂在 perf_success_duration（只含业务成功请求的
// 耗时——快速拒绝会拉低分位数使容量虚高，SLA 对失败请求没有意义）。
// 错误率与熔断属于 profile 级（profiles/*.json），本模块不再生成。
export function buildThresholds(s) {
  for (const k of ['name', 'p95', 'p99']) {
    if (!(k in s)) throw new Error(`SLA missing ${k}`);
  }
  return {
    [`perf_success_duration{name:${s.name}}`]: [`p(95)<${s.p95}`, `p(99)<${s.p99}`],
  };
}
```

`perf/config/slas/trade-svc/trades.json` 整体替换（errorRate 字段废除）：

```json
{
  "query": { "name": "GET /api/v1/trades", "p95": 300, "p99": 800 },
  "create": { "name": "POST /api/v1/trades/create", "p95": 800, "p99": 2000 }
}
```

- [ ] **Step 4: 删除旧 profile 构建器**

```bash
git rm perf/src/profiles/index.js
rmdir perf/src/profiles 2>/dev/null || true
```

- [ ] **Step 5: 验证（7 profile × 2 场景 inspect + 阈值抽查 + 覆盖与封顶）**

```bash
cd perf
for p in smoke baseline load ladder stress spike soak; do
  for s in trades-query trades-create; do
    k6 inspect -e ENV=local -e PROFILE=$p "src/scenarios/$s.js" > /tmp/insp.json 2>/dev/null || { echo "FAIL $p/$s"; exit 1; }
  done
  echo "profile-$p-ok"
done
k6 inspect -e ENV=local -e PROFILE=load src/scenarios/trades-create.js 2>/dev/null | grep -c 'perf_success_duration{name:POST /api/v1/trades/create}\|perf_business_success\|perf_err_script'
k6 inspect -e ENV=local -e PROFILE=smoke -e MAX_VUS=9999 src/scenarios/trades-query.js 2>/dev/null | grep -o '"maxVUs": *500'
k6 inspect -e ENV=local -e PROFILE=soak -e RATE=5 -e DURATION=10m src/scenarios/trades-query.js 2>/dev/null | grep -c '"rate": *5\|"duration": *"10m"'
```

Expected：7 行 `profile-*-ok`；load 阈值抽查计数 ≥3（三层叠加齐全）；smoke + `MAX_VUS=9999` 时 maxVUs 输出为 **500**（覆盖先生效、硬上限再封顶：9999 → min(9999,500)=500）；soak 覆盖计数 2（rate=5 与 duration=10m 均生效）。

- [ ] **Step 6: 真实 smoke 回归（引擎+profile 全链路）**

```bash
cd perf
./deploy/run.sh -s trades-create -p smoke -e local --local
ls reports/ | tail -3
```

Expected：preflight 日志出现；约 1 分钟后 FAIL 判定（连接拒绝→technical→business_success rate 0→smoke 严格线失败）；reports/ 产出 .log/.json/.html；run.sh 退出码 1（汇总表 FAIL 行）。

- [ ] **Step 7: 提交**

```bash
git add -A perf/profiles perf/src/lib perf/config/slas
git commit -m "feat(perf): profile JSON 声明式（7 个含 baseline/ladder）+ 两级熔断 + SLA 切源 perf_success_duration"
```

---

### Task 5: 报告三分类呈现、dashboard 与文档同步、端到端验证

**Files:**
- Modify: `perf/src/lib/report.js`（summarize/toHtml 更新）、`perf/dashboards/perf-trade-business.json`（整体替换）、`perf/README.md`、`perf/docs/env-checklist.md`、`docs/superpowers/specs/2026-07-31-k6-perf-framework-design.md`（§3 目录树）

**Interfaces:**
- Consumes: 全部前序任务
- Produces: summary JSON 新增字段 `ok/errTechnical/errBusiness/errScript/businessSuccessRate/successLatencyMs`（既有字段保留，`checksRate` 移除）；HTML 报告三分类行；dashboard 面板对齐 `k6_perf_*` 指标

- [ ] **Step 1: report.js 更新**——`summarize` 与 `toHtml` 整体替换为（文件其余部分不动）：

```js
export function summarize(data, testid) {
  return {
    testid,
    requests: val(data, 'http_reqs', 'count', 0),
    rps: val(data, 'http_reqs', 'rate', 0),
    // 三分类：报告必须分开呈现——混成一个错误率无法回答"是开发问题还是数据问题"
    ok: val(data, 'perf_ok', 'count', 0),
    errTechnical: val(data, 'perf_err_technical', 'count', 0),
    errBusiness: val(data, 'perf_err_business', 'count', 0),
    errScript: val(data, 'perf_err_script', 'count', 0),
    businessSuccessRate: val(data, 'perf_business_success', 'rate', null),
    // 全请求延迟（含失败）与业务成功延迟并列——两者差距本身就是信号
    latencyMs: {
      p50: val(data, 'http_req_duration', 'med', null),
      p95: val(data, 'http_req_duration', 'p(95)', null),
      p99: val(data, 'http_req_duration', 'p(99)', null),
    },
    successLatencyMs: {
      p50: val(data, 'perf_success_duration', 'med', null),
      p95: val(data, 'perf_success_duration', 'p(95)', null),
      p99: val(data, 'perf_success_duration', 'p(99)', null),
    },
    errorRate: val(data, 'http_req_failed', 'rate', 0),
    thresholdFailures: Object.entries(data.metrics)
      .filter(([, m]) => m.thresholds && Object.values(m.thresholds).some((t) => !t.ok))
      .map(([name]) => name),
  };
}

export function toHtml(s) {
  const verdict = s.thresholdFailures.length === 0 ? 'PASS' : 'FAIL';
  const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  const lat = (o) => (o ? `p50=${o.p50} / p95=${o.p95} / p99=${o.p99}` : '-');
  return `<!doctype html><meta charset="utf-8"><title>${s.testid}</title>
<h1>${s.testid} &mdash; ${verdict}</h1><table border="1" cellpadding="6">
${row('requests', s.requests)}${row('rps', Number(s.rps).toFixed(1))}
${row('ok / technical / business / script', `${s.ok} / ${s.errTechnical} / ${s.errBusiness} / ${s.errScript}`)}
${row('business success rate', s.businessSuccessRate === null ? '-' : s.businessSuccessRate)}
${row('latency all (ms)', lat(s.latencyMs))}
${row('latency success-only (ms)', lat(s.successLatencyMs))}
${row('http error rate', s.errorRate)}
${row('failed thresholds', s.thresholdFailures.join(', ') || 'none')}
</table>`;
}
```

- [ ] **Step 2: dashboard 更新** `perf/dashboards/perf-trade-business.json` 整体替换：

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
        "query": "label_values(k6_perf_ok_total, testid)",
        "refresh": 2,
        "sort": 2
      }
    ]
  },
  "panels": [
    {
      "title": "success-only duration p95/p99 (ms) — SLA 观测对象",
      "type": "timeseries",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "targets": [
        { "expr": "k6_perf_success_duration_p95{testid=\"$testid\"}", "legendFormat": "p95" },
        { "expr": "k6_perf_success_duration_p99{testid=\"$testid\"}", "legendFormat": "p99" }
      ]
    },
    {
      "title": "errors per second by class",
      "type": "timeseries",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "targets": [
        { "expr": "rate(k6_perf_err_technical_total{testid=\"$testid\"}[1m])", "legendFormat": "technical" },
        { "expr": "rate(k6_perf_err_business_total{testid=\"$testid\"}[1m])", "legendFormat": "business" },
        { "expr": "rate(k6_perf_err_script_total{testid=\"$testid\"}[1m])", "legendFormat": "script" }
      ]
    },
    {
      "title": "business success rate",
      "type": "timeseries",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 8 },
      "targets": [
        { "expr": "k6_perf_business_success{testid=\"$testid\"}", "legendFormat": "success rate" }
      ]
    },
    {
      "title": "business errors by data row (数据坏行定位)",
      "type": "timeseries",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 8 },
      "targets": [
        { "expr": "sum by (row, reason) (rate(k6_perf_err_business_total{testid=\"$testid\"}[1m]))", "legendFormat": "row {{row}} {{reason}}" }
      ]
    }
  ]
}
```

- [ ] **Step 3: README 与 env-checklist 同步**

`perf/README.md` 的"目录结构"与"约定"两节整体替换为：

```markdown
## 目录结构

- `config/environments/` 环境（服务地址映射、白名单、promRwUrl、身份池）；**仓库内全部为 localhost/示例占位，真实值仅在内网填写；没有也不允许有 prod**
- `config/slas/` 按 服务/模块 组织的 API 级分位数 SLA（挂 perf_success_duration；错误率与熔断属 profile 级）
- `profiles/` 负载 profile（JSON 声明式，scenario 块即 k6 executor 原文；`_` 开头键为注释；smoke/baseline/load/ladder/stress/spike/soak 七个，方法论见各文件 description）
- `data/trade-svc/` 每 API 专属数据：查询字段池 + create 用例池（一行=一个完整同源用例，纪律见 `data/trade-svc/README.md`）；`data/datfiles/products/<productType>/` dat 样本（占位，须真实采集替换）
- `src/lib` 纯逻辑模块（config/users/data/rows/sla/report，Node 可加载）+ k6 侧模块（http.js 纯发送管道、errors.js 三分类引擎、bootstrap.js 场景装配）
- `src/api/<service>/` API 客户端层：`<module>.js`（请求构造+响应契约分类）与 `<module>-data.js`（用例池实例化+dat 预载）
- `src/setup/` preflight（本地数据闸，setup 阶段不发请求）
- `src/scenarios` 场景入口（meta + 数据 + 一次业务动作）
- `deploy/` run.sh 与 Job 模板（镜像/脚本注入由公司侧机制提供）；`dashboards/` Grafana JSON
- `tools/` meta 提取、报告提取/渲染

## 约定

- 场景文件必须导出静态 `meta = { tags: [...] }`；`P0/P1/P2` tag 表达优先级
- `run.sh --tags` 是框架参数（用例选择）；k6 的 `--tag` 是指标标签，由 run.sh 注入 testid
- **错误三分类**：technical（性能结论）/ business（通常是数据问题）/ script（本轮作废）必须分开看；SLA 分位数只看 `perf_success_duration`（业务成功请求）
- 数据取数一律全局游标（`exec.scenario.iterationInTest`）；指标 tag 只允许有界取值，严禁 tradeId 类唯一值
- 新增写路径 API：`src/api/<service>/` 加 `<api>.js`（契约）+ `<api>-data.js`（用例池）+ `data/<service>/<scenario>.json` 用例文件 + preflight；新增读路径 API：加 `<api>.js` 用 `classifyRead` + 字段池数据文件
- RATE/VUS/DURATION/MAX_VUS 覆盖仅作用于 profile 中存在的同名标量键（stages 字面量不受影响）；本地直跑 `k6 run -e VUS=8 ...` 可用全部覆盖，run.sh 暂只透传 RATE/DURATION
```

`perf/docs/env-checklist.md` 中三处修改：
1. 原"用真实 FX_TRF.dat 替换…"一条替换为：

```markdown
- [ ] 用例池同源采集：系统 Web 界面建单 + DevTools 对 POST /trades/create Copy as cURL，逐行填入 `data/trade-svc/trades-create.json`（归属三字段整组同源，勿拼装；真实 .dat 另存 `data/datfiles/products/<productType>/`；每换 productType/counterparty 采一次；采集样本放 `_samples/` 不入库）；验证同一 dat 高频重复提交是否触发幂等/去重/日期校验（遗留问题 #4）
```

2. 原"create 响应结构核对"一条替换为：

```markdown
- [ ] create/query 响应契约核对：create 成功契约按校准版实现（code=200 + status='PENDING APPROVAL' + data.trade.id ~ TRD-\d+），首跑确认版本未变；query 假设响应含 `trades` 数组且行数>0（perf_trades_rows 空库守卫）
```

3. 追加一条：

```markdown
- [ ] 首跑核对三分类归因：故意用一行错误数据跑 smoke，确认报告中 business 类与 row tag 正确归因后再恢复
```

`docs/superpowers/specs/2026-07-31-k6-perf-framework-design.md` §3 目录树中：`│   ├── profiles/` 行从 src/ 下移到 perf/ 顶层（`├── profiles/            # 负载 profile（JSON 声明式，见 §4）`）；src/ 下删除 payloads/ 与 profiles/ 两行、增加 `│   ├── setup/              # preflight（本地数据闸）` 与 api 层 `<module>-data.js` 说明；lib 行的模块清单同步（含 rows.js/errors.js，去 metrics.js）。

- [ ] **Step 4: 端到端验证**

```bash
cd perf
node --input-type=module -e "
import('./src/lib/config.js'); import('./src/lib/rows.js'); import('./src/lib/data.js');
import('./src/lib/sla.js'); import('./src/lib/report.js'); import('./src/lib/users.js');
console.log('pure-modules-ok')"
node tools/scenario-meta.mjs src/scenarios P0
./deploy/run.sh --tags P0 -p smoke -e local --local; echo "suite-exit=$?"
ls reports/ | tail -6
node -e "const fs=require('fs');const f=fs.readdirSync('reports').filter(x=>x.endsWith('.json')).sort().pop();const s=JSON.parse(fs.readFileSync('reports/'+f,'utf8'));if(!('errTechnical' in s)||!('successLatencyMs' in s))throw new Error('summary 缺新字段');console.log('summary-fields-ok', 'technical='+s.errTechnical)"
node -e "for (const f of ['dashboards/perf-trade-business.json']) JSON.parse(require('fs').readFileSync(f,'utf8')); console.log('dashboard-valid')"
grep -RIn 'http://' config src deploy data profiles | grep -v localhost && echo LEAK || echo no-internal-hosts
grep -rin 'oreo' . --exclude-dir=reports --exclude-dir=node_modules && echo CODENAME-LEAK || echo no-codename
```

Expected：`pure-modules-ok`；meta 列出两场景；套件真跑两场景均 FAIL（连接拒绝，technical 分类）但**汇总表完整打印**、suite-exit=1；summary JSON 含新字段且 `errTechnical>0`；`dashboard-valid`；`no-internal-hosts`；`no-codename`。

- [ ] **Step 5: 提交**

```bash
git add -A perf docs/superpowers/specs
git commit -m "docs(perf): 报告三分类呈现、dashboard 对齐 perf_* 指标、README/清单/spec 同步"
```

---

## Spec 覆盖对照（自检记录）

| Spec 修订点 | 实现任务 |
|---|---|
| §4 profile JSON 声明式 + 七集合 + 覆盖/封顶 + 阈值两维叠加 | Task 4 |
| §5 三分类引擎 + reason + 限流日志 + success-only duration + create 校准契约 | Task 2、3 |
| §6 用例行模型 + 同源纪律 + __row + 全局游标 + 变体池 + dat 每行引用 + preflight + 读路径字段池 + clientRef 作废 | Task 1、3 |
| §7 SLA 切源 perf_success_duration + 两级熔断 | Task 4 |
| §8 dashboard 新指标集 | Task 5 |
| §5 三类分开呈现（报告侧） | Task 5 |
| §11-3/4/4b 遗留问题落到 env-checklist | Task 5 |
| §13 保留清单（--tags/k8s/报告管道/白名单/硬上限）不动 | 全程约束 |

中间态说明：Task 1-3 期间 `k6 inspect` 存在预期失败窗口（Task 1 后 query 场景引用旧 pick、Task 2 后场景引用已删 metrics.js），各任务以自身验证命令为验收；Task 3 起 inspect 恢复全绿。执行层（run.sh/job.yaml/extract/render CLI）零改动。
