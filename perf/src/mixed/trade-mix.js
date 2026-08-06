/*
 * Mixed-API workload: the four P0 flows injected CONCURRENTLY as independent k6 scenarios —
 * no inter-step dependency (that's the journey's job, src/journeys/). This measures capacity
 * under cross-endpoint resource contention (shared DB pools / CPU / locks), which single-API
 * rounds cannot see. Verdict caliber is unchanged: per-API SLA thresholds are name-tagged, so
 * each endpoint is judged under mixed load against its own SLA.
 *
 * The profile supplies ONE total volume — an arrival rate (mix.json for probing, mix-ref.json
 * for the fixed-rate baseline reference; RATE= overrides the total) or an iterations count
 * (smoke: one request per flow) — and this file splits it by the ratio table below. MIX ratios are PLACEHOLDERS pending the
 * production traffic profile (test-plan gap #1) — once volumetrics land, approve should track
 * create+update (every write spawns exactly one checker task).
 *
 * Cursor correctness: exec.scenario.iterationInTest counts PER SCENARIO (verified against
 * k6 v2.1.0, two-scenario experiment 2026-08-06), so each consumable pool keeps its
 * exactly-once guarantee as long as it is consumed by exactly ONE scenario — update-mix owns
 * update-ids, approve-mix owns approve-tasks. Pool demand per round = ratio × total rate ×
 * duration × 1.2; a mixed round dirties BOTH pools (re-seed before rerun).
 */
import exec from 'k6/execution';
import { cfg, loadData, buildOptionsMulti, plannedIterations } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickAt } from '../lib/data.js';
import { pickCase } from '../api/worker-svc/trade/create-data.js';
import { createTrade } from '../api/worker-svc/trade/create.js';
import { updateTrade } from '../api/worker-svc/trade/update.js';
import { approveTask } from '../api/worker-svc/checker-flow/tasks.js';
import { queryTrades } from '../api/worker-svc/trade/query.js';
import { loadPool, consumablePreflight, takeUnique } from '../api/worker-svc/trade/consumable-ids.js';
import { createTradePreflight } from '../setup/create-trade-preflight.js';

// PLACEHOLDER ratios (must sum to 1) — replace with the production traffic profile when it lands
const MIX = { query: 0.6, create: 0.1, update: 0.15, approve: 0.15 };

const QUERY_DATA = loadData('worker-svc/trade/trades-query');
const UPDATE_DATA = loadData('worker-svc/trade/update-payload');
const UPDATE_CASES = UPDATE_DATA.cases.map((c, n) => Object.assign({ __row: n + 1 }, c));
const UPDATE_POOL = loadPool('update-ids');
const APPROVE_POOL = loadPool('approve-tasks');

const base = buildOptionsMulti(
  [
    ['worker-svc/trade', 'query'],
    ['worker-svc/trade', 'create'],
    ['worker-svc/trade', 'update'],
    ['worker-svc/checker-flow', 'approve'],
  ],
  // Same empty-DB guard as the single-API query scenario
  { perf_trades_rows: ['avg>0'] },
);

const main = base.scenarios.main;
// Splittable profiles: a scalar rate (open model — mix.json / mix-ref.json) or a scalar
// iterations count (shared-iterations — smoke's one-request-per-flow link check). Closed
// vus-only executors (baseline/ladder) stay rejected: their iteration volume is unknowable
// up front, so the consumable-pool preflight cannot budget and the mix ratio would silently
// drift once a pool runs dry.
if (main.rate === undefined && main.iterations === undefined) {
  throw new Error(
    'trade-mix requires a profile with a scalar rate (mix/mix-ref) or iterations (smoke); ' +
    'closed vus-only profiles cannot preflight consumable pools'
  );
}

// Rounding may make the effective total drift a request or two from the profile rate — irrelevant
// at capacity caliber; the floor of 1 keeps every flow present even at tiny trial rates.
function slice(ratio, execName) {
  const s = Object.assign({}, main);
  if (main.rate !== undefined) {
    s.rate = Math.max(1, Math.round(main.rate * ratio));
  } else {
    s.iterations = Math.max(1, Math.round(main.iterations * ratio));
    if (s.vus !== undefined) s.vus = Math.max(1, Math.min(Math.round(main.vus * ratio), s.iterations));
  }
  if (s.preAllocatedVUs !== undefined) s.preAllocatedVUs = Math.max(2, Math.round(main.preAllocatedVUs * ratio));
  if (s.maxVUs !== undefined) s.maxVUs = Math.max(5, Math.round(main.maxVUs * ratio));
  s.exec = execName;
  return s;
}

base.scenarios = {
  'query-mix': slice(MIX.query, 'queryMix'),
  'create-mix': slice(MIX.create, 'createMix'),
  'update-mix': slice(MIX.update, 'updateMix'),
  'approve-mix': slice(MIX.approve, 'approveMix'),
};
export const options = base;

// Captured at init: k6 replaces the exported options binding with its consolidated version
// after init, so reading options.scenarios inside setup() is not safe
const PLANNED_UPDATE = plannedIterations({ scenarios: { main: base.scenarios['update-mix'] } });
const PLANNED_APPROVE = plannedIterations({ scenarios: { main: base.scenarios['approve-mix'] } });

export function setup() {
  const seeded = createTradePreflight();
  consumablePreflight(UPDATE_POOL, PLANNED_UPDATE, 'update-ids');
  consumablePreflight(APPROVE_POOL, PLANNED_APPROVE, 'approve-tasks');
  return seeded;
}

export function queryMix() {
  const i = exec.scenario.iterationInTest;
  queryTrades(cfg, pickAt(QUERY_DATA.filters, i), pickUser(cfg, 'maker', __VU));
}

export function createMix() {
  createTrade(cfg, pickCase(exec.scenario.iterationInTest), pickUser(cfg, 'maker', __VU), 'main');
}

let warnedUpdateExhausted = false;

export function updateMix() {
  const i = exec.scenario.iterationInTest;
  const id = takeUnique(UPDATE_POOL);
  if (id === null) {
    // Skip, never recycle — a second update on the same id measures the state machine, not the system
    if (!warnedUpdateExhausted) {
      console.warn('update-ids pool exhausted — remaining update-mix iterations are skipped (re-seed a bigger pool)');
      warnedUpdateExhausted = true;
    }
    return;
  }
  updateTrade(cfg, id, pickAt(UPDATE_CASES, i), pickUser(cfg, 'maker', __VU), 'main');
}

let warnedApproveExhausted = false;

export function approveMix() {
  const taskId = takeUnique(APPROVE_POOL);
  if (taskId === null) {
    // Skip, never recycle — re-approving a consumed task is an http-400 state conflict, not load
    if (!warnedApproveExhausted) {
      console.warn('approve-tasks pool exhausted — remaining approve-mix iterations are skipped (re-seed a bigger pool)');
      warnedApproveExhausted = true;
    }
    return;
  }
  approveTask(cfg, taskId, pickUser(cfg, 'checker', __VU), 'main');
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
