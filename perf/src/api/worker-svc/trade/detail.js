import * as client from '../../../lib/http.js';
import { classifyRead } from '../../../lib/errors.js';

const SVC = 'worker-svc';
const MOD = 'trade';

/*
 * GET /api/v1/trades/{id} — the id goes into the URL path; the name tag is normalized with a
 * curly-brace placeholder (dynamic ids in tags would blow up Prometheus cardinality — README discipline).
 * Contract assumptions (calibrate on the first intranet run, env-checklist): the response contains
 * data.trade and echoes the id back unchanged.
 */
export function getTrade(cfg, id, user) {
  const { res, tags } = client.get(cfg, SVC, `/api/v1/trades/${encodeURIComponent(id)}`, {
    name: 'GET /api/v1/trades/{id}', module: MOD, user,
  });
  return classifyRead(res, tags, (body) => {
    const t = body && body.data && body.data.trade;
    if (!t) return `response missing data.trade — keys=${Object.keys(body || {}).slice(0, 8).join(',')}`;
    // What comes back must be the trade that was requested — a mismatched id is a server or script defect, not a performance problem
    return String(t.id) === String(id) ? null : `returned trade.id='${t.id}' ≠ requested '${id}'`;
  });
}
