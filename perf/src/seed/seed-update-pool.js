/*
 * Seed producer for the trades-update measurement pool: the full dual-identity pipeline —
 * create (maker) → approve by the msg TaskId (checker) → the now-LIVE tradeId is the harvest.
 * run.sh extracts the SEEDID lines from k6.log into seed-pool.json; activate with:
 *   cp <run dir>/seed-pool.json data/worker-svc/trade/update-ids.json
 *
 * Run with the seed profile:  ./run.sh seed-update-pool <env> seed ITERATIONS=<pool size x 1.3>
 * All requests carry runPhase=seed so seed traffic can be sliced out of any metric view.
 * Note both identity pools are on the clock here: create burns maker rate-limit budget,
 * approve burns checker budget (checker pool sizing: see env-checklist).
 */
import exec from 'k6/execution';
import { cfg, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickCase } from '../api/worker-svc/trade/create-data.js';
import { createTrade } from '../api/worker-svc/trade/create.js';
import { approveTask } from '../api/worker-svc/checker-flow/tasks.js';
import { createTradePreflight } from '../setup/create-trade-preflight.js';
import { ERR } from '../lib/errors.js';

export const options = buildOptions('worker-svc/trade', 'create');

export function setup() {
  return createTradePreflight();
}

export default function () {
  const i = exec.scenario.iterationInTest;
  const maker = pickUser(cfg, 'maker', __VU);
  const checker = pickUser(cfg, 'checker', __VU);

  const created = createTrade(cfg, pickCase(i), maker, 'seed');
  if (created.errClass !== ERR.OK) return;
  if (!created.taskId) {
    console.warn(`seed: created ${created.tradeId || '(no id)'} but no TaskId in msg — dropped (check the msg format)`);
    return;
  }

  const approved = approveTask(cfg, created.taskId, checker, 'seed');
  if (approved.errClass === ERR.OK) {
    console.log(`SEEDID ${created.tradeId}`);
  }
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
