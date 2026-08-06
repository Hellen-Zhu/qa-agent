/*
 * E2E journey · trade lifecycle: create (maker) → approve (checker) → update (maker) → approve (checker).
 * Measures the WHOLE business transaction, not individual requests:
 *   perf_journey_duration — wall time of the full chain (only recorded on fully successful journeys,
 *                           mirroring the success-only caliber of perf_success_duration);
 *   perf_journey_success  — journey-level success rate (all four steps OK).
 * Per-step response times come free via the per-API name tags (both approves share one endpoint name).
 * No journey-level SLA threshold yet — journey targets await the SLA calibration session; per-API SLAs
 * still apply on every step (apiSla-exempt profiles exempt them as usual).
 *
 * Self-sufficient by design: the only write path that needs NO consumable pool — create produces the
 * LIVE trade that update amends, and both TaskIds are harvested from the response msg. It does burn
 * BOTH identity pools' rate-limit budget (maker: create+update, checker: 2× approve per journey).
 *
 * Pacing: steps run back-to-back with no think time (server-capacity caliber, not user-experience
 * simulation). One iteration ≈ 4 chained requests — with arrival-rate profiles pick a rate ≈ 1/4 of
 * a single-API round and mind preAllocatedVUs; closed-model profiles (smoke/ladder) need no change.
 */
import exec from 'k6/execution';
import { Trend, Rate } from 'k6/metrics';
import { cfg, loadData, buildOptionsMulti } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickAt } from '../lib/data.js';
import { pickCase } from '../api/worker-svc/trade/create-data.js';
import { createTrade } from '../api/worker-svc/trade/create.js';
import { updateTrade } from '../api/worker-svc/trade/update.js';
import { approveTask } from '../api/worker-svc/checker-flow/tasks.js';
import { createTradePreflight } from '../setup/create-trade-preflight.js';
import { ERR } from '../lib/errors.js';

const UPDATE_DATA = loadData('worker-svc/trade/update-payload');
const UPDATE_CASES = UPDATE_DATA.cases.map((c, n) => Object.assign({ __row: n + 1 }, c));

const journeyDuration = new Trend('perf_journey_duration', true);
const journeySuccess = new Rate('perf_journey_success');

export const options = buildOptionsMulti([
  ['worker-svc/trade', 'create'],
  ['worker-svc/checker-flow', 'approve'],
  ['worker-svc/trade', 'update'],
]);

export function setup() {
  return createTradePreflight();
}

let warnedNoTaskId = false;

export default function () {
  const i = exec.scenario.iterationInTest;
  const maker = pickUser(cfg, 'maker', __VU);
  const checker = pickUser(cfg, 'checker', __VU);
  const t0 = Date.now();

  const created = createTrade(cfg, pickCase(i), maker, 'main');
  if (created.errClass !== ERR.OK) return journeySuccess.add(false);
  if (!created.taskId) {
    // Business-successful create without a msg TaskId = contract drift, not load — surface once
    if (!warnedNoTaskId) {
      console.warn('journey: create succeeded but no TaskId in msg — journeys dropped (check the msg format)');
      warnedNoTaskId = true;
    }
    return journeySuccess.add(false);
  }

  if (approveTask(cfg, created.taskId, checker, 'main').errClass !== ERR.OK) return journeySuccess.add(false);

  const updated = updateTrade(cfg, created.tradeId, pickAt(UPDATE_CASES, i), maker, 'main');
  if (updated.errClass !== ERR.OK || !updated.taskId) return journeySuccess.add(false);

  if (approveTask(cfg, updated.taskId, checker, 'main').errClass !== ERR.OK) return journeySuccess.add(false);

  journeySuccess.add(true);
  journeyDuration.add(Date.now() - t0);
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
