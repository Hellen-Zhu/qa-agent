/*
 * lib/errors.js —— 三类错误分离
 *
 * 对应 groovy/assert-create-response.groovy。逻辑逐条一致，两边结论才可比。
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
 * ⚠ 标签基数（cardinality）—— k6 与 JMeter 的一个关键差异：
 *   JMeter 的 sample_variables 把业务字段写成 **jtl 的列**，多少种值都无所谓。
 *   k6 的 tag 是 **指标的维度**，高基数标签会让内存和 Prometheus 存储爆炸。
 *
 *   → 可以打标签：runPhase / caseId / productType / pairId / errClass（各几个值）
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

/**
 * 判定一次 create 响应属于哪一类。
 * 与 assert-create-response.groovy 的分支顺序完全一致。
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
    record(ERR.TECHNICAL, t, res);
    return {
      errClass: ERR.TECHNICAL,
      detail: `technical: HTTP ${res.status}${res.error ? ' ' + res.error : ''}`,
      tradeId: 'NOT_FOUND',
      taskId: 'NOT_FOUND',
    };
  }

  // ── 类别 3：响应不是 JSON ──
  let body;
  try {
    body = res.json();
  } catch (e) {
    record(ERR.SCRIPT, t, res);
    return {
      errClass: ERR.SCRIPT,
      detail: `script: response is not JSON — ${e.message}`,
      tradeId: 'NOT_FOUND',
      taskId: 'NOT_FOUND',
    };
  }

  // ── 类别 2：业务拒绝 ──
  if (body.code !== 200 || body.status !== 'PENDING APPROVAL') {
    record(ERR.BUSINESS, t, res);
    return {
      errClass: ERR.BUSINESS,
      detail: `business: code=${body.code} status=${body.status} msg=${body.msg}`,
      tradeId: 'NOT_FOUND',
      taskId: 'NOT_FOUND',
    };
  }

  // ── 成功路径：结构完整性 ──
  // 校验格式而不只是非空：提取失败时的兜底值也是非空字符串，
  // 会被"非空"这种弱断言放过去。
  const tradeId = body.data && body.data.trade ? String(body.data.trade.id || '') : '';
  if (!/^TRD-\d+$/.test(tradeId)) {
    record(ERR.SCRIPT, t, res);
    return {
      errClass: ERR.SCRIPT,
      detail: `script: unexpected tradeId format — '${tradeId}'`,
      tradeId: 'NOT_FOUND',
      taskId: 'NOT_FOUND',
    };
  }

  // taskId 目前只存在于 msg 的自然语言里：
  //   "Submitted for checker approval. TaskId: CHK-98C0DF19"
  // 只能正则捞，文案一改就断（已作为 improvement 提给开发）。
  const m = /TaskId:\s*(CHK-[A-Za-z0-9]+)/.exec(String(body.msg || ''));

  record(ERR.OK, t, res);
  return {
    errClass: ERR.OK,
    detail: 'ok',
    tradeId,
    taskId: m ? m[1] : 'NOT_FOUND',
  };
}

function record(errClass, tags, res) {
  const t = Object.assign({}, tags, { errClass });
  const ok = errClass === ERR.OK;

  if (ok) cOk.add(1, t);
  else if (errClass === ERR.TECHNICAL) cTechnical.add(1, t);
  else if (errClass === ERR.BUSINESS) cBusiness.add(1, t);
  else cScript.add(1, t);

  rBusinessSuccess.add(ok, tags);
  if (ok) tSuccessDuration.add(res.timings.duration, tags);
}
