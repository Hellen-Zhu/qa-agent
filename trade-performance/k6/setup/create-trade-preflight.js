/*
 * setup/create-trade-preflight.js -- pre-run guard for the **create-trade path**
 *
 * ── Naming convention ──
 *   setup/<path-under-test>-preflight.js  exports <pathUnderTest>Preflight()
 *   Paired with lib/<path-under-test>-data.js: where the data comes from,
 *   and how we prove it still works today.
 * Guards **follow the path under test**, they are not global infrastructure --
 * p05 loading the list endpoint should not run a guard that creates a trade;
 * it has its own setup/trades-list-preflight.js.
 *
 * Used by: scenarios/p02-trade-create.js, scenarios/s01-create-trade-e2e.js
 * -- both scenarios create trades, so sharing one guard is correct
 * (guards bind to paths, not scenarios).
 *
 * Runs in setup(): **executed once before the whole test starts**; the return
 * value is serialized by the runtime and copied to every VU.
 *
 * ══ Why this step cannot be skipped with static data ═════════
 * In live mode, stale data is **exposed on the spot** when setup queries
 * refdata. Static data has no such query -- if an id in the data file has
 * gone stale (counterparty deactivated by a third party, portfolio archived),
 * the requests still go out and the server returns business rejections.
 * In the report that shows up as "elevated error rate" rather than
 * "startup failure", and gets misread as a performance problem.
 *
 * So this is not optional hardening; it is static data's **only** proof of
 * validity. A row of static data proves nothing by itself -- only actually
 * sending one create does.
 * ═══════════════════════════════════════════════════════════
 *
 * ── Division of labor between the two checks (do not merge) ──
 *   1. Local check   Is the data file **filled in**?      No request; stop on failure
 *   2. preflight     Are the values **still usable today**? Must really send one
 * The former guards against script errors, the latter against stale data.
 * If the former fails, running the latter is pointless.
 */

import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { createCases, pickCase, DATA_FILE, DAT_NAME_MODE } from '../steps/workers/trade-management/create-trade-data.js';
import { createTrade, validateInputs } from '../steps/workers/trade-management/create-trade.js';
import { ERR } from '../lib/errors.js';

export function createTradePreflight() {
  console.log(`── preflight: create-trade ───────────────────`);
  console.log(`env=${cfg.envName} profile=${cfg.profileName}`);
  console.log(`target=${cfg.workersUrl}/trades/create`);
  console.log(`maker=${cfg.makerUserId}`);
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

  // ── Check 1: local, no request ──────────────────────────
  // Check every row, not just the first -- a placeholder value on row 5
  // blows up just the same when the run reaches it.
  const allProblems = [];
  for (let i = 0; i < createCases.length; i++) {
    const problems = validateInputs(pickCase(i));
    problems.forEach((p) => allProblems.push(`[row ${pickCase(i).__row}] ${p}`));
    if (i >= 50) break;   // enough sampling for large datasets
  }

  if (allProblems.length > 0) {
    // Stop right here, no warn branch -- placeholder values make **every**
    // request fail business-wise; running on would only produce a report
    // with a 100% error rate. There is no "partially usable".
    console.error('PREFLIGHT FAILED — static data unusable:');
    allProblems.slice(0, 10).forEach((p) => console.error('  ' + p));
    exec.test.abort(`Static data unusable (${allProblems.length} problems, see log above)`);
  }
  console.log('✓ check 1/2: data fields complete, no placeholder values');

  // ── Check 2: remote, really send one ────────────────────
  const caseRow = pickCase(0);
  const r = createTrade({ caseRow, runPhase: 'setup' });

  const usable = r.errClass === ERR.OK;

  if (usable) {
    console.log(
      `✓ check 2/2: data is business-usable — row ${caseRow.__row} ` +
      `portfolio=${caseRow.portfolioId} → ${r.tradeId} / ${r.taskId} ` +
      `(${Math.round(r.res.timings.duration)}ms)`
    );
  } else {
    const msg = `PREFLIGHT FAILED [${cfg.preflightPolicy}] — ${r.detail}`;
    if (cfg.preflightPolicy === 'abort') {
      // If the data is unusable the whole run is pointless. Stop here to
      // avoid producing a "100% error rate" report that gets taken for a
      // performance conclusion.
      console.error(msg + ' — stopping test');
      exec.test.abort(msg);
    } else {
      // warn: keep running, but leave the status to the analysis phase.
      // This only works if someone actually looks at the analysis --
      // if nobody does, this policy amounts to no validation at all.
      console.warn(msg + ' — continuing anyway (warn policy)');
    }
  }

  // ── What gets passed to every VU ─────────────────────────
  // Must be JSON-serializable. Only metadata goes here; the data itself is
  // read by each VU from the SharedArray.
  return {
    startedAt: new Date().toISOString(),
    preflightOutcome: usable ? 'ok' : cfg.preflightPolicy,
    preflightDurationMs: Math.round(r.res.timings.duration),
    dataFile: DATA_FILE,
    env: cfg.envName,
    profile: cfg.profileName,
    target: `${cfg.workersUrl}/trades/create`,
  };
}
