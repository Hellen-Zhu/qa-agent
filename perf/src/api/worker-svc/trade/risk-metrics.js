import * as client from '../../../lib/http.js';
import { classifyRead } from '../../../lib/errors.js';

const SVC = 'worker-svc';
const MOD = 'trade';

/*
 * GET /api/v1/trades/{tradeId}/risk-metrics — risk metrics read (P0 list, 2026-08-03).
 * Contract assumption is loose (response merely contains a data key); tighten it after capturing
 * the real structure on the first intranet run (env-checklist).
 */
export function getRiskMetrics(cfg, tradeId, user) {
  const { res, tags } = client.get(cfg, SVC, `/api/v1/trades/${encodeURIComponent(tradeId)}/risk-metrics`, {
    name: 'GET /api/v1/trades/{tradeId}/risk-metrics', module: MOD, user,
  });
  return classifyRead(res, tags, (body) =>
    body && body.data !== undefined
      ? null
      : `response missing data — keys=${Object.keys(body || {}).slice(0, 8).join(',')}`
  );
}
