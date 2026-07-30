/*
 * scenarios/p02-trade-create.js
 *
 * [Layer] Runnable plan -- thin shell, defines no requests itself
 * [What it tests] Pure server-side capacity of POST /trades/create
 * [How to run] ./k6/run.sh p02-trade-create dev smoke
 *
 * ── Key differences from the E2E scenario ──
 * 1. **No refdata lookups at all** -- portfolio / counterparty come straight
 *    from static data. In E2E, refdata is part of the path under test;
 *    in a single-endpoint test it is noise.
 * 2. **No think time** -- we measure "how much the server handles per second",
 *    not user experience.
 * 3. **No view-trade-details** -- same reason.
 *
 * ── Counting semantics ──
 * http_reqs equals the number of requests (no "transaction row + sample row"
 * double counting); setup() does not consume scenario iterations, preflight
 * does not consume the first data row, and it stays out of the main loop's
 * timing stats (it carries runPhase=setup, so it is naturally separable).
 */

import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { pickCase, DAT_NAME_MODE } from '../steps/workers/trade-management/create-trade-data.js';
import { createTrade } from '../steps/workers/trade-management/create-trade.js';
import { createTradePreflight } from '../setup/create-trade-preflight.js';
import { makeHandleSummary } from '../lib/summary.js';

const PLAN = 'p02-trade-create';

export const options = {
  scenarios: {
    // The scenario block in the profile IS the k6 executor config, no re-translation.
    // Switching load model = switching -e PROFILE=xxx, zero script changes
    // (the three dimensions are orthogonal).
    create: Object.assign({ exec: 'createTradeIteration' }, cfg.scenario),
  },

  thresholds: Object.assign(
    {
      // This one is a baseline that **must hold for any profile**, and is not
      // up to the profile: a script error = a script bug, this run's results
      // are void. Tolerance for technical / business errors varies by profile
      // (smoke demands 0; technical errors past the knee are exactly what a
      // ladder run is meant to find), so those live in the profile.
      oreo_err_script: ['count==0'],
    },
    cfg.thresholds
  ),

  // The default summary omits percentiles beyond P50; specify explicitly
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],

  // We parse response bodies for business-level verdicts; cannot discard them
  discardResponseBodies: false,

  // All metrics carry env/profile tags by default, so runs are separable in Grafana
  tags: {
    plan: PLAN,
    env: cfg.envName,
    profile: cfg.profileName,
    datNameMode: DAT_NAME_MODE, // unique = deviation run that bypasses the server-side temp-file race; results must be distinguishable
  },
};

// ── setUp: pre-run guard ─────────────────────────────────────
export function setup() {
  return createTradePreflight();
}

// ── Main loop: one iteration = one create ────────────────────
export function createTradeIteration() {
  // Globally monotonic counter across all VUs -- a global data cursor
  const i = exec.scenario.iterationInTest;

  createTrade({
    caseRow: pickCase(i),   // ownership fields are embedded in the case row; no separate refdata passed
    runPhase: 'main',
    // Identity is fixed to one maker, no rotation (NFR SEC-02, see config/dev.json).
    // For a "spread across makers vs. same maker" comparison experiment,
    // pick different accounts here by exec.vu.idInTest -- but that is
    // a different experiment.
  });
}

// ── Wrap-up ──────────────────────────────────────────────────
export const handleSummary = makeHandleSummary(() => ({
  plan: PLAN,
  env: cfg.envName,
  profile: cfg.profileName,
  target: `${cfg.workersUrl}/trades/create`,
}));
