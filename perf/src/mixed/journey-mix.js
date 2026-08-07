/*
 * Flow-level mixed workload — the terminal mix shape: units are BUSINESS FLOWS, not naked APIs.
 *   query-flow   — independent read stream (standing one-call flow: list polling / refreshes,
 *                  traffic that belongs to no journey in production either)
 *   amend-flow   — maker amend journey  (query → detail → update → detail), 4 requests/flow
 *   checker-flow — checker workflow journey (query → detail → approve → detail), 4 requests/flow
 *
 * The profile supplies ONE total flow rate (mix/mix-ref; RATE= overrides the total; smoke =
 * one flow of each kind) and lib/mix.js splits it by the FLOWS ratio table — PLACEHOLDERS
 * pending the production traffic profile; once volumetrics land the business numbers
 * (trades amended / approvals per hour) drop straight into these rows, no unit conversion.
 * checker ≈ amend is structural: every amendment spawns exactly one checker task.
 *
 * Budgeting differs from the API-level trade-mix in two ways:
 *   1. HTTP RPS ≈ (amend + checker rates) × 4 + query rate — a journey is 4 chained requests,
 *      so identity/rate-limit budgets must be computed on requests, not flows;
 *   2. pool demand per flow-scenario = its flow rate × duration × 1.2 (one pooled id per flow):
 *      amend consumes update-ids, checker consumes approve-tasks — each pool owned by exactly
 *      one scenario, so the exactly-once cursor guarantee holds; both pools dirty after a round.
 */
import exec from 'k6/execution';
import { cfg, loadData, buildOptionsMulti, plannedIterations } from '../lib/bootstrap.js';
import { splitByRatio } from '../lib/mix.js';
import { pickUser } from '../lib/users.js';
import { pickAt } from '../lib/data.js';
import { queryTrades } from '../api/worker-svc/trade/query.js';
import { amendTradeFlow } from '../journeys/amend-trade.js';
import { checkerWorkflowFlow } from '../journeys/checker-workflow.js';
import { loadPool, consumablePreflight } from '../api/worker-svc/trade/consumable-ids.js';

// PLACEHOLDER ratios (must sum to 1) — replace with the production traffic profile when it lands
const FLOWS = { query: 0.6, amend: 0.2, checker: 0.2 };

const QUERY_DATA = loadData('worker-svc/trade/trades-query');
// Same SharedArray instances as the journey modules (loadPool keys by name) — loaded here for preflight
const UPDATE_POOL = loadPool('update-ids');
const APPROVE_POOL = loadPool('approve-tasks');

const base = buildOptionsMulti(
  [
    ['worker-svc/trade', 'query'],
    ['worker-svc/trade', 'detail'],
    ['worker-svc/trade', 'update'],
    ['worker-svc/checker-flow', 'approve'],
  ],
  { perf_trades_rows: ['avg>0'] },
);

base.scenarios = splitByRatio(base.scenarios.main, [
  { name: 'query-flow', exec: 'queryFlow', ratio: FLOWS.query },
  { name: 'amend-flow', exec: 'amendFlow', ratio: FLOWS.amend },
  { name: 'checker-flow', exec: 'checkerFlow', ratio: FLOWS.checker },
]);
export const options = base;

// Captured at init: k6 replaces the exported options binding with its consolidated version
// after init, so reading options.scenarios inside setup() is not safe
const PLANNED_AMEND = plannedIterations({ scenarios: { main: base.scenarios['amend-flow'] } });
const PLANNED_CHECKER = plannedIterations({ scenarios: { main: base.scenarios['checker-flow'] } });

export function setup() {
  consumablePreflight(UPDATE_POOL, PLANNED_AMEND, 'update-ids');
  consumablePreflight(APPROVE_POOL, PLANNED_CHECKER, 'approve-tasks');
}

export function queryFlow() {
  queryTrades(cfg, pickAt(QUERY_DATA.filters, exec.scenario.iterationInTest), pickUser(cfg, 'maker', __VU));
}

export function amendFlow() {
  amendTradeFlow();
}

export function checkerFlow() {
  checkerWorkflowFlow();
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
