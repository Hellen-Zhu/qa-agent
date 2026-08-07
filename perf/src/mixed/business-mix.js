/*
 * Business-volume mixed workload — THE outward-facing scenario per the agreed methodology:
 * realistic API ratios anchored to business volumes, scaled by MULTIPLIER (1x/2x/10x...) to
 * find how much business volume the system can bear.
 *
 * FLOWS is the accounting table, not an execution plan: each row = one business action's 1x
 * rate (flows/second at production projection — REPLACE WITH VOLUMETRICS when they land) plus
 * the endpoint calls one such action induces (multiplicities counted from real DevTools
 * captures). expandFlows() multiplies the table into per-endpoint rates; endpoints run as
 * INDEPENDENT unordered open-model streams — no sequencing, no data hand-off (order is
 * deliberately out of scope; only ratios matter).
 *
 * The profile's rate / stage targets are MULTIPLIERS of the 1x table:
 *   ./run.sh business-mix dev mix RATE=1     -> 1x business volume
 *   ./run.sh business-mix dev mix RATE=10    -> 10x
 *   ./run.sh business-mix dev mix-ladder     -> stepped multiplier ladder (stage targets = x)
 *   ./run.sh business-mix dev smoke          -> one call per endpoint (link check)
 * Capacity readout: the knee multiplier × the 1x table = "the system bears Nx of projected
 * business volume" — the deliverable in business language.
 *
 * Data supply (all unordered): query <- filter params, detail <- reusable trade-ids pool,
 * create <- case rows, update/approve <- consumable pools (each owned by exactly one scenario,
 * exactly-once cursor holds; demand = that endpoint's expanded rate x duration x 1.2,
 * preflight-enforced). booking's auxiliary calls (refdata / dat-to-json / calculate-risk) are
 * NOT in the table yet — add their multiplicities when those contracts are captured.
 */
import exec from 'k6/execution';
import { cfg, loadData, buildOptionsMulti, plannedIterations } from '../lib/bootstrap.js';
import { expandFlows } from '../lib/mix.js';
import { pickUser } from '../lib/users.js';
import { pickAt } from '../lib/data.js';
import { pickCase } from '../pools/worker-svc/trade/create-data.js';
import { pickTradeId, tradeIdsPreflight } from '../pools/worker-svc/trade/ids-data.js';
import { loadPool, consumablePreflight, takeUnique } from '../pools/worker-svc/trade/consumable-ids.js';
import { createTradePreflight } from '../pools/worker-svc/trade/create-trade-preflight.js';
import { createTrade } from '../api/worker-svc/trade/create.js';
import { queryTrades } from '../api/worker-svc/trade/query.js';
import { getTrade } from '../api/worker-svc/trade/detail.js';
import { updateTrade } from '../api/worker-svc/trade/update.js';
import { approveTask } from '../api/worker-svc/checker-flow/tasks.js';

// 1x anchor table — PLACEHOLDER rates (flows/second) pending the production traffic profile.
// calls = endpoint invocations induced by ONE such business action (from DevTools counts).
const FLOWS = {
  booking: { rate: 0.03, calls: { create: 1 } }, // aux calls (refdata/datToJson/risk-calc) TBC
  amend: { rate: 0.08, calls: { query: 1, detail: 2, update: 1 } },
  checker: { rate: 0.08, calls: { query: 1, detail: 2, approve: 1 } },
  browse: { rate: 0.5, calls: { query: 1 } }, // standalone reads: list refresh / polling
};

const EXECS = { query: 'hitQuery', detail: 'hitDetail', create: 'hitCreate', update: 'hitUpdate', approve: 'hitApprove' };

const QUERY_DATA = loadData('worker-svc/trade/trades-query');
const UPDATE_DATA = loadData('worker-svc/trade/update-payload');
const UPDATE_CASES = UPDATE_DATA.cases.map((c, n) => Object.assign({ __row: n + 1 }, c));
const UPDATE_POOL = loadPool('update-ids');
const APPROVE_POOL = loadPool('approve-tasks');

const base = buildOptionsMulti(
  [
    ['worker-svc/trade', 'query'],
    ['worker-svc/trade', 'detail'],
    ['worker-svc/trade', 'create'],
    ['worker-svc/trade', 'update'],
    ['worker-svc/checker-flow', 'approve'],
  ],
  { perf_trades_rows: ['avg>0'] },
);

base.scenarios = expandFlows(base.scenarios.main, FLOWS, EXECS);
export const options = base;

// Captured at init: k6 replaces the exported options binding with its consolidated version
// after init, so reading options.scenarios inside setup() is not safe
const PLANNED_UPDATE = plannedIterations({ scenarios: { main: base.scenarios.update } });
const PLANNED_APPROVE = plannedIterations({ scenarios: { main: base.scenarios.approve } });

export function setup() {
  const seeded = createTradePreflight();
  tradeIdsPreflight();
  consumablePreflight(UPDATE_POOL, PLANNED_UPDATE, 'update-ids');
  consumablePreflight(APPROVE_POOL, PLANNED_APPROVE, 'approve-tasks');
  return seeded;
}

export function hitQuery() {
  queryTrades(cfg, pickAt(QUERY_DATA.filters, exec.scenario.iterationInTest), pickUser(cfg, 'maker', __VU));
}

export function hitDetail() {
  getTrade(cfg, pickTradeId(exec.scenario.iterationInTest), pickUser(cfg, 'maker', __VU));
}

export function hitCreate() {
  createTrade(cfg, pickCase(exec.scenario.iterationInTest), pickUser(cfg, 'maker', __VU), 'main');
}

let warnedUpdateExhausted = false;

export function hitUpdate() {
  const i = exec.scenario.iterationInTest;
  const id = takeUnique(UPDATE_POOL);
  if (id === null) {
    // Skip, never recycle — a second update on the same id measures the state machine, not the system
    if (!warnedUpdateExhausted) {
      console.warn('update-ids pool exhausted — remaining update calls are skipped (re-seed a bigger pool)');
      warnedUpdateExhausted = true;
    }
    return;
  }
  updateTrade(cfg, id, pickAt(UPDATE_CASES, i), pickUser(cfg, 'maker', __VU), 'main');
}

let warnedApproveExhausted = false;

export function hitApprove() {
  const taskId = takeUnique(APPROVE_POOL);
  if (taskId === null) {
    // Skip, never recycle — re-approving a consumed task is an http-400 state conflict, not load
    if (!warnedApproveExhausted) {
      console.warn('approve-tasks pool exhausted — remaining approve calls are skipped (re-seed a bigger pool)');
      warnedApproveExhausted = true;
    }
    return;
  }
  approveTask(cfg, taskId, pickUser(cfg, 'checker', __VU), 'main');
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
