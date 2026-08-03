import * as client from '../../../lib/http.js';
import { classifyRead } from '../../../lib/errors.js';

const SVC = 'worker-svc';
const MOD = 'trade';

/*
 * GET /api/v1/trades/{tradeId}/risk-metrics——风险指标读取（P0 清单，2026-08-03）。
 * 契约假设宽松（响应含 data 键即可），真实结构内网首跑采集后收紧（env-checklist）。
 */
export function getRiskMetrics(cfg, tradeId, user) {
  const { res, tags } = client.get(cfg, SVC, `/api/v1/trades/${encodeURIComponent(tradeId)}/risk-metrics`, {
    name: 'GET /api/v1/trades/{tradeId}/risk-metrics', module: MOD, user,
  });
  return classifyRead(res, tags, (body) =>
    body && body.data !== undefined
      ? null
      : `响应缺少 data — keys=${Object.keys(body || {}).slice(0, 8).join(',')}`
  );
}
