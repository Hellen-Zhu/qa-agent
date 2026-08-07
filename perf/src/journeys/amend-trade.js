/*
 * Journey · maker amend flow (single-actor flow, MAY carry load per the taxonomy):
 *   1. GET /api/v1/trades          — the maker's working list
 *   2. GET /api/v1/trades/{id}     — open the trade to amend (the pooled LIVE id — amending an
 *                                    arbitrary trade from the list would violate the PERF-
 *                                    portfolio red line; the browse click is simulated on the
 *                                    trade we are entitled to touch)
 *   3. POST /api/v1/trades/{id}/update — submit the amendment (consumes one LIVE id; the trade
 *                                        transitions back to PENDING APPROVAL)
 *   4. GET /api/v1/trades/{id}     — refresh after submitting, the way the UI re-reads
 *
 * Step order is an initial draft mirroring the checker workflow — calibrate against the real
 * screen's request sequence (DevTools) when convenient. All four contracts are known today
 * (query/update calibrated, detail shape-assumed), so this flow ships without new captures.
 * Every step runs under the MAKER identity: one journey costs 4 requests of maker rate-limit
 * budget and consumes one update-ids pool entry (re-seed between rounds).
 */
import exec from 'k6/execution';
import { journeyDuration, journeySuccess } from '../lib/journey-metrics.js';
import { cfg, loadData, buildOptionsMulti, plannedIterations } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickAt } from '../lib/data.js';
import { queryTrades } from '../api/worker-svc/trade/query.js';
import { getTrade } from '../api/worker-svc/trade/detail.js';
import { updateTrade } from '../api/worker-svc/trade/update.js';
import { loadPool, consumablePreflight, takeUnique } from '../pools/worker-svc/trade/consumable-ids.js';
import { ERR } from '../lib/errors.js';

const QUERY_DATA = loadData('worker-svc/trade/trades-query');
const UPDATE_DATA = loadData('worker-svc/trade/update-payload');
const UPDATE_CASES = UPDATE_DATA.cases.map((c, n) => Object.assign({ __row: n + 1 }, c));
const POOL = loadPool('update-ids');

export const options = buildOptionsMulti(
  [
    ['worker-svc/trade', 'query'],
    ['worker-svc/trade', 'detail'],
    ['worker-svc/trade', 'update'],
  ],
  // Same empty-DB guard as trades-query: an empty list means the screen this flow simulates
  // could not exist
  { perf_trades_rows: ['avg>0'] },
);
// Captured at init: k6 replaces the exported options binding with its consolidated version
// after init, so reading options.scenarios inside setup() is not safe
const PLANNED = plannedIterations(options);

export function setup() {
  consumablePreflight(POOL, PLANNED, 'update-ids');
}

let warnedExhausted = false;

/** Flow body, importable by the flow-level mix (journey-mix) — cursor and pickAt index use the
 *  CALLING scenario's iterationInTest; update-ids must be consumed by exactly one scenario per run. */
export function amendTradeFlow() {
  const i = exec.scenario.iterationInTest;
  const maker = pickUser(cfg, 'maker', __VU);

  const tradeId = takeUnique(POOL);
  if (tradeId === null) {
    // Skip, never recycle — a second update on the same id measures the state machine, not the system
    if (!warnedExhausted) {
      console.warn('update-ids pool exhausted — remaining amend journeys are skipped (re-seed a bigger pool)');
      warnedExhausted = true;
    }
    return;
  }

  const t0 = Date.now();

  if (queryTrades(cfg, pickAt(QUERY_DATA.filters, i), maker).errClass !== ERR.OK) return journeySuccess.add(false);
  if (getTrade(cfg, tradeId, maker).errClass !== ERR.OK) return journeySuccess.add(false);
  if (updateTrade(cfg, tradeId, pickAt(UPDATE_CASES, i), maker, 'main').errClass !== ERR.OK) return journeySuccess.add(false);
  if (getTrade(cfg, tradeId, maker).errClass !== ERR.OK) return journeySuccess.add(false);

  journeySuccess.add(true);
  journeyDuration.add(Date.now() - t0);
}

export default function () {
  amendTradeFlow();
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
