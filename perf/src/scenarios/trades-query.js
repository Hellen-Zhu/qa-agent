import { parseEnvConfig } from '../lib/config.js';
import { buildProfile } from '../profiles/index.js';
import { buildThresholds } from '../lib/sla.js';
import { pickUser } from '../lib/users.js';
import { pick } from '../lib/data.js';
import { queryTrades } from '../api/trade-svc/trades.js';
import { summarize, toMarkers } from '../lib/report.js';

export const meta = { tags: ['P0', 'trade-svc', 'read'] };

const ENV = __ENV.ENV || 'local';
const cfg = parseEnvConfig(open(`../../config/environments/${ENV}.json`));
const SLA = JSON.parse(open('../../config/slas/trade-svc/trades.json'));
const FILTERS = JSON.parse(open('../../data/params/query-filters.json'));

export const options = {
  scenarios: { main: buildProfile(__ENV.PROFILE || 'smoke', __ENV) },
  thresholds: buildThresholds(SLA.query),
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)'],
};

export default function () {
  const user = pickUser(cfg, 'maker', __VU);
  const filter = pick(FILTERS, __VU, __ITER);
  queryTrades(cfg, filter, user);
}

export function handleSummary(data) {
  return { stdout: toMarkers(summarize(data, __ENV.TESTID || 'local-run')) };
}
