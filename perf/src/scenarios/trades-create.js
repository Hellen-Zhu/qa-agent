import { parseEnvConfig } from '../lib/config.js';
import { buildProfile } from '../profiles/index.js';
import { buildThresholds } from '../lib/sla.js';
import { pickUser } from '../lib/users.js';
import { buildTradePart, datFileFor } from '../payloads/factory.js';
import { createTrade } from '../api/trade-svc/trades.js';
import { summarize, toMarkers } from '../lib/report.js';

export const meta = { tags: ['P0', 'trade-svc', 'write'] };

const ENV = __ENV.ENV || 'local';
const PRODUCT = __ENV.PRODUCT || 'TRF';
const RUN_ID = __ENV.TESTID || 'local-run';
const cfg = parseEnvConfig(open(`../../config/environments/${ENV}.json`));
const SLA = JSON.parse(open('../../config/slas/trade-svc/trades.json'));
const CPS = JSON.parse(open('../../data/params/counterparties.json'));
const DAT_NAME = datFileFor(PRODUCT);
const DAT_BIN = open(`../../data/datfiles/${DAT_NAME}`, 'b');

export const options = {
  scenarios: { main: buildProfile(__ENV.PROFILE || 'smoke', __ENV) },
  thresholds: buildThresholds(SLA.create),
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)'],
};

export default function () {
  const user = pickUser(cfg, 'maker', __VU);
  const trade = buildTradePart(CPS, __VU, __ITER, RUN_ID);
  createTrade(cfg, trade, DAT_BIN, DAT_NAME, user);
}

export function handleSummary(data) {
  return { stdout: toMarkers(summarize(data, RUN_ID)) };
}
