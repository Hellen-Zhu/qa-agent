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
