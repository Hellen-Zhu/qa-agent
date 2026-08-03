import * as client from '../../../lib/http.js';
import { classifyRead } from '../../../lib/errors.js';

const SVC = 'worker-svc';
const MOD = 'trade';

/*
 * GET /api/v1/trades/{id}——id 进 URL 路径，name tag 用花括号占位符归一化
 * （动态 id 进 tag 会引爆 Prometheus 基数，README 纪律）。
 * 契约假设（内网首跑校准，env-checklist）：响应含 data.trade 且 id 回显一致。
 */
export function getTrade(cfg, id, user) {
  const { res, tags } = client.get(cfg, SVC, `/api/v1/trades/${encodeURIComponent(id)}`, {
    name: 'GET /api/v1/trades/{id}', module: MOD, user,
  });
  return classifyRead(res, tags, (body) => {
    const t = body && body.data && body.data.trade;
    if (!t) return `响应缺少 data.trade — keys=${Object.keys(body || {}).slice(0, 8).join(',')}`;
    // 拿回的必须是请求的那笔——串号是服务端或脚本缺陷，不是性能问题
    return String(t.id) === String(id) ? null : `返回 trade.id='${t.id}' ≠ 请求 '${id}'`;
  });
}
