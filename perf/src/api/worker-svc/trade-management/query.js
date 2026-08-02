/*
 * trade-management 读路径客户端：独立于 create 数据图（-data.js 的用例池 + dat 预载）。
 * 拆分理由（终审 #4）：契约文件原来在模块顶层 import 数据文件（create 专属），
 * 导致 trades-query 场景经 trades.js 传递性加载了整套 create 用例池与全部 dat 二进制——
 * 任何 create 数据坏了都会拖垮 query 场景的 init，且每个 query VU 白白多背一份 dat 内存。
 * 本文件只做只读端点：查询无可断言的业务拒绝形态，契约只有结构校验。
 */
import * as client from '../../../lib/http.js';
import { classifyRead, ERR } from '../../../lib/errors.js';
import { Trend } from 'k6/metrics';

const SVC = 'worker-svc';
const MOD = 'trade-management';

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
