/*
 * lib/errors.js —— 三类错误分离
 *
 * ══ 为什么不能只看 HTTP 状态码 ═══════════════════════════════
 * 这个接口**业务失败时照样返回 HTTP 200**，业务状态在 body 的 code / status 里。
 * 只看状态码的报告会显示"错误率 0%"，而实际一条 trade 都没建成。
 * 这是本项目最容易产出误导性报告的地方。
 *
 * ══ 三类必须分开，因为处置方式完全不同 ═══════════════════════
 *   technical  连接失败 / 超时 / 5xx      → 系统扛不住，**这才是性能结论**
 *   business   HTTP 200 但业务拒绝         → 多半是测试数据失效，不是性能问题
 *   script     提取不到值 / 响应不是 JSON  → 脚本 bug，**整轮结果作废**
 * 混在一个"错误率"里的报告没法用：12% 错误率到底该找开发还是该修数据？
 * ═══════════════════════════════════════════════════════════
 *
 * ⚠ 标签基数（cardinality）：
 *   k6 的 tag 是 **指标的维度**，高基数标签会让内存和 Prometheus 存储爆炸。
 *
 *   → 可以打标签：runPhase / caseId / productType / errClass / reason（各几个有界值）
 *   → **绝对不要**打标签：tradeId / taskId / tradeReference（每次请求都不同）
 *   需要逐笔明细时用 --out csv 或结构化日志，不要塞进 tag。
 */

import { Counter, Rate, Trend } from 'k6/metrics';

// ── 计数器：四个互斥类别，加起来等于总请求数 ────────────────
export const cOk = new Counter('oreo_ok');
export const cTechnical = new Counter('oreo_err_technical');
export const cBusiness = new Counter('oreo_err_business');
export const cScript = new Counter('oreo_err_script');

// ── 业务成功率：这才是"错误率"该看的那个数，不是 http_req_failed ──
export const rBusinessSuccess = new Rate('oreo_business_success');

// ── 只统计**业务成功**那些请求的耗时 ──────────────────────────
// 失败请求（尤其是快速拒绝）会把 P95 拉低，让容量看起来比实际好。
export const tSuccessDuration = new Trend('oreo_success_duration', true);

export const ERR = {
  OK: 'ok',
  TECHNICAL: 'technical',
  BUSINESS: 'business',
  SCRIPT: 'script',
};

/*
 * ── reason：失败原因维度（低基数）────────────────────────────
 * errClass 回答"该找谁"（开发 / 数据 / 脚本），reason 回答"具体怎么了"。
 * 没有它，一次跑出 40 个 business 只是一个数字 —— dat 竞态、归属字段
 * 失效、重复提交全混在一起，定位还得靠翻 CSV 猜。
 *
 * ⚠ reason 会成为指标维度，只允许**有界**取值：
 *   模式表槽位 + 服务端 code 枚举 + HTTP 状态码，全部有界。
 *   **绝不能把 msg 原文当 reason** —— 自由文本无界，等同把 tradeId 打进 tag。
 */

// 业务拒绝归因模式表：按真实观测的 msg 逐条校准、补充。
// 现场原文靠下方 logFailure 的限流日志采集 → 回填到这里。
const BIZ_PATTERNS = [
  // 服务端临时文件竞态：并发同刻上传、时间戳撞名后文件被先完成方删除
  // （缺陷论证与绕行开关见 data/dat/README.md「服务端临时文件竞态」）
  { reason: 'dat-missing', re: /(dat|file).*(not\s*found|missing|不存在)|找不到/i },
];

export function bizReason(body) {
  const msg = String((body && body.msg) || '');
  for (let i = 0; i < BIZ_PATTERNS.length; i++) {
    if (BIZ_PATTERNS[i].re.test(msg)) return BIZ_PATTERNS[i].reason;
  }
  // 兜底用服务端业务 code：后端枚举值，天然有界
  const code = body && body.code;
  return typeof code === 'number' ? 'code-' + code : 'code-unknown';
}

export function techReason(res) {
  // status=0 是连接层失败（超时/拒绝/DNS），error_code 是 k6 的有界错误枚举
  return res.status > 0 ? 'http-' + res.status : 'net-' + (res.error_code || 0);
}

/*
 * ── 限流的现场日志 ──────────────────────────────────────────
 * 之前失败只进计数器，k6.log 里一条现场都看不到，出问题只能事后翻 CSV。
 * 但也不能全量打：高并发下大面积失败时 console I/O 本身会挤占压力机，
 * 且几千条相同日志没有信息增量。折中：**每 VU 每种 (errClass, reason)
 * 详打前 3 条**，之后静默 —— 计数在指标里，逐笔明细在 result.csv。
 */
const LOG_CAP = 3;
const logSeen = {}; // 每个 VU 独立 VM，天然按 VU 隔离

export function logFailure(errClass, reason, detail, tags) {
  const key = errClass + '|' + reason;
  const n = (logSeen[key] = (logSeen[key] || 0) + 1);
  if (n > LOG_CAP) return;
  const t = tags || {};
  const tail = n === LOG_CAP
    ? ` —— 本 VU 此类日志已达 ${LOG_CAP} 条，后续静默（计数看指标，逐笔看 result.csv）`
    : '';
  console.warn(`✗ [${errClass}/${reason}] case=${t.caseId || 'NA'} phase=${t.runPhase || 'NA'} ${detail}${tail}`);
}

/**
 * 判定一次 create 响应属于哪一类。
 * 分支顺序即判定优先级，不要调换。
 *
 * @param {Object} res  k6 的 Response
 * @param {Object} tags 低基数标签，会附加到所有指标上
 * @returns {{errClass: string, detail: string, tradeId: string, taskId: string}}
 */
export function classifyCreate(res, tags) {
  const t = tags || {};

  // ── 类别 1：技术失败 ──
  // res.status === 0 表示连接层就失败了（超时 / 拒绝 / DNS）——
  // 这种情况 res.body 是 null，必须先挡住。
  if (res.status !== 200) {
    const reason = techReason(res);
    const detail = `technical: HTTP ${res.status}${res.error ? ' ' + res.error : ''}`;
    recordOutcome(ERR.TECHNICAL, t, res, reason);
    logFailure(ERR.TECHNICAL, reason, detail, t);
    return { errClass: ERR.TECHNICAL, detail, tradeId: 'NOT_FOUND', taskId: 'NOT_FOUND' };
  }

  // ── 类别 3：响应不是 JSON ──
  let body;
  try {
    body = res.json();
  } catch (e) {
    const detail = `script: response is not JSON — ${e.message}`;
    recordOutcome(ERR.SCRIPT, t, res, 'not-json');
    logFailure(ERR.SCRIPT, 'not-json', detail, t);
    return { errClass: ERR.SCRIPT, detail, tradeId: 'NOT_FOUND', taskId: 'NOT_FOUND' };
  }

  // ── 类别 2：业务拒绝 ──
  if (body.code !== 200 || body.status !== 'PENDING APPROVAL') {
    const reason = bizReason(body);
    // msg 截断：响应文案可能整段堆栈，日志与 detail 只要开头就够定位
    const detail = `business: code=${body.code} status=${body.status} msg=${String(body.msg || '').slice(0, 160)}`;
    recordOutcome(ERR.BUSINESS, t, res, reason);
    logFailure(ERR.BUSINESS, reason, detail, t);
    return { errClass: ERR.BUSINESS, detail, tradeId: 'NOT_FOUND', taskId: 'NOT_FOUND' };
  }

  // ── 成功路径：结构完整性 ──
  // 校验格式而不只是非空：提取失败时的兜底值也是非空字符串，
  // 会被"非空"这种弱断言放过去。
  const tradeId = body.data && body.data.trade ? String(body.data.trade.id || '') : '';
  if (!/^TRD-\d+$/.test(tradeId)) {
    const detail = `script: unexpected tradeId format — '${tradeId}'`;
    recordOutcome(ERR.SCRIPT, t, res, 'shape');
    logFailure(ERR.SCRIPT, 'shape', detail, t);
    return { errClass: ERR.SCRIPT, detail, tradeId: 'NOT_FOUND', taskId: 'NOT_FOUND' };
  }

  // taskId 目前只存在于 msg 的自然语言里：
  //   "Submitted for checker approval. TaskId: CHK-98C0DF19"
  // 只能正则捞，文案一改就断（已作为 improvement 提给开发）。
  const m = /TaskId:\s*(CHK-[A-Za-z0-9]+)/.exec(String(body.msg || ''));

  recordOutcome(ERR.OK, t, res);
  return {
    errClass: ERR.OK,
    detail: 'ok',
    tradeId,
    taskId: m ? m[1] : 'NOT_FOUND',
  };
}

/**
 * 把一次请求的判定结果记进全部指标。**所有步骤的唯一记账出口** ——
 * 新步骤不要自己 new Counter 重复三类分离，调这里。
 *
 * @param {string} [reason] 失败原因（有界值，见上方 reason 段）。
 *                 只挂在错误计数器上 —— 成功没有"原因"，Rate/Trend 不需要该维度。
 */
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

/**
 * 只读 JSON 接口的通用判定（trades-list / trade-detail / refdata 列表）。
 *
 * 与 classifyCreate 的差别：这些接口没有已确认的"业务拒绝"形态
 * （读接口拿不到 PENDING APPROVAL 这类业务状态可断言），
 * 所以只产出 technical / script / ok 三种结果。哪天确认了读接口的
 * 业务错误码形态，在 validate 回调里判并把这里升级成四类。
 *
 * @param {Object}   res      k6 Response
 * @param {Object}   tags     低基数标签
 * @param {Function} [validate] (body) => 问题描述|null。
 *                   结构不符（列名猜错、data 不是数组）是**脚本侧**问题 → script 类。
 * @returns {{errClass, detail, body}}  body 仅在 JSON 解析成功时非 null
 */
export function classifyRead(res, tags, validate) {
  if (res.status !== 200) {
    const reason = techReason(res);
    const detail = `technical: HTTP ${res.status}${res.error ? ' ' + res.error : ''}`;
    recordOutcome(ERR.TECHNICAL, tags, res, reason);
    logFailure(ERR.TECHNICAL, reason, detail, tags);
    return { errClass: ERR.TECHNICAL, detail, body: null };
  }

  let body;
  try {
    body = res.json();
  } catch (e) {
    const detail = `script: response is not JSON — ${e.message}`;
    recordOutcome(ERR.SCRIPT, tags, res, 'not-json');
    logFailure(ERR.SCRIPT, 'not-json', detail, tags);
    return { errClass: ERR.SCRIPT, detail, body: null };
  }

  const problem = validate ? validate(body) : null;
  if (problem) {
    const detail = `script: ${problem}`;
    recordOutcome(ERR.SCRIPT, tags, res, 'shape');
    logFailure(ERR.SCRIPT, 'shape', detail, tags);
    return { errClass: ERR.SCRIPT, detail, body };
  }

  recordOutcome(ERR.OK, tags, res);
  return { errClass: ERR.OK, detail: 'ok', body };
}
