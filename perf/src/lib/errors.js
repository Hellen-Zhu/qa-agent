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
import { check } from 'k6';
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
 * 高并发大面积失败时日志 I/O 不反噬压力机；计数看指标（逐请求明细导出机制列入 P1b）。
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

  // 官方 19665 板桥接：其 Checks 面板读 k6_checks_rate，而本框架不以 check() 作
  // 断言（三分类才是判定权威）。这里仅把业务成败镜像成一条 check，让 19665 的
  // Checks Success Rate 大卡直接显示业务成功率——它的 failed rate 是 http_req_failed
  // （HTTP 层），本系统业务失败也返回 200，没有这条桥官方板讲不了业务层的故事。
  check(ok, { 'business success': (v) => v }, tags);
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
