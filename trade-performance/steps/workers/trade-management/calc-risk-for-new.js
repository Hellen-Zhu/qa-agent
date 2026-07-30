/*
 * steps/workers/trade-management/calc-risk-for-new.js
 *
 * [Layer] Atomic step -- one API per file
 * [API]   workers.trade-management.calc-risk-for-new  ·  POST /trades/calculate-risk-for-new
 *
 * ── Advisory risk check (soft dependency, v2 §2.3) ──
 * The frontend calls this after the user fills in the form to preview risk;
 * **failure does not block continuing to create** -- in the journey its
 * return value is only recorded, never aborts. But it shares the .dat upload
 * with create, and its DAT-parsing CPU cost is real: skipping this step in
 * E2E would make create's resource profile look too optimistic
 * (NFR PERF-11 is its dedicated threshold).
 *
 * ── Pass/fail criteria ──
 * Only HTTP 200 is checked: this endpoint's business response shape is
 * unconfirmed, so no guessing yet. Non-200 counts as technical -- soft
 * dependency failures are **not masked** by default: a 503 is unexpected and
 * must show up glaringly in the report.
 * (The softDependencyMasking degradation-experiment mode is not implemented
 * yet; add it when doing S-11.)
 *
 * The payload is built from the exact same source as create (imports the
 * same buildTradePayload).
 */

import http from 'k6/http';
import { Rate } from 'k6/metrics';
import { cfg } from '../../../lib/config.js';
import { getDat, uploadName } from './create-trade-data.js';
import { buildTradePayload } from './create-trade.js';
import { recordOutcome, logFailure, techReason, ERR } from '../../../lib/errors.js';

const URL = `${cfg.workersUrl}/trades/calculate-risk-for-new`;

// Soft-dependency health gets its own Rate: visible in the error rate, and
// stays separate from create when slicing by dimension
export const rRiskPreview = new Rate('oreo_risk_preview_ok');

/**
 * @param {Object} opts  {caseRow, refdata?, runPhase, userId}
 *   If refdata is omitted, the case row's embedded ownership fields are used
 *   (same convention as createTrade)
 * @returns {{res, ok, errClass, riskFailCode, tags}}
 */
export function calcRiskForNew(opts) {
  const { caseRow, runPhase } = opts;
  const refdata = opts.refdata || caseRow;
  const userId = opts.userId || cfg.makerUserId;

  const tags = {
    name: 'workers_trademgmt_calcriskfornew',
    runPhase: runPhase,
    row: String(caseRow.__row || 0),
    productType: caseRow.productType || 'NA',
  };

  const body = {
    trade: buildTradePayload(refdata, caseRow),
    // Uses the same uploadName as create: this endpoint also parses the .dat
    // and most likely goes through the same temp-file mechanism; changing
    // only create would leave half the collision surface (DAT_NAME_MODE is
    // documented in the data module)
    datFile: http.file(
      getDat(caseRow.datFile),
      uploadName(caseRow.datFile),
      'application/octet-stream'
    ),
  };

  const res = http.post(URL, body, {
    headers: {
      accept: '*/*',
      'X-User-Id': userId,
    },
    timeout: cfg.requestTimeout,
    tags: tags,
  });

  const ok = res.status === 200;
  if (ok) {
    recordOutcome(ERR.OK, tags, res);
  } else {
    const reason = techReason(res);
    recordOutcome(ERR.TECHNICAL, tags, res, reason);
    // Soft-dependency failure doesn't block the journey, but must leave
    // evidence -- a silent 503 is the hardest thing to trace afterwards
    logFailure(ERR.TECHNICAL, reason, `technical: HTTP ${res.status}${res.error ? ' ' + res.error : ''}`, tags);
  }
  rRiskPreview.add(ok, tags);

  return {
    res,
    tags,
    ok,
    errClass: ok ? ERR.OK : ERR.TECHNICAL,
    // Keep the raw status code: a 503 (downstream down) and a 504 (timeout)
    // call for completely different handling
    riskFailCode: ok ? '' : String(res.status),
  };
}
