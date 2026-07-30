/*
 * scenarios/p05-trades-list.js
 *
 * [Layer] Runnable plan -- thin shell, defines no requests itself
 * [What it tests] GET /trades -- the highest-volume endpoint in the system (target of S-09 / S-10)
 * [How to run] ./run.sh p05-trades-list dev smoke
 *          ./run.sh p05-trades-list dev arrival RATE=4        # steady state 4.13 TPS
 *          ./run.sh p05-trades-list dev arrival RATE=33       # design capacity
 *          ./run.sh p05-trades-list dev smoke BLOTTER_PAGE_SIZE=500
 *
 * ══ S-09 fan-out audit (quiet window, one tier at a time) ═════
 *   for n in 50 200 500; do
 *     ./run.sh p05-trades-list dev smoke BLOTTER_PAGE_SIZE=$n
 *   done
 *   Before/after each tier, take the delta of Prometheus's
 *   rpc_client_duration_milliseconds_count:
 *     delta constant        → fan-out is O(1), healthy
 *     delta ∝ row count     → N+1; at 33 TPS the list = 6,600 QPS of gRPC,
 *                             the primary bottleneck
 *
 * ══ S-10 data-volume scaling ══════════════════════════════════
 *   Fix pageSize=200 + arrival RATE, sweep data-volume tiers 1k/50k/250k
 *   (pending the data factory).
 *   SCALE-01: P95 at the 250k tier ≤ 3x the 1k tier; beyond 10x you can
 *   basically conclude a full table scan.
 * ═══════════════════════════════════════════════════════════════
 *
 * ── Two deliberate differences from p02 ──
 * 1. Does not import create-trade's data module -- a read endpoint needs no
 *    case pool or .dat files; importing it would load all .dat into memory
 *    at init (that module is eagerly loaded).
 * 2. The guard is this path's own setup/trades-list-preflight.js -- a read
 *    endpoint creates no trade; it verifies "rows are actually returned"
 *    and declares the data volume in the DB (entry criterion #3).
 */

import { cfg } from '../lib/config.js';
import { tradesList } from '../steps/workers/trade-management/trades-list.js';
import { tradesListPreflight } from '../setup/trades-list-preflight.js';
import { makeHandleSummary } from '../lib/summary.js';

const PLAN = 'p05-trades-list';

// ── Command-line dimensions (passed as bare KEY=value via run.sh) ──
function intEnv(key, fallback) {
  const v = __ENV[key];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  if (isNaN(n)) throw new Error(`-e ${key}=${v} is not an integer`);
  return n;
}

const PAGE_SIZE = intEnv('BLOTTER_PAGE_SIZE', 200); // A17; the sweep dimension for S-09/S-10
const PAGE = intEnv('BLOTTER_PAGE', 0);
const SEARCH = __ENV.TRADES_SEARCH || '';
const STATUS = __ENV.STATUS_FILTER || '';

export const options = {
  scenarios: {
    list: Object.assign({ exec: 'tradesListIteration' }, cfg.scenario),
  },

  thresholds: Object.assign(
    {
      oreo_err_script: ['count==0'],
    },
    cfg.thresholds
  ),

  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  discardResponseBodies: false, // body must be parsed to extract row counts
  tags: {
    plan: PLAN,
    env: cfg.envName,
    profile: cfg.profileName,
  },
};

// ── setUp: this path's own guard (thin shell composes only, logic lives in setup/) ──
export function setup() {
  // Use the same query parameters as the main loop -- otherwise preflight
  // validates a different query than the one about to be loaded
  return tradesListPreflight({ pageSize: PAGE_SIZE, page: PAGE, status: STATUS });
}

// ── Main loop: one iteration = one list query ────────────────
export function tradesListIteration() {
  tradesList({
    runPhase: 'main',
    pageSize: PAGE_SIZE,
    page: PAGE,
    search: SEARCH,
    status: STATUS,
  });
}

// ── Wrap-up ──────────────────────────────────────────────────
export const handleSummary = makeHandleSummary(() => ({
  plan: PLAN,
  env: cfg.envName,
  profile: cfg.profileName,
  target: `${cfg.workersUrl}/trades?size=${PAGE_SIZE}`,
}));
