/*
 * journeys/j01-create-trade.js
 *
 * [Layer] journey -- composes steps into one complete frontend user path;
 *        contains no executor / thresholds itself (that is the scenarios' job)
 * [Used by] scenarios/s01-create-trade-e2e.js
 *
 * ── User path ──
 *   1. Open the create-trade page → fetch the two dropdowns   [refdata × 2]
 *      ↓ think: user picks portfolio, picks counterparty, chooses a .dat file
 *   2. Risk preview (soft dependency, failure does not block)  [calc-risk-for-new]
 *      ↓ think: user looks at the preview
 *   3. Submit                                                  [create]
 *      ↓ think: user looks at the submit result
 *   4. View the newly created trade (hits UC gRPC + risk-engine) [detail + risk-metrics]
 *
 * ── refdataMode ──
 *   live    Really fetches the dropdowns (the faithful path). Until the
 *           refdata address is confirmed this gets connection refused --
 *           an explicit failure, see the setup hint in scenarios/s01.
 *   static  Skips the dropdown queries; ownership fields come from values
 *           embedded in the case row
 *           (portfolioId / counterpartyFmId / counterpartyName are right in create-trade.json).
 *           **Known deviation**: does not cover the refdata query path;
 *           the report must flag it.
 *
 * In live mode we only bind live values when both lists come back; if either
 * fails we degrade to the embedded case values and count
 * oreo_refdata_fallback -- a non-zero count means "the page fails on open"
 * would happen to real users too, worth looking at on its own.
 */

import { Counter } from 'k6/metrics';
import { think } from '../lib/think.js';
import { pickCase } from '../steps/workers/trade-management/create-trade-data.js';
import { portfoliosList } from '../steps/refdata/portfolios-list.js';
import { counterpartiesList } from '../steps/refdata/counterparties-list.js';
import { calcRiskForNew } from '../steps/workers/trade-management/calc-risk-for-new.js';
import { createTrade } from '../steps/workers/trade-management/create-trade.js';
import { tradeDetail } from '../steps/workers/trade-management/trade-detail.js';
import { tradeRiskMetrics } from '../steps/workers/trade-management/trade-risk-metrics.js';
import { ERR } from '../lib/errors.js';

export const cRefdataFallback = new Counter('oreo_refdata_fallback');

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * One iteration = one user's complete action sequence, from opening the page
 * to reviewing the details.
 *
 * @param {Object} opts
 * @param {number} opts.i            global iteration number (data cursor)
 * @param {string} opts.runPhase     'setup' | 'main'
 * @param {string} opts.refdataMode  'live' | 'static'
 * @returns the same result object as createTrade (with tradeId / errClass)
 */
export function j01CreateTrade(opts) {
  const { i, runPhase, refdataMode } = opts;
  const caseRow = pickCase(i);

  // ── 1. Open the page: fetch the dropdowns ────────────────
  // When refdata is null, downstream steps fall back to the ownership fields
  // embedded in the case row (static mode and degradation share this path)
  let refdata = null;
  if (refdataMode === 'live') {
    const pf = portfoliosList({ runPhase });
    const cp = counterpartiesList({ runPhase });

    if (pf.errClass === ERR.OK && pf.list.length > 0 &&
        cp.errClass === ERR.OK && cp.list.length > 0) {
      const p = pickRandom(pf.list);
      // ⚠ fmId and name must come from **the same** record -- two independent
      //   random picks would occasionally pair A's fmId with B's name,
      //   showing up as "3% error rate, no pattern" (see the step file's header comment)
      const c = pickRandom(cp.list);
      refdata = {
        portfolioId: String(p.id || ''),
        counterpartyFmId: String(c.fmId || ''),
        counterpartyName: String(c.name || ''),
      };
      // Random rather than modulo: E2E wants a realistic distribution, not a
      // reproducible controlled experiment (the latter is the single-endpoint
      // tests' goal, handled by case-pool round-robin)
    } else {
      cRefdataFallback.add(1); // degrade: downstream steps use the embedded case values
    }
  }

  think(2000, 3000); // user fills the form: picks portfolio, counterparty, file

  // ── 2. Risk preview (soft dependency: failure does not block, matching frontend behavior) ──
  calcRiskForNew({ refdata, caseRow, runPhase });

  think(500, 1500); // user looks at the risk preview

  // ── 3. Submit ────────────────────────────────────────────
  const created = createTrade({ refdata, caseRow, runPhase });

  think(2000, 3000); // user looks at the submit result

  // ── 4. View details ──────────────────────────────────────
  // Skip the whole section when create failed: without this guard we would
  // send GET /trades/NOT_FOUND, producing a batch of 404s that drowns out
  // the real create failures
  if (created.errClass === ERR.OK && created.tradeId !== 'NOT_FOUND') {
    tradeDetail({ tradeId: created.tradeId, runPhase });
    tradeRiskMetrics({ tradeId: created.tradeId, runPhase });
  }

  return created;
}
