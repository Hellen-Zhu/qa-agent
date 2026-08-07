import exec from 'k6/execution';
import { cfg, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickTradeId, tradeIdsPreflight } from '../pools/worker-svc/trade/ids-data.js';
import { getRiskMetrics } from '../api/worker-svc/trade/risk-metrics.js';

// P0 · worker-svc/trade · read path (risk metrics)

export const options = buildOptions('worker-svc/trade', 'riskMetrics');

export function setup() {
  tradeIdsPreflight();
}

export default function () {
  const i = exec.scenario.iterationInTest;
  getRiskMetrics(cfg, pickTradeId(i), pickUser(cfg, 'maker', __VU));
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
