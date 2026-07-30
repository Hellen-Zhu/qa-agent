/*
 * setup/create-trade-preflight.js -- local data validation for the
 * **create-trade path**. Runs in setup(): once, before the whole test.
 *
 * ── What this guards (and what it deliberately does NOT) ──
 * It answers exactly one question, **without sending any request**:
 * "is the data file filled in?" -- placeholders (TBC), missing fields,
 * empty pool. These make *every* iteration fail identically; catching
 * them here costs nothing and reports precise row numbers.
 *
 * It does NOT probe the server. An earlier version sent one real create
 * from setup() ("is the data still valid today?"); that was removed
 * deliberately (2026-07-30):
 *   - it validated only row 1 of the pool -- a sampled guarantee that
 *     read as a proof;
 *   - it could not cover data going stale MID-run anyway;
 *   - the setup-phase request polluted every request-level metric
 *     (summary vs. Grafana iteration counts differed by exactly 1)
 *     and left one real PENDING APPROVAL trade per run.
 * Server-side validity is owned by two stronger mechanisms instead:
 *   1. session discipline -- run a smoke in the same session before big
 *      rounds ("does the API accept this data right now");
 *   2. in-run circuit breakers -- long-run profiles carry a loose
 *      abortOnFail threshold on oreo_business_success (rate>0.50,
 *      delayAbortEval 3m): wholesale rejection kills the run in minutes
 *      whether the data was stale at launch or went stale mid-run.
 *
 * Used by: scenarios/p02-trade-create.js, scenarios/s01-create-trade-e2e.js
 * (guards bind to paths, not scenarios).
 */

import exec from 'k6/execution';
import { createCases, pickCase, DATA_FILE, DAT_NAME_MODE } from '../steps/workers/trade-management/create-trade-data.js';
import { validateInputs } from '../steps/workers/trade-management/create-trade.js';

export function createTradePreflight() {
  console.log(`── preflight: create-trade (local data check) ──`);
  console.log(`data=${DATA_FILE}  rows=${createCases.length}`);
  if (DAT_NAME_MODE === 'unique') {
    // The deviation must be loud in both the log and the report: production
    // users do not rename files before uploading
    console.warn(
      '⚠ DAT_NAME_MODE=unique — upload filenames get a unique suffix, bypassing the server-side temp-file race defect. ' +
      'The report must flag the deviation; once the defect is fixed, turn this switch off and rerun the concurrency test (regression verification)'
    );
  }

  // ── Data existence ──────────────────────────────────────
  if (createCases.length === 0) {
    exec.test.abort(`PREFLIGHT FAILED — data file has no data rows: ${DATA_FILE}`);
  }

  // ── Local validation: no request ────────────────────────
  // Check every row, not just the first -- a placeholder value on row 5
  // blows up just the same when the run reaches it.
  const allProblems = [];
  for (let i = 0; i < createCases.length; i++) {
    const problems = validateInputs(pickCase(i));
    problems.forEach((p) => allProblems.push(`[row ${pickCase(i).__row}] ${p}`));
    if (i >= 50) break;   // enough sampling for large datasets
  }

  if (allProblems.length > 0) {
    // Stop right here -- placeholder values make **every** request fail
    // business-wise; running on would only produce a report with a 100%
    // error rate. There is no "partially usable".
    console.error('PREFLIGHT FAILED — static data unusable:');
    allProblems.slice(0, 10).forEach((p) => console.error('  ' + p));
    exec.test.abort(`Static data unusable (${allProblems.length} problems, see log above)`);
  }
  console.log('✓ local data check: fields complete, no placeholder values');

  // Must be JSON-serializable (the runtime copies it to every VU).
  return { startedAt: new Date().toISOString(), dataFile: DATA_FILE };
}
