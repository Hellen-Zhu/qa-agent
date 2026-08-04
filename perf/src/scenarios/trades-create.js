import exec from 'k6/execution';
import { cfg, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickCase } from '../api/worker-svc/trade/create-data.js';
import { createTrade } from '../api/worker-svc/trade/create.js';
import { createTradePreflight } from '../setup/create-trade-preflight.js';

// P0 · worker-svc/trade · write path

export const options = buildOptions('worker-svc/trade', 'create');

export function setup() {
  return createTradePreflight();
}

export default function () {
  const i = exec.scenario.iterationInTest;
  const user = pickUser(cfg, 'maker', __VU);
  createTrade(cfg, pickCase(i), user, 'main');
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
