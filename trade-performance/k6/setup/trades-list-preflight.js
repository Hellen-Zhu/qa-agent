/*
 * setup/trades-list-preflight.js -- pre-run guard for the **trades-list path**
 *
 * Naming convention: see the header comment in setup/create-trade-preflight.js.
 * Used by: scenarios/p05-trades-list.js
 *
 * ── Essential difference from the create-trade guard ──
 * A read endpoint has no "static data can go stale" problem class, so it
 * **creates no trade**. It has to prove two other things:
 *   1. This query actually returns rows (unreachable / not JSON → the whole
 *      run is pointless, abort immediately)
 *   2. How much data is in the DB -- **the data-volume declaration of entry
 *      criterion #3**: list conclusions from an empty or tiny DB can only
 *      serve as trends, never capacity conclusions; without the total stated,
 *      P95 cannot be compared across runs at all.
 *
 * ⚠ This module **does not import create-trade's data module** -- a read
 *   endpoint needs no case pool or .dat; importing it would load all .dat
 *   into memory at init (that module is eagerly loaded).
 */

import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { tradesList } from '../steps/workers/trade-management/trades-list.js';
import { ERR } from '../lib/errors.js';

/**
 * @param {Object} opts  {pageSize, page, status} -- same query parameters as
 *                       the main loop; otherwise preflight validates a
 *                       different query than the one about to be loaded
 * @returns {{startedAt, totalTrades}}  metadata passed to every VU
 */
export function tradesListPreflight(opts) {
  const { pageSize, page, status } = opts;

  console.log(`── preflight: trades-list (read endpoint) ────`);
  console.log(`env=${cfg.envName} profile=${cfg.profileName}`);
  console.log(`target=${cfg.workersUrl}/trades  pageSize=${pageSize}`);

  const r = tradesList({ runPhase: 'setup', pageSize, page, status });

  if (r.errClass !== ERR.OK) {
    // Unreachable / not JSON: load testing is pointless, and continuing would
    // only produce a 100%-error report
    exec.test.abort(`PREFLIGHT FAILED — ${r.detail}`);
  }

  if (r.rowCount === 0) {
    console.warn(
      '⚠ No trades found in the DB — list conclusions from an empty DB are invalid (entry criterion #3 / A16). ' +
      'This run can only serve as script verification, not a performance conclusion.'
    );
  } else if (r.rowCount < 0) {
    console.warn('⚠ Could not extract row count from the response — pagination wrapper shape unknown; inspect the body manually before loading');
  } else {
    console.log(`✓ preflight: ${r.rowCount} rows returned (${Math.round(r.res.timings.duration)}ms)`);
  }

  // Data-volume declaration: the report must state the DB total, otherwise
  // P95 cannot be compared with other runs
  if (r.total >= 0) {
    console.log(`ℹ Total trades in DB ≈ ${r.total} — put this in the report (the data-volume tier metric for S-10)`);
  } else {
    console.log('ℹ No total metadata in the response — confirm the data volume with the DBA and put it in the report');
  }

  return { startedAt: new Date().toISOString(), totalTrades: r.total };
}
