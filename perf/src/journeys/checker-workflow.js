/*
 * Journey · checker workflow (single-actor flow, MAY carry load per the taxonomy):
 *   1. GET /api/v1/trades          — the checker's working list
 *   2. GET /api/v1/trades/{id}     — browse: open a trade from the list (id picked from the rows)
 *   3. POST .../tasks/{taskId}/approve — consume one pending task from the pool
 *   4. GET /api/v1/trades/{id}     — verify: re-read the JUST-approved trade (id echoed by approve)
 *
 * Unlike the cross-role E2E chain, this is ONE actor's real operational flow — production
 * concurrency IS N checkers running it, so it is a legitimate load unit. Data notes: the browse
 * id comes from the query response (self-consistent, read-only); the verify id comes from the
 * approve echo, making step 4 a read-after-write on hot data — exactly what the checker UI does
 * on refresh. One pending taskId is consumed per iteration (approve-tasks pool, re-seed between
 * rounds); every step runs under the CHECKER identity (checkers can view, not book), so one
 * journey costs 4 requests of checker rate-limit budget.
 */
import exec from 'k6/execution';
import { Trend, Rate } from 'k6/metrics';
import { cfg, loadData, buildOptionsMulti, plannedIterations } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickAt } from '../lib/data.js';
import { queryTrades } from '../api/worker-svc/trade/query.js';
import { getTrade } from '../api/worker-svc/trade/detail.js';
import { approveTask } from '../api/worker-svc/checker-flow/tasks.js';
import { loadPool, consumablePreflight, takeUnique } from '../api/worker-svc/trade/consumable-ids.js';
import { ERR } from '../lib/errors.js';

const QUERY_DATA = loadData('worker-svc/trade/trades-query');
const POOL = loadPool('approve-tasks');

const journeyDuration = new Trend('perf_journey_duration', true);
const journeySuccess = new Rate('perf_journey_success');

export const options = buildOptionsMulti(
  [
    ['worker-svc/trade', 'query'],
    ['worker-svc/trade', 'detail'],
    ['worker-svc/checker-flow', 'approve'],
  ],
  // Same empty-DB guard as trades-query: the browse step needs rows to pick from
  { perf_trades_rows: ['avg>0'] },
);
// Captured at init: k6 replaces the exported options binding with its consolidated version
// after init, so reading options.scenarios inside setup() is not safe
const PLANNED = plannedIterations(options);

export function setup() {
  consumablePreflight(POOL, PLANNED, 'approve-tasks');
}

let warnedExhausted = false;
let warnedNoRows = false;

export default function () {
  const i = exec.scenario.iterationInTest;
  const checker = pickUser(cfg, 'checker', __VU);

  const taskId = takeUnique(POOL);
  if (taskId === null) {
    // Skip, never recycle — re-approving a consumed task is an http-400 state conflict, not load
    if (!warnedExhausted) {
      console.warn('approve-tasks pool exhausted — remaining journeys are skipped (re-seed a bigger pool)');
      warnedExhausted = true;
    }
    return;
  }

  const t0 = Date.now();

  const q = queryTrades(cfg, pickAt(QUERY_DATA.filters, i), checker);
  if (q.errClass !== ERR.OK) return journeySuccess.add(false);
  const rows = q.body.data.data;
  const browseId = rows.length > 0 && rows[i % rows.length].trade && rows[i % rows.length].trade.id;
  if (!browseId) {
    // Empty list (or unexpected row shape) leaves the checker nothing to open — env/data issue, not load
    if (!warnedNoRows) {
      console.warn('checker-workflow: query returned no usable rows — journeys dropped (check standing data / filters)');
      warnedNoRows = true;
    }
    return journeySuccess.add(false);
  }

  if (getTrade(cfg, browseId, checker).errClass !== ERR.OK) return journeySuccess.add(false);

  const approved = approveTask(cfg, taskId, checker, 'main');
  if (approved.errClass !== ERR.OK) return journeySuccess.add(false);

  // Approve echoes the tradeId (calibrated 2026-08-05) — re-read the trade the way the UI refreshes it
  if (getTrade(cfg, approved.body.data.id, checker).errClass !== ERR.OK) return journeySuccess.add(false);

  journeySuccess.add(true);
  journeyDuration.add(Date.now() - t0);
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
