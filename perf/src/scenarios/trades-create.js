import exec from 'k6/execution';
import { cfg, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickCase } from '../api/trade-svc/trades-data.js';
import { createTrade } from '../api/trade-svc/trades.js';
import { createTradePreflight } from '../setup/create-trade-preflight.js';

// P0 · trade-svc · 写路径

export const options = buildOptions('trade-svc/trades', 'create');

export function setup() {
  return createTradePreflight();
}

export default function () {
  const i = exec.scenario.iterationInTest;
  const user = pickUser(cfg, 'maker', __VU);
  createTrade(cfg, pickCase(i), user, 'main');
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
