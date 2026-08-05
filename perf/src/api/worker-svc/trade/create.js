import http from 'k6/http';
import * as client from '../../../lib/http.js';
import { classifyResponse, reasonFrom } from '../../../lib/errors.js';
import { extractTaskId } from '../checker-flow/tasks.js';
import { getDat, datName } from './create-data.js';

const SVC = 'worker-svc';
const MOD = 'trade';

// The read path (queryTrades / perf_trades_rows) lives in ./query.js (init-graph isolation, final review #4):
// this file holds only create + its ./create-data.js data graph, so load-testing other APIs does not
// transitively load the case pool and the dat binaries.

/*
 * ── Response contract for create (calibrated against live trade-performance measurements;
 *    business classification belongs to this file, lib/errors.js is only the engine) ──
 * Success = HTTP 200 + code=200 + status='PENDING APPROVAL' + data.trade.id ~ TRD-[A-Za-z0-9]+
 * (id relaxed from TRD-\d+ on 2026-08-05: real dev data contains hex-suffixed ids.)
 * msg carries the checker TaskId ("Submitted for checker approval. TaskId: CHK-...") — the
 * classify result is returned with `taskId` attached so the seed pipeline can approve directly.
 * On the first intranet run, confirm the contract has not changed with the release (env-checklist).
 */
const REJECT_PATTERNS = [
  // The server names uploaded temp files by timestamp; concurrent uploads in the same instant delete
  // each other's temp files → "dat not found"
  // (workaround switch and attribution when this is hit: spec §11-4; the regex matches real server error
  //  text, which may contain Chinese — the escapes below are "does not exist" / "cannot find", keep them)
  { reason: 'dat-missing', re: /(dat|file).*(not\s*found|missing|\u4e0d\u5b58\u5728)|\u627e\u4e0d\u5230/i },
];

/** trade fields (the plain form fields of the multipart body). Must JSON.stringify —
 *  real counterparty names contain * and non-ASCII; hand-built strings will sooner or later produce invalid JSON */
export function buildTradePayload(caseRow) {
  return JSON.stringify({
    basic: {
      portfolioId: caseRow.portfolioId,
      counterpartyFmId: caseRow.counterpartyFmId,
      counterpartyName: caseRow.counterpartyName,
      notionalCurrency: caseRow.notionalCurrency || '',
    },
  });
}

// Placeholder patterns: deliberately no PERF prefix — the dedicated PERF portfolio is a legitimate
// real value (spec §6). The escape is the Chinese for "TBD", kept so Chinese placeholders still match.
const PLACEHOLDER = /^\s*(tbc|todo|xxx+|n\/a|\u5f85\u5b9a|placeholder)\s*$/i;

/** Not optional under static data supply: unresolved/placeholder fields would still be sent →
 *  server-side business rejection → the report shows "elevated error rate" instead of
 *  "the script is wrong" — the hardest failure class to debug */
export function validateInputs(caseRow) {
  const problems = [];
  ['portfolioId', 'counterpartyFmId', 'counterpartyName'].forEach((k) => {
    const v = caseRow[k];
    if (!v || !String(v).trim()) problems.push(`${k} unresolved (check the data file path and field names, see ./trades-data.js)`);
    else if (PLACEHOLDER.test(v)) problems.push(`${k}='${v}' is still a placeholder (see data/worker-svc/trade/README.md)`);
  });
  if (!caseRow.productType || !String(caseRow.productType).trim()) {
    problems.push('productType unresolved (the dat is located by the same-name-as-productType convention, see ./trades-data.js)');
  }
  return problems;
}

/** Send one create. The single request outlet — preflight and the main loop share this contract. */
export function createTrade(cfg, caseRow, user, runPhase) {
  const body = {
    trade: buildTradePayload(caseRow),
    datFile: http.file(getDat(caseRow.productType), datName(caseRow.productType), 'application/octet-stream'),
  };
  const { res, tags } = client.postMultipart(cfg, SVC, '/api/v1/trades/create', body, {
    name: 'POST /api/v1/trades/create', module: MOD, user,
    // Low-cardinality tags: row = data row number (__row), so a bad row can be sliced straight out
    // of the metrics; unique values like tradeId are strictly forbidden
    tags: {
      runPhase: runPhase || 'main',
      row: String(caseRow.__row || 0),
      productType: caseRow.productType || 'NA',
    },
  });
  const out = classifyResponse(res, tags, {
    business: (b) =>
      b.code !== 200 || b.status !== 'PENDING APPROVAL'
        ? {
            reason: reasonFrom(b, REJECT_PATTERNS),
            detail: `business: code=${b.code} status=${b.status} msg=${String(b.msg || '').slice(0, 160)}`,
          }
        : null,
    shape: (b) => {
      const id = b.data && b.data.trade ? String(b.data.trade.id || '') : '';
      return /^TRD-[A-Za-z0-9]+$/.test(id) ? null : `unexpected tradeId format — '${id}'`;
    },
  });
  // Business success without a parsable TaskId is NOT a failure (taskId stays null);
  // the seed pipeline drops such rows and logs a warning — measurement rounds ignore it.
  out.tradeId = out.body && out.body.data && out.body.data.trade ? String(out.body.data.trade.id || '') : '';
  out.taskId = out.body ? extractTaskId(out.body.msg) : null;
  return out;
}
