/*
 * lib/errors.js — three-class error engine (k6-side module)
 *
 * In this system business failures also return HTTP 200 (the business status lives in the
 * body's code/status fields), so a report that only looks at status codes would show
 * "0% errors" while in reality not a single transaction succeeded. The three classes must be
 * presented separately:
 *   technical  connect failure/timeout/5xx → the system cannot cope; THIS is the performance conclusion
 *   business   HTTP 200 but business rejection → usually stale test data, not a performance problem
 *   script     response not JSON / shape mismatch → script defect; this run's results are void
 *
 * The engine knows no concrete API: the business contract (success criteria, rejection-attribution
 * pattern table) is injected by the api layer via the spec callbacks. Tags may only take bounded
 * values — reason comes from pattern-table slots + the server-side code enum + HTTP status codes;
 * never use free-text msg or unique values like tradeId as tags.
 */
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

export const cOk = new Counter('perf_ok');
export const cTechnical = new Counter('perf_err_technical');
export const cBusiness = new Counter('perf_err_business');
export const cScript = new Counter('perf_err_script');

// Both the verdict and the abort threshold (breaker) watch this, not http_req_failed
export const rBusinessSuccess = new Rate('perf_business_success');

// Durations of business-successful requests only: fast rejections would drag percentiles down and inflate apparent capacity; the SLA is judged against this
export const tSuccessDuration = new Trend('perf_success_duration', true);

export const ERR = {
  OK: 'ok',
  TECHNICAL: 'technical',
  BUSINESS: 'business',
  SCRIPT: 'script',
};

/** Business-rejection attribution: pattern-table slots → server-side code enum as fallback (both bounded) */
export function reasonFrom(body, patterns) {
  const msg = String((body && body.msg) || '');
  for (let i = 0; i < (patterns || []).length; i++) {
    if (patterns[i].re.test(msg)) return patterns[i].reason;
  }
  const code = body && body.code;
  return typeof code === 'number' ? 'code-' + code : 'code-unknown';
}

export function techReason(res) {
  // status=0 is a connection-layer failure (timeout/refused/DNS); error_code is k6's bounded error enum
  return res.status > 0 ? 'http-' + res.status : 'net-' + (res.error_code || 0);
}

/*
 * Rate-limited on-scene logs: each VU fully prints only the first 3 entries per
 * (errClass, reason) combination — under high concurrency with widespread failures, log I/O
 * must not backfire on the load generator; counts live in the metrics (a per-request detail
 * export mechanism is slated for P1b).
 * Each VU has its own JS VM, so a module-level object is naturally isolated per VU.
 */
const LOG_CAP = 3;
const logSeen = {};

export function logFailure(errClass, reason, detail, tags) {
  const key = errClass + '|' + reason;
  const n = (logSeen[key] = (logSeen[key] || 0) + 1);
  if (n > LOG_CAP) return;
  const t = tags || {};
  const tail = n === LOG_CAP ? ` (reached the ${LOG_CAP}-entry cap for this log class; silent from now on — see metrics for counts)` : '';
  console.warn(`✗ [${errClass}/${reason}] ${t.name || 'NA'} vu=${__VU} row=${t.row || 'NA'} ${detail}${tail}`);
}

/** Single entry point for recording each request's classification outcome: new apis must not build their own Counters replicating the three-class scheme — everything goes through here */
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

  // Bridge to the official dashboard 19665: its Checks panel reads k6_checks_rate, while this
  // framework does not use check() for assertions (the three-class scheme is the verdict
  // authority). Here we merely mirror business success/failure into a single check so that
  // 19665's Checks Success Rate big card directly shows the business success rate — its failed
  // rate is http_req_failed (HTTP layer), and since this system returns 200 even on business
  // failures, without this bridge the official dashboard cannot tell the business-layer story.
  check(ok, { 'business success': (v) => v }, tags);
}

/** Response-body excerpt for on-scene logs: the first troubleshooting clue for technical-class
 *  failures (validation details on a 400, gateway-page signatures on a 503).
 *  Double safeguard of 200-char truncation + LOG_CAP rate limiting so it does not backfire on
 *  the load generator; the trade-off of the body containing real business data is the same as
 *  for business-class msg excerpts (k6.log is already managed as a sensitive artifact). */
function bodySnippet(res) {
  const b = res && res.body ? String(res.body).replace(/\s+/g, ' ').trim() : '';
  return b ? ` body=${b.slice(0, 200)}` : '';
}

/** Generic classification engine. Branch order IS the classification priority (technical → not-json → business → shape); do not reorder */
export function classifyResponse(res, tags, spec) {
  const s = spec || {};
  const t = tags || {};

  if (res.status !== 200) {
    const reason = techReason(res);
    const detail = `technical: HTTP ${res.status}${res.error ? ' ' + res.error : ''}${bodySnippet(res)}`;
    recordOutcome(ERR.TECHNICAL, t, res, reason);
    logFailure(ERR.TECHNICAL, reason, detail, t);
    return { errClass: ERR.TECHNICAL, detail, reason, body: null };
  }

  let body;
  try {
    body = res.json();
  } catch (e) {
    const detail = `script: response is not JSON — ${e.message}${bodySnippet(res)}`;
    recordOutcome(ERR.SCRIPT, t, res, 'not-json');
    logFailure(ERR.SCRIPT, 'not-json', detail, t);
    return { errClass: ERR.SCRIPT, detail, reason: 'not-json', body: null };
  }

  if (s.business) {
    const rej = s.business(body);
    if (rej) {
      recordOutcome(ERR.BUSINESS, t, res, rej.reason);
      logFailure(ERR.BUSINESS, rej.reason, rej.detail, t);
      return { errClass: ERR.BUSINESS, detail: rej.detail, reason: rej.reason, body };
    }
  }

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

/** Shorthand for read-only endpoints: no assertable business-rejection shape yet; the contract is shape validation only (shape mismatch = script class) */
export function classifyRead(res, tags, validate) {
  return classifyResponse(res, tags, { shape: validate });
}
