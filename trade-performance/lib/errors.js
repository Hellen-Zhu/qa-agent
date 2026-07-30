/*
 * lib/errors.js — three-way error separation
 *
 * ══ Why HTTP status codes alone are not enough ═══════════════
 * This API **returns HTTP 200 even on business failure** — the business
 * status lives in the body's code / status fields. A report that only looks
 * at status codes shows "0% errors" while not a single trade was actually
 * created. This is the single easiest place in this project to produce a
 * misleading report.
 *
 * ══ The three classes must stay separate — the responses differ ═══
 *   technical  connection failure / timeout / 5xx → the system can't cope;
 *              **this is the performance conclusion**
 *   business   HTTP 200 but business rejection    → usually stale test data,
 *              not a performance problem
 *   script     extraction failed / non-JSON body  → script bug; **the whole
 *              run is void**
 * A report that lumps them into one "error rate" is unusable: is a 12%
 * error rate a dev problem or a data problem?
 * ═══════════════════════════════════════════════════════════
 *
 * ⚠ Tag cardinality:
 *   k6 tags are **metric dimensions**; high-cardinality tags blow up memory
 *   and Prometheus storage.
 *
 *   → OK to tag: runPhase / row (data row number) / productType / errClass /
 *     reason (each a small bounded set)
 *   → **NEVER** tag: tradeId / taskId / tradeReference (unique per request)
 *   For per-request detail use --out csv or structured logs, not tags.
 */

import { Counter, Rate, Trend } from 'k6/metrics';

// ── Counters: four mutually exclusive classes summing to total requests ──
export const cOk = new Counter('oreo_ok');
export const cTechnical = new Counter('oreo_err_technical');
export const cBusiness = new Counter('oreo_err_business');
export const cScript = new Counter('oreo_err_script');

// ── Business success rate: THE "error rate" to watch, not http_req_failed ──
export const rBusinessSuccess = new Rate('oreo_business_success');

// ── Duration of **business-successful** requests only ─────────
// Failed requests (especially fast rejections) drag P95 down and make
// capacity look better than it is.
export const tSuccessDuration = new Trend('oreo_success_duration', true);

export const ERR = {
  OK: 'ok',
  TECHNICAL: 'technical',
  BUSINESS: 'business',
  SCRIPT: 'script',
};

/*
 * ── reason: failure-cause dimension (low cardinality) ─────────
 * errClass answers "who to call" (dev / data / script); reason answers
 * "what exactly happened". Without it, 40 business errors in a run is just
 * a number — dat races, stale ownership fields, and duplicate submissions
 * all blur together and triage means digging through CSV and guessing.
 *
 * ⚠ reason becomes a metric dimension, so only **bounded** values are
 *   allowed: pattern-table slots + server-side code enum + HTTP status
 *   codes, all bounded.
 *   **Never use raw msg text as reason** — free text is unbounded, same as
 *   tagging tradeId.
 */

// The attribution **pattern table for business rejections belongs to each
// API's contract** and is defined in its own step file (one file per API);
// this module only provides matching + fallback. Raw samples are collected
// via the rate-limited logFailure logging below → fed back into each step's
// pattern table.
export function reasonFrom(body, patterns) {
  const msg = String((body && body.msg) || '');
  for (let i = 0; i < (patterns || []).length; i++) {
    if (patterns[i].re.test(msg)) return patterns[i].reason;
  }
  // Fallback: the server-side business code — enum values of the uniform
  // response envelope {code, status, msg, data}, inherently bounded
  const code = body && body.code;
  return typeof code === 'number' ? 'code-' + code : 'code-unknown';
}

export function techReason(res) {
  // status=0 means the connection layer itself failed (timeout/refused/DNS);
  // error_code is k6's bounded error enum
  return res.status > 0 ? 'http-' + res.status : 'net-' + (res.error_code || 0);
}

/*
 * ── Rate-limited on-the-spot logging ────────────────────────
 * Previously failures only hit counters — not a single sample in k6.log,
 * so triage meant digging through CSV afterwards. But logging everything is
 * no good either: under high concurrency with widespread failures, console
 * I/O itself squeezes the load generator, and thousands of identical lines
 * add no information. Compromise: **per VU, log the first 3 of each
 * (errClass, reason) pair in full**, then go silent — counts live in
 * metrics, per-request detail in result.csv.
 */
const LOG_CAP = 3;
const logSeen = {}; // each VU has its own VM, so this is naturally per-VU

export function logFailure(errClass, reason, detail, tags) {
  const key = errClass + '|' + reason;
  const n = (logSeen[key] = (logSeen[key] || 0) + 1);
  if (n > LOG_CAP) return;
  const t = tags || {};
  const tail = n === LOG_CAP
    ? ` — this VU hit the ${LOG_CAP}-line cap for this class; silent from now on (counts in metrics, per-request detail in result.csv)`
    : '';
  // name = which API (must be distinguishable when the six E2E endpoints run mixed);
  // __VU maps to the "per-VU rate limit" accounting (0 during setup phase)
  console.warn(`✗ [${errClass}/${reason}] ${t.name || 'NA'} vu=${__VU} row=${t.row || 'NA'} phase=${t.runPhase || 'NA'} ${detail}${tail}`);
}

/**
 * Generic classification engine. **The shared layer knows no specific API** —
 * technical failures and JSON parsing are identical for every API and are
 * handled here; business semantics are injected via the spec callbacks,
 * with the contract staying in each step file (one file per API). Dozens of
 * single-endpoint scenarios go through this one entry point; adding an API
 * does not touch this file.
 *
 * Branch order IS classification priority (technical → not-json → business
 * → shape) — do not reorder.
 *
 * @param {Object} res   k6 Response
 * @param {Object} tags  low-cardinality tags, attached to all metrics
 * @param {Object} [spec] the API's response contract:
 *   spec.business (body) => null | {reason, detail}
 *                 Business-rejection check (called after HTTP 200 and valid
 *                 JSON). Omitted = the endpoint has no confirmed business
 *                 rejection shape (current state of the read endpoints).
 *   spec.shape    (body) => null | problem description
 *                 Structural validation (called after business passes).
 *                 Structure mismatches (wrong column name guess, bad id
 *                 format) are **script-side** problems → script class.
 * @returns {{errClass, detail, reason, body}}  body is non-null only after successful JSON parse
 */
export function classifyResponse(res, tags, spec) {
  const s = spec || {};
  const t = tags || {};

  // ── Class 1: technical failure ──
  // res.status === 0 means the connection layer failed outright
  // (timeout / refused / DNS) — res.body is null then, so this must be
  // caught first.
  if (res.status !== 200) {
    const reason = techReason(res);
    const detail = `technical: HTTP ${res.status}${res.error ? ' ' + res.error : ''}`;
    recordOutcome(ERR.TECHNICAL, t, res, reason);
    logFailure(ERR.TECHNICAL, reason, detail, t);
    return { errClass: ERR.TECHNICAL, detail, reason, body: null };
  }

  // ── Class 3: response is not JSON ──
  let body;
  try {
    body = res.json();
  } catch (e) {
    const detail = `script: response is not JSON — ${e.message}`;
    recordOutcome(ERR.SCRIPT, t, res, 'not-json');
    logFailure(ERR.SCRIPT, 'not-json', detail, t);
    return { errClass: ERR.SCRIPT, detail, reason: 'not-json', body: null };
  }

  // ── Class 2: business rejection (contract-injected) ──
  if (s.business) {
    const rej = s.business(body);
    if (rej) {
      recordOutcome(ERR.BUSINESS, t, res, rej.reason);
      logFailure(ERR.BUSINESS, rej.reason, rej.detail, t);
      return { errClass: ERR.BUSINESS, detail: rej.detail, reason: rej.reason, body };
    }
  }

  // ── Structural integrity (contract-injected) ──
  if (s.shape) {
    const problem = s.shape(body);
    if (problem) {
      const detail = `script: ${problem}`;
      recordOutcome(ERR.SCRIPT, t, res, 'shape');
      logFailure(ERR.SCRIPT, 'shape', detail, t);
      return { errClass: ERR.SCRIPT, detail, reason: 'shape', body };
    }
  }

  recordOutcome(ERR.OK, t, res);
  return { errClass: ERR.OK, detail: 'ok', reason: '', body };
}

/**
 * Record one request's classification into all metrics. **The single
 * bookkeeping exit for every step** — new steps must not new up their own
 * Counters and re-implement the three-way separation; call this.
 *
 * @param {string} [reason] failure reason (bounded values, see the reason
 *                 section above). Attached only to the error counters —
 *                 success has no "reason", and Rate/Trend don't need that
 *                 dimension.
 */
export function recordOutcome(errClass, tags, res, reason) {
  const t = Object.assign({}, tags, { errClass });
  if (reason && errClass !== ERR.OK) t.reason = reason;
  const ok = errClass === ERR.OK;

  if (ok) cOk.add(1, t);
  else if (errClass === ERR.TECHNICAL) cTechnical.add(1, t);
  else if (errClass === ERR.BUSINESS) cBusiness.add(1, t);
  else cScript.add(1, t);

  rBusinessSuccess.add(ok, tags);
  if (ok) tSuccessDuration.add(res.timings.duration, tags);
}

/**
 * Shorthand for read-only JSON endpoints (trades-list / trade-detail /
 * refdata lists): these have no confirmed "business rejection" shape (read
 * endpoints expose no assertable business status like PENDING APPROVAL),
 * so the contract is structural validation only. The day a read endpoint's
 * business error-code shape is confirmed, callers switch to
 * classifyResponse with spec.business directly.
 */
export function classifyRead(res, tags, validate) {
  return classifyResponse(res, tags, { shape: validate });
}
