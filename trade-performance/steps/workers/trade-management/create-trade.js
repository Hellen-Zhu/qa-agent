/*
 * steps/workers/trade-management/create-trade.js
 *
 * [Layer] Atomic step -- one API per file
 * [API]   workers.trade-management.create  ·  POST /trades/create
 *
 * ══ Single source of truth ═══════════════════════════════════════
 * create's request construction, response classification, and result
 * extraction are defined here exactly once.
 * **setUp's preflight check calls this same function** -- both callers share
 * one contract, and `import` naturally guarantees there is no second copy.
 *
 * The callers differ **not in the request**, only in:
 *   - the runPhase tag they pass (setup / main)
 *   - the policy they apply to the return value (preflight aborts the test,
 *     the main loop only records)
 * ═══════════════════════════════════════════════════════════════
 *
 * ── multipart essentials (calibrated against the real curl, do not change) ──
 * As soon as the request body contains http.file(), k6 automatically encodes
 * it as multipart/form-data and **generates the boundary itself**.
 *
 * ⚠ Never hand-write Content-Type in headers -- a hand-written value has no
 *   boundary and overrides the generated one, so the server can't split parts.
 *
 * `trade` is a **plain form field** (the real curl uses -F 'trade={...}',
 * not -F 'trade=@file'), so passing a string directly is enough; no temp
 * file needed.
 */

import http from 'k6/http';
import { cfg } from '../../../lib/config.js';
import { getDat, uploadName } from './create-trade-data.js';
import { classifyResponse, reasonFrom, ERR } from '../../../lib/errors.js';

const URL = `${cfg.workersUrl}/trades/create`;

/*
 * ── create's response contract (business classification belongs to this
 *    file; the shared errors.js is engine only) ──
 * Success shape: HTTP 200 + code=200 + status='PENDING APPROVAL'
 *          + data.trade.id matching TRD-\d+
 * taskId only exists inside the natural-language msg:
 *   "Submitted for checker approval. TaskId: CHK-98C0DF19"
 * Regex scraping is the only option; any wording change breaks it (already
 * raised to the developers as an improvement).
 */

// Attribution patterns for business rejections: calibrated against actually
// observed msg values, extended entry by entry.
// Raw texts are collected via the rate-limited logging in errors.js → fed
// back here to tighten the regexes.
const REJECT_PATTERNS = [
  // Server temp-file race: concurrent same-instant uploads get timestamp
  // temp names that collide; whichever request finishes first deletes the
  // shared temp file and the other fails with "dat not found".
  // (DAT_NAME_MODE in ./create-trade-data.js is the bypass switch.)
  // The regex matches real server error messages, which may be Chinese --
  // do not translate it.
  { reason: 'dat-missing', re: /(dat|file).*(not\s*found|missing|不存在)|找不到/i },
];

function classifyCreate(res, tags) {
  const out = classifyResponse(res, tags, {
    business: (body) =>
      body.code !== 200 || body.status !== 'PENDING APPROVAL'
        ? {
            reason: reasonFrom(body, REJECT_PATTERNS),
            // Truncate msg: the response text can be a whole stack trace;
            // the beginning is enough for triage
            detail: `business: code=${body.code} status=${body.status} msg=${String(body.msg || '').slice(0, 160)}`,
          }
        : null,
    // Validate the format, not just non-emptiness: extraction-failure
    // fallback values are also non-empty strings, and a weak assertion
    // would let them through
    shape: (body) => {
      const id = body.data && body.data.trade ? String(body.data.trade.id || '') : '';
      return /^TRD-\d+$/.test(id) ? null : `unexpected tradeId format — '${id}'`;
    },
  });

  if (out.errClass !== ERR.OK) {
    return { errClass: out.errClass, detail: out.detail, tradeId: 'NOT_FOUND', taskId: 'NOT_FOUND' };
  }

  const m = /TaskId:\s*(CHK-[A-Za-z0-9]+)/.exec(String(out.body.msg || ''));
  return {
    errClass: ERR.OK,
    detail: 'ok',
    tradeId: String(out.body.data.trade.id),
    taskId: m ? m[1] : 'NOT_FOUND',
  };
}

/**
 * Build the value of the `trade` field in the multipart body.
 *
 * Use JSON.stringify rather than string concatenation: real counterparty
 * names contain `*` (PRINTINGINT10LTD*HKG), and quotes, backslashes, and
 * non-ASCII can also appear. Hand-built strings will sooner or later produce
 * invalid JSON, and that failure shows up as "occasional 400s on some rows"
 * -- extremely hard to track down.
 */
export function buildTradePayload(refdata, caseRow) {
  return JSON.stringify({
    basic: {
      portfolioId: refdata.portfolioId,
      counterpartyFmId: refdata.counterpartyFmId,
      counterpartyName: refdata.counterpartyName,
      notionalCurrency: caseRow.notionalCurrency || '',
    },
  });
}

/**
 * Verify the inputs were actually resolved.
 *
 * In static-data mode this step cannot be skipped: with a wrong data file
 * path or mismatched field names, fields end up undefined / empty / a
 * placeholder, the request goes out anyway, and the server returns a
 * business rejection -- the report shows "error rate went up" instead of
 * "the script is wrong", one of the hardest failure classes to diagnose.
 */
const PLACEHOLDER = /^\s*(tbc|todo|xxx+|n\/a|待定|placeholder)\s*$/i;

export function validateInputs(caseRow) {
  const problems = [];

  ['portfolioId', 'counterpartyFmId', 'counterpartyName'].forEach((k) => {
    const v = caseRow[k];
    if (!v || !String(v).trim()) problems.push(`${k} not resolved (check the data file path and field names, see ./create-trade-data.js)`);
    else if (PLACEHOLDER.test(v)) problems.push(`${k}='${v}' is still a placeholder (see data/workers/trade-management/README.md)`);
  });

  if (!caseRow.datFile || !String(caseRow.datFile).trim()) {
    problems.push('datFile not resolved (check the data file path and field names, see ./create-trade-data.js)');
  }

  return problems;
}

/**
 * Send one create. **The only request exit point.**
 *
 * @param {Object}  opts
 * @param {Object}  opts.caseRow    one create-trade.json row (with embedded ownership fields)
 * @param {Object}  [opts.refdata]  overrides the ownership fields (passed in E2E live-mode
 *                                  on-the-fly binding); if omitted, the case's embedded
 *                                  portfolioId / counterpartyFmId / counterpartyName are used
 * @param {string}  opts.runPhase   'setup' | 'main'
 * @param {string}  [opts.userId]   identity, defaults to maker
 * @returns {{res, errClass, detail, tradeId, taskId, tags, tradeReference}}
 */
export function createTrade(opts) {
  const { caseRow, runPhase } = opts;
  const refdata = opts.refdata || caseRow;
  const userId = opts.userId || cfg.makerUserId;

  // ── Low-cardinality tags: they become metric dimensions used to slice results ──
  // ⚠ Never add per-request values like tradeId / tradeReference here (see lib/errors.js)
  const tags = {
    name: 'workers_trademgmt_create',   // k6 aggregates each step's metrics by the name tag
    runPhase: runPhase,
    // row = data file row number (the __row auto-injected by rows.js) --
    // "which data row is broken" can be sliced straight from the metrics.
    // Not a test case id: a row is just one data variant
    row: String(caseRow.__row || 0),
    productType: caseRow.productType || 'NA',
  };

  const body = {
    trade: buildTradePayload(refdata, caseRow),
    // filename comes from uploadName: original name by default; with
    // DAT_NAME_MODE=unique a unique suffix is added to bypass the server
    // temp-file race (deviation switch, see ./create-trade-data.js)
    datFile: http.file(
      getDat(caseRow.datFile),
      uploadName(caseRow.datFile),
      'application/octet-stream'
    ),
  };

  const res = http.post(URL, body, {
    headers: {
      accept: '*/*',
      // Identity: this system has no login and no token -- authorization is
      // decided entirely by this header (NFR SEC-01/SEC-02).
      'X-User-Id': userId,
    },
    timeout: cfg.requestTimeout,
    tags: tags,
  });

  const outcome = classifyCreate(res, tags);

  return Object.assign({ res, tags }, outcome, {
    // Business-unique identifier: exists only in the results file, never
    // written to the system under test
    // (the payload currently accepts no extra fields -- which is exactly why
    //  the cleanup strategy can only fall back on
    //  "dedicated PERF Portfolio + status + time window")
    tradeReference: `PERF-r${caseRow.__row || 0}-${runPhase}`,
  });
}
