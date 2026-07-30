/*
 * scenarios/s01-create-trade-e2e.js
 *
 * [Layer] Runnable plan -- thin shell: executor + thresholds + wrap-up; path logic lives in the journey
 * [What it tests] S-03: the full Create Trade frontend path (PERF-07 / PERF-11 / PERF-19)
 * [How to run] ./run.sh s01-create-trade-e2e dev smoke
 *          ./run.sh s01-create-trade-e2e dev smoke REFDATA_MODE=static
 *          ./run.sh s01-create-trade-e2e dev arrival RATE=1 DURATION=600s REFDATA_MODE=static
 *
 * ── Essential difference from p02 ──
 * p02 measures "how many creates per second the server handles"; this scenario
 * measures "what a real user's full action sequence looks like against the
 * system" -- including refdata lookups, risk preview, think time, and viewing
 * the details afterwards. **The two sets of numbers are not interchangeable**:
 * the E2E create P95 includes resource contention from the other requests on
 * the same path, which is exactly why it exists.
 *
 * ── REFDATA_MODE (default live) ──
 * The refdata service address in config/dev.json is still a localhost
 * placeholder (NFR pending confirmation #12).
 *   live    every iteration queries the dropdowns for real; if a query fails,
 *           the journey falls back to the embedded ownership fields and
 *           counts oreo_refdata_fallback -- and the threshold below
 *           (count==0) fails the run, because a "live" run that silently
 *           took the fallback never covered the refdata path it claims to.
 *   static  skips the dropdown queries entirely (known deviation, the report
 *           must flag it); the fallback counter never fires, so the
 *           threshold passes trivially.
 *
 * ── ⚠ Data side effects ──
 * Every iteration really creates a PENDING APPROVAL trade. Long runs must
 * always use the arrival-rate shape; constant-vus at full tilt is forbidden
 * (plan §6.3, gate 5).
 */

import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { j01CreateTrade } from '../journeys/j01-create-trade.js';
import { DAT_NAME_MODE } from '../steps/workers/trade-management/create-trade-data.js';
import { createTradePreflight } from '../setup/create-trade-preflight.js';
import { makeHandleSummary } from '../lib/summary.js';

const PLAN = 's01-create-trade-e2e';

const REFDATA_MODE = __ENV.REFDATA_MODE || 'live';
if (REFDATA_MODE !== 'live' && REFDATA_MODE !== 'static') {
  throw new Error(`REFDATA_MODE=${REFDATA_MODE} is invalid; only live | static accepted`);
}

export const options = {
  scenarios: {
    e2e: Object.assign({ exec: 'journeyIteration' }, cfg.scenario),
  },

  thresholds: Object.assign(
    {
      oreo_err_script: ['count==0'],

      // live mode must actually be live: any silent fallback to embedded
      // ownership fields means the refdata path was not covered -- the run
      // completes (a mid-soak refdata blip is itself an E2E finding, not a
      // reason to kill the run) but is marked failed as a deviation.
      // In static mode the counter never fires and this passes trivially.
      oreo_refdata_fallback: ['count==0'],

      // ── Sentinel thresholds for per-step timings ────────
      // 'max>=0' is always true; its only purpose is to make k6 emit
      // sub-metrics for these tag combinations, so the summary gets a
      // "per-step timings" section (k6 only emits sub-metrics for
      // combinations with a declared threshold).
      // summary.js filters them out of the threshold verdict list.
      'oreo_success_duration{name:workers_trademgmt_create}': ['max>=0'],
      'oreo_success_duration{name:workers_trademgmt_calcriskfornew}': ['max>=0'],
      'oreo_success_duration{name:workers_trademgmt_detail}': ['max>=0'],
      'oreo_success_duration{name:workers_trademgmt_riskmetrics}': ['max>=0'],
      'oreo_success_duration{name:refdata_portfolios_list}': ['max>=0'],
      'oreo_success_duration{name:refdata_counterparties_list}': ['max>=0'],
    },
    cfg.thresholds
  ),

  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  discardResponseBodies: false,
  tags: {
    plan: PLAN,
    env: cfg.envName,
    profile: cfg.profileName,
    refdataMode: REFDATA_MODE, // results must show whether this was a degraded run
    datNameMode: DAT_NAME_MODE, // likewise: unique = deviation run bypassing the server-side temp-file race
  },
};

// ── setUp: local data validation only (sends nothing) ────────
// Refdata reachability is no longer probed here -- the per-iteration
// fallback counter + the oreo_refdata_fallback threshold above own that,
// for the whole run instead of one instant before it.
export function setup() {
  if (REFDATA_MODE === 'static') {
    console.warn('⚠ REFDATA_MODE=static — dropdown queries not covered; the report must flag this deviation');
  }
  return createTradePreflight();
}

// ── Main loop: one iteration = one user's complete action sequence ──
export function journeyIteration() {
  j01CreateTrade({
    i: exec.scenario.iterationInTest,
    runPhase: 'main',
    refdataMode: REFDATA_MODE,
  });
}

// ── Wrap-up ──────────────────────────────────────────────────
export const handleSummary = makeHandleSummary(() => ({
  plan: PLAN,
  env: cfg.envName,
  profile: cfg.profileName,
  target: `${cfg.workersUrl} (E2E: refdata ×2 → calc-risk → create → detail → risk-metrics, refdataMode=${REFDATA_MODE})`,
}));
