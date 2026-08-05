import exec from 'k6/execution';
import { cfg, loadData, buildOptions, plannedIterations } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickAt } from '../lib/data.js';
import { loadPool, consumablePreflight, takeUnique } from '../api/worker-svc/trade/consumable-ids.js';
import { updateTrade } from '../api/worker-svc/trade/update.js';

// P0 · worker-svc/trade · write path (high-frequency amend — consumes one LIVE id per request)

const DATA = loadData('worker-svc/trade/update-payload');
const CASES = DATA.cases.map((c, n) => Object.assign({ __row: n + 1 }, c));
const POOL = loadPool('update-ids');

export const options = buildOptions('worker-svc/trade', 'update');
// Captured at init: k6 replaces the exported options binding with its consolidated version
// after init, so reading options.scenarios inside setup() is not safe
const PLANNED = plannedIterations(options);

export function setup() {
  consumablePreflight(POOL, PLANNED, 'update-ids');
}

let warnedExhausted = false;

export default function () {
  const i = exec.scenario.iterationInTest;
  const id = takeUnique(POOL);
  if (id === null) {
    // Skip, never recycle — a second update on the same id measures the state machine, not the system
    if (!warnedExhausted) {
      console.warn('update-ids pool exhausted — remaining iterations are skipped (re-seed a bigger pool)');
      warnedExhausted = true;
    }
    return;
  }
  updateTrade(cfg, id, pickAt(CASES, i), pickUser(cfg, 'maker', __VU), 'main');
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
