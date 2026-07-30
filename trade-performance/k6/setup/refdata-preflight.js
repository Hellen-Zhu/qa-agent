/*
 * setup/refdata-preflight.js -- pre-run guard for the **refdata query path**
 *
 * Naming convention: see the header comment in setup/create-trade-preflight.js.
 * Used by: scenarios/s01-create-trade-e2e.js (only E2E touches refdata; p02 does not)
 *
 * ── What it guards: "has the degradation been silently enabled" ──
 * The refdata service address in config is still a localhost placeholder
 * (NFR pending confirmation #12). In live mode a wrong address = every
 * iteration silently taking the fallback, and the run produces a report that
 * "looks fine but never covered the refdata queries at all". So we **assert
 * before the run starts**: unreachable means immediate abort, with the two
 * clear ways out spelled out.
 *
 * static mode sends no request and only prints a deviation notice -- which
 * must be stated in the report.
 */

import exec from 'k6/execution';
import { cfg } from '../lib/config.js';
import { portfoliosList } from '../steps/refdata/portfolios-list.js';
import { ERR } from '../lib/errors.js';

/**
 * @param {string} mode  'live' | 'static'
 */
export function refdataPreflight(mode) {
  console.log(`── preflight: refdata (mode=${mode}) ─────────`);

  if (mode !== 'live') {
    console.warn('⚠ REFDATA_MODE=static — does not cover the refdata query path; the report must flag this deviation');
    return;
  }

  const probe = portfoliosList({ runPhase: 'setup' });
  if (probe.errClass !== ERR.OK) {
    exec.test.abort(
      `PREFLIGHT FAILED — refdata unreachable (${probe.detail}). ` +
      `The refdata address in config/${cfg.envName}.json may still be a placeholder (NFR pending confirmation #12). ` +
      `Two ways out: (1) confirm the address with architecture and put it in config; (2) run with REFDATA_MODE=static for now ` +
      `(degraded: dropdown queries not covered, the report must flag the deviation)`
    );
  }
  console.log(`✓ refdata reachable (${probe.list.length} portfolios)`);
}
