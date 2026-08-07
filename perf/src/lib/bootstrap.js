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
  const iterations = intEnv('ITERATIONS');
  if (sc.rate !== undefined && rate !== undefined) sc.rate = rate;
  if (sc.vus !== undefined && vus !== undefined) sc.vus = vus;
  if (sc.duration !== undefined && __ENV.DURATION) sc.duration = __ENV.DURATION;
  if (sc.iterations !== undefined && iterations !== undefined) sc.iterations = iterations;
  // shared-iterations refuses iterations < vus — shrink vus for small trial seeds (ITERATIONS=5)
  if (sc.iterations !== undefined && sc.vus !== undefined && sc.vus > sc.iterations) sc.vus = sc.iterations;
  if (sc.maxVUs !== undefined && maxVUs !== undefined) sc.maxVUs = maxVUs;
  if (sc.maxVUs !== undefined) sc.maxVUs = Math.min(sc.maxVUs, HARD_MAX_VUS);
  return sc;
}

function durationSeconds(d) {
  let total = 0;
  const re = /(\d+)(h|m|s)/g;
  let m;
  while ((m = re.exec(String(d))) !== null) {
    total += parseInt(m[1], 10) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1);
  }
  return total;
}

/** Planned iteration count for this round — consumable-pool preflights size against it.
 *  ramping-arrival-rate is integrated stage by stage (k6 interpolates the rate linearly from
 *  the previous level to each stage target → trapezoid area; timeUnit assumed 1s, as in every
 *  profile). Returns 0 when the executor's volume is unknowable up front (e.g. ramping-vus):
 *  the volume check is skipped and only the placeholder check applies. */
export function plannedIterations(opts) {
  const sc = opts.scenarios.main;
  if (sc.iterations !== undefined) return sc.iterations;
  if (sc.rate !== undefined && sc.duration) return Math.ceil(sc.rate * durationSeconds(sc.duration));
  if (sc.executor === 'ramping-arrival-rate' && Array.isArray(sc.stages)) {
    let prev = sc.startRate || 0;
    let total = 0;
    for (const st of sc.stages) {
      total += ((prev + st.target) / 2) * durationSeconds(st.duration);
      prev = st.target;
    }
    return Math.ceil(total);
  }
  return 0;
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
  return buildOptionsMulti([[slaFile, slaKey]], extraThresholds);
}

/** Multi-API variant for journey/mixed entries that exercise several endpoints in one run:
 *  slaPairs = [[slaFile, slaKey], ...] — each pair contributes its per-API percentile
 *  thresholds (name-tagged, so they never collide). Key existence is always enforced;
 *  apiSla:false profiles exempt the thresholds for ALL pairs, same as the single-API path. */
export function buildOptionsMulti(slaPairs, extraThresholds) {
  const profile = JSON.parse(open(import.meta.resolve(`../../profiles/${PROFILE}.json`)));
  const scenario = applyOverrides(stripComments(profile.scenario));
  const apiSla = profile.apiSla !== false;
  const slaCache = {};
  const apiThresholds = {};
  for (const [slaFile, slaKey] of slaPairs) {
    if (!slaCache[slaFile]) {
      slaCache[slaFile] = JSON.parse(open(import.meta.resolve(`../../config/slas/${slaFile}.json`)));
    }
    const entry = slaCache[slaFile][slaKey];
    if (!entry) throw new Error(`unknown SLA key: ${slaKey} in ${slaFile}`);
    if (apiSla) Object.assign(apiThresholds, buildThresholds(entry));
  }
  return {
    scenarios: { main: scenario },
    thresholds: Object.assign(
      { perf_err_script: ['count==0'] },
      stripComments(profile.thresholds || {}),
      apiThresholds,
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
