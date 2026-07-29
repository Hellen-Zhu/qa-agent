/*
 * steps/workers/trade-management/trades-list.js
 *
 * 【层级】原子步骤 —— 一个 API 一个文件
 * 【API】  workers.trade-management.list  ·  GET /trades
 * 【对应】jmx/fragments/steps/workers/trade-management/trades-list.jmx
 *        + groovy/build-trades-query.groovy + trades-record-rowcount.groovy
 *
 * ══ 这是全系统请求量最大的路径 ═══════════════════════════════════
 * Trade Portal 单页含多个 blotter，每个是一次独立列表查询，且自动刷新：
 *   稳态 TPS = 并发用户数 × 每页 blotter 数(A10) ÷ 刷新间隔(A11)
 *            = 31 × 4 ÷ 30 ≈ 4.13 恒定；设计容量 33 TPS（Workload §6）。
 *
 * ⚠ 本接口走 UC gRPC 富化（依赖影响面第一）。若富化是逐行 N+1，
 *   33 TPS 列表 = 6,600 QPS gRPC —— S-09 扇出审计的被测对象。
 * ═══════════════════════════════════════════════════════════════
 *
 * ── blotter 列表与按 ref 定位共用本文件 ──
 * 同一个端点、同一份契约，差异只是查询参数（与 JMeter 侧 R2 规则一致）：
 *   opts.search 有值 → search 定位；无值 → blotter 整页（size/page）。
 *
 * ⚠ 参数名 size / page / search / status 是**推断值**（继承 JMeter 侧的
 *   同一假设，见 build-trades-query.groovy）。猜错的表现是服务端忽略
 *   未知参数、返回默认页 —— **会静默错**。所以：
 *   1) 首次 smoke 必须人工核对返回行数 == 请求 size；
 *   2) 本步骤在行数不符时记 oreo_trades_rows_mismatch 并告警。
 */

import http from 'k6/http';
import { Trend, Counter } from 'k6/metrics';
import { cfg } from '../../../lib/config.js';
import { classifyRead, ERR } from '../../../lib/errors.js';

const URL = `${cfg.workersUrl}/trades`;

// 返回行数：列表延迟数字的必备注脚（KPI §5.8）。
// "P95=1.2s" 在返回 50 行和 500 行时含义完全不同。
// 对应 jtl 的 tradesRowCount 列 —— k6 里行数进 Trend，请求的 size 进低基数 tag。
export const tRows = new Trend('oreo_trades_rows');
export const cRowsMismatch = new Counter('oreo_trades_rows_mismatch');

/** 查询串构造。对应 build-trades-query.groovy，分支逐条一致。 */
export function buildTradesQuery(opts) {
  const parts = [];
  const search = (opts.search || '').trim();
  if (search) {
    parts.push('search=' + encodeURIComponent(search));
  } else {
    parts.push('size=' + (opts.pageSize || 200));
    parts.push('page=' + (opts.page || 0));
  }
  if (opts.status) parts.push('status=' + encodeURIComponent(opts.status));
  return parts.join('&');
}

/**
 * 从响应体提取返回行数。对应 trades-record-rowcount.groovy 的三种形态：
 *   data 直接是数组 / Spring Page 的 data.content / data.items
 * 都不匹配返回 -1（形态未知 ≠ 出错 —— 可能是没见过的分页包装）。
 */
export function extractRowCount(body) {
  const d = body ? body.data : null;
  if (Array.isArray(d)) return d.length;
  if (d && Array.isArray(d.content)) return d.content.length;
  if (d && Array.isArray(d.items)) return d.items.length;
  return -1;
}

/** 库内总量（若分页元数据里有）。进入准则 #3 的"数据量声明"用。 */
export function extractTotal(body) {
  const d = body ? body.data : null;
  if (d && typeof d.totalElements === 'number') return d.totalElements; // Spring Page
  if (d && typeof d.total === 'number') return d.total;
  return -1;
}

let warnedMismatch = false; // 每个 VU 只告警一次，避免刷屏

/**
 * 发一次列表查询。**唯一的请求出口。**
 *
 * @param {Object} [opts]
 * @param {string} [opts.runPhase]  'setup' | 'main'，默认 'main'
 * @param {number} [opts.pageSize]  blotter 整页大小，默认 200（A17）
 * @param {number} [opts.page]      页码，默认 0
 * @param {string} [opts.search]    有值则走 search 定位模式
 * @param {string} [opts.status]    可选状态过滤
 * @param {string} [opts.userId]    默认 maker
 * @returns {{res, errClass, detail, rowCount, total, tags}}
 */
export function tradesList(opts) {
  const o = opts || {};
  const pageSize = o.pageSize || 200;
  const searchMode = !!(o.search && String(o.search).trim());

  const tags = {
    name: 'workers_trademgmt_list',
    runPhase: o.runPhase || 'main',
    // 低基数：取值来自扫描档位（50/200/500），不是自由值
    pageSize: searchMode ? 'search' : String(pageSize),
  };

  const res = http.get(`${URL}?${buildTradesQuery(o)}`, {
    headers: {
      accept: '*/*',
      'X-User-ID': o.userId || cfg.makerUserId,
      'X-User-Id': o.userId || cfg.makerUserId,
      'X-Dyn-Run': cfg.dynRun,
    },
    timeout: cfg.requestTimeout,
    tags: tags,
  });

  const out = classifyRead(res, tags);

  let rowCount = -1;
  let total = -1;
  if (out.errClass === ERR.OK) {
    rowCount = extractRowCount(out.body);
    total = extractTotal(out.body);
    if (rowCount >= 0) tRows.add(rowCount, tags);

    // 行数与请求 size 不符：留线索但不判失败 —— 可能只是库里就这么多数据。
    // 若库量远大于 size 仍不符，基本可断定分页参数名猜错了。
    if (!searchMode && rowCount >= 0 && rowCount !== pageSize) {
      cRowsMismatch.add(1, tags);
      if (!warnedMismatch) {
        warnedMismatch = true;
        console.warn(
          `GET /trades 返回 ${rowCount} 行，请求 size=${pageSize}` +
          (total >= 0 ? `（库内总量 ${total}）` : '') +
          ' —— 若差距无法用数据量解释，检查分页参数名（见本文件头部注释）'
        );
      }
    }
  }

  return Object.assign({ res, tags, rowCount, total }, out);
}
