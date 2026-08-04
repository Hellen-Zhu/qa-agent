// k6 scenario assembly layer: centralizes init-phase config loading and options/handleSummary
// assembly, so scenario files contain nothing but business orchestration (meta + data + one
// business action).
// This module uses k6 runtime globals (open()/__ENV) and can only be loaded by k6 —
// the pure-logic modules (config.js/sla.js/report.js/rows.js) stay Node-loadable; do not mix
// up the responsibilities.
// All open() paths are anchored to this file via import.meta.resolve().
import { parseEnvConfig } from './config.js';
import { buildThresholds } from './sla.js';
import { summarize, buildTextSummary, compareBaseline } from './report.js';
import { htmlReport } from '../vendor/k6-reporter.js';

export const ENV = __ENV.ENV || 'local';
export const PROFILE = __ENV.PROFILE || 'smoke';
export const TESTID = __ENV.TESTID || 'local-run';
// Passed in by the runner (run.sh -e SCENARIO); a bare k6 run has no value → baseline comparison is skipped
const SCENARIO = __ENV.SCENARIO || '';

// ── Baseline loading: baselines/<scenario>_<env>_<profile>.json ─────
// A baseline is just the summary.json promoted from some trusted run (spec §9). The composite
// key includes env+profile — comparisons across environments or load profiles are meaningless.
// Having no baseline is the normal case (open throws → null, silently skipped); a file that
// exists but is corrupt fails loudly (JSON.parse throws, init errors out and refuses to run) —
// a bad baseline must never silently degrade.
function loadBaseline() {
  if (!SCENARIO) return null;
  let raw = null;
  try {
    raw = open(import.meta.resolve(`../../baselines/${SCENARIO}_${ENV}_${PROFILE}.json`));
  } catch (_) {
    return null;
  }
  return JSON.parse(raw);
}
const BASELINE = loadBaseline();

const HARD_MAX_VUS = 500;

// Each k6 run has exactly one environment: cfg is loaded once in the init phase and scenarios
// import it directly.
// baseUrl is not exported here — scenarios never touch URLs; service addresses are resolved by
// the api layer via serviceBaseUrl(cfg, svc).
export const cfg = parseEnvConfig(open(import.meta.resolve(`../../config/environments/${ENV}.json`)));

// data/<path>.json data files (callable only in the init phase — open() is unavailable in the VU phase)
export function loadData(path) {
  return JSON.parse(open(import.meta.resolve(`../../data/${path}.json`)));
}

/** JSON has no comment syntax; by convention keys starting with _ are comments and must be
 *  stripped before reaching k6 — k6 treats every key under thresholds as a metric name, so a
 *  leftover _comment errors out immediately */
export function stripComments(obj) {
  const out = {};
  Object.keys(obj || {}).forEach((k) => {
    if (!k.startsWith('_')) out[k] = obj[k];
  });
  return out;
}

function intEnv(key) {
  const v = __ENV[key];
  if (v === undefined || v === '') return undefined;
  const n = parseInt(v, 10);
  if (isNaN(n)) throw new Error(`-e ${key}=${v} is not an integer`);
  return n;
}

// Overrides apply only to same-named scalar keys that already exist in the profile scenario
// (stages literals are unaffected by overrides; see each profile's _override comment); maxVUs
// enforces a global hard cap, keeping a misconfiguration from knocking over a shared environment
function applyOverrides(sc) {
  const rate = intEnv('RATE');
  const vus = intEnv('VUS');
  const maxVUs = intEnv('MAX_VUS');
  if (sc.rate !== undefined && rate !== undefined) sc.rate = rate;
  if (sc.vus !== undefined && vus !== undefined) sc.vus = vus;
  if (sc.duration !== undefined && __ENV.DURATION) sc.duration = __ENV.DURATION;
  if (sc.maxVUs !== undefined && maxVUs !== undefined) sc.maxVUs = maxVUs;
  if (sc.maxVUs !== undefined) sc.maxVUs = Math.min(sc.maxVUs, HARD_MAX_VUS);
  return sc;
}

/*
 * Standard options assembly. Thresholds are stacked in three layers (spec §4/§7):
 *   1. Bottom line (must hold under any profile): perf_err_script count==0 — a script error
 *      voids this run
 *   2. Profile level (the thresholds block of profiles/<name>.json): the two-tier business
 *      success-rate lines — verdict and abort threshold (breaker)
 *   3. API level (config/slas/): perf_success_duration percentile SLAs — exploratory profiles
 *      (where the knee / collapse shape is itself the measurement target) may exempt this layer
 *      with top-level "apiSla": false; slaKey existence is still enforced (a misconfigured key
 *      must fail fast, not be masked by the exemption)
 *   4. extra: scenario-specific additions (e.g. query's empty-DB guard)
 */
export function buildOptions(slaFile, slaKey, extraThresholds) {
  const profile = JSON.parse(open(import.meta.resolve(`../../profiles/${PROFILE}.json`)));
  const scenario = applyOverrides(stripComments(profile.scenario));
  const sla = JSON.parse(open(import.meta.resolve(`../../config/slas/${slaFile}.json`)));
  const entry = sla[slaKey];
  if (!entry) throw new Error(`unknown SLA key: ${slaKey} in ${slaFile}`);
  const apiSla = profile.apiSla !== false;
  return {
    scenarios: { main: scenario },
    thresholds: Object.assign(
      { perf_err_script: ['count==0'] },
      stripComments(profile.thresholds || {}),
      apiSla ? buildThresholds(entry) : {},
      extraThresholds || {},
    ),
    // Every text-summary column (P50/P90/P95/P99/max/avg + sample count) needs a value; any stat missing here leaves its column empty
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  };
}

// Standard handleSummary (once exported, k6 no longer prints its default summary; this function
// owns all output):
//   stdout text summary; when RESULT_DIR (passed in by the runner) is non-empty, k6 writes
//   summary.txt (same text) + summary.json (machine-readable; the runner extracts verdict to
//   set the exit code) directly to disk.
// A bare `k6 run` passes no RESULT_DIR and prints to the terminal only — same behavior as
// trade-performance.
// Scenarios reuse it via `export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js'`.
export function stdHandleSummary(data) {
  const s = summarize(data, TESTID);
  // Baseline comparison: advisory only, never changes the verdict (verdict authority = thresholds; BASELINE_TOL_PCT overrides the latency tolerance)
  let cmp = null;
  if (BASELINE) {
    cmp = compareBaseline(s, BASELINE, parseInt(__ENV.BASELINE_TOL_PCT || '', 10));
    s.baseline = cmp;
  }
  const text = buildTextSummary(data, { testid: TESTID, env: ENV, profile: PROFILE }, cmp);
  const out = { stdout: text };
  const dir = __ENV.RESULT_DIR;
  if (dir) {
    out[`${dir}/summary.txt`] = text;
    out[`${dir}/summary.json`] = JSON.stringify(s, null, 2);
    // Shareable single-file report for business/leadership readers (vendored k6-reporter).
    // Same exact end-of-test caliber as summary.txt; presentation only — verdict authority
    // stays with summary.json. The checks bridge surfaces business success rate in its
    // Checks section; three-class counters appear as custom metrics rows.
    out[`${dir}/report.html`] = htmlReport(data, { title: TESTID });
  }
  return out;
}
