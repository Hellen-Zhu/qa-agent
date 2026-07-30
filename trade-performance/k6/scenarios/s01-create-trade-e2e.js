/*
 * scenarios/s01-create-trade-e2e.js
 *
 * [Layer] Runnable plan -- thin shell: executor + thresholds + wrap-up; path logic lives in the journey
 * [What it tests] S-03: the full Create Trade frontend path (PERF-07 / PERF-11 / PERF-19)
 * [How to run] ./k6/run.sh s01-create-trade-e2e dev smoke
 *          ./k6/run.sh s01-create-trade-e2e dev smoke REFDATA_MODE=static
 *          ./k6/run.sh s01-create-trade-e2e dev arrival RATE=1 DURATION=600s REFDATA_MODE=static
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
 * placeholder (NFR pending confirmation #12). Until the address is confirmed,
 * live mode fails explicitly in setup and points at the two ways out:
 *   1) Confirm the refdata address with architecture and put it in
 *      config/dev.json (the proper fix)
 *   2) Run with REFDATA_MODE=static for now (degraded: ownership fields come
 *      from values embedded in the case rows, the dropdown queries are not
 *      covered, and the report must flag the deviation)
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
import { refdataPreflight } from '../setup/refdata-preflight.js';
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

// ── setUp: this scenario touches two paths, so both guards must pass ──
// The thin shell composes only; logic lives in the setup/ modules.
// Order matters: if refdata is unreachable, there is no point creating a trade.
export function setup() {
  refdataPreflight(REFDATA_MODE);
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
