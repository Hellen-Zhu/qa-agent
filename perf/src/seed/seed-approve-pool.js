/*
 * Seed producer for the checker-approve measurement pool: create only, DON'T approve —
 * every successful create leaves one pending checker task, and its CHK taskId (parsed from
 * the response msg) is the harvest. run.sh extracts the SEEDID lines from k6.log into
 * seed-pool.json; activate with:  cp <run dir>/seed-pool.json data/worker-svc/trade/approve-tasks.json
 *
 * Run with the seed profile:  ./run.sh seed-approve-pool <env> seed ITERATIONS=<pool size x 1.3>
 * All requests carry runPhase=seed so seed traffic can be sliced out of any metric view.
 */
import exec from 'k6/execution';
import { cfg, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickCase } from '../api/worker-svc/trade/create-data.js';
import { createTrade } from '../api/worker-svc/trade/create.js';
import { createTradePreflight } from '../setup/create-trade-preflight.js';
import { ERR } from '../lib/errors.js';

export const options = buildOptions('worker-svc/trade', 'create');

export function setup() {
  return createTradePreflight();
}

export default function () {
  const i = exec.scenario.iterationInTest;
  const maker = pickUser(cfg, 'maker', __VU);
  const out = createTrade(cfg, pickCase(i), maker, 'seed');
  if (out.errClass !== ERR.OK) return;
  if (out.taskId) {
    console.log(`SEEDID ${out.taskId}`);
  } else {
    // Business success but msg carried no parsable TaskId — contract drift; row dropped
    console.warn(`seed: created ${out.tradeId || '(no id)'} but no TaskId in msg — dropped (check the msg format)`);
  }
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
