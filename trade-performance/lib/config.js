/*
 * lib/config.js — merge point of three orthogonal dimensions
 *
 *   Dimension 1  plan     scenarios/*.js          "what to test"
 *   Dimension 2  env      config/<ENV>.json       "which environment"   -e ENV=dev
 *   Dimension 3  load     profiles/<PROFILE>.json "how much pressure"   -e PROFILE=baseline
 *   CLI overrides          -e VUS=8 -e DURATION=180s                    highest priority
 *
 * ⚠ This file can only be evaluated in the init context — open() is init-only.
 *   Module top level IS the init context, so this is fine; but do **not**
 *   import anything beyond this from inside the default function.
 *
 * ⚠ open()'s relative paths resolve against **this file's directory** (lib/),
 *   not the current working directory. So run.sh does not need to cd for paths
 *   (it still does cd — see run.sh for why).
 */

const ENV_NAME = __ENV.ENV || 'dev';
const PROFILE_NAME = __ENV.PROFILE || 'smoke';

const envCfg = JSON.parse(open(`../config/${ENV_NAME}.json`));
const profileCfg = JSON.parse(open(`../profiles/${PROFILE_NAME}.json`));

/** CLI -e overrides: only keys explicitly given are overridden; others keep the config-file value */
function pick(envKey, fallback) {
  const v = __ENV[envKey];
  return v === undefined || v === '' ? fallback : v;
}

function pickInt(envKey, fallback) {
  const v = __ENV[envKey];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  if (isNaN(n)) throw new Error(`-e ${envKey}=${v} is not an integer`);
  return n;
}

// ── Service addressing ────────────────────────────────────────
// Deliberately keeps the "each service addressed individually" structure
// (5 svc entries in config/*.json). No global host: a request that forgets
// to specify its service fails outright instead of silently hitting the
// wrong service.
const svc = envCfg.services;

function baseUrl(name) {
  const s = svc[name];
  if (!s) throw new Error(`config/${ENV_NAME}.json has no service '${name}'`);
  return `${s.protocol}://${s.host}:${s.port}${s.basePath}`;
}

/*
 * JSON has no comments, yet these configs **must** be able to explain "why
 * this value" — convention: keys starting with an underscore are comments,
 * stripped before anything reaches k6.
 *
 * ⚠ This step cannot be skipped: k6 treats every key under thresholds as a
 *   **metric name**; leaving a "_comment" in there fails immediately with
 *   "threshold for a non-existent metric".
 */
function stripComments(obj) {
  const out = {};
  Object.keys(obj || {}).forEach((k) => {
    if (!k.startsWith('_')) out[k] = obj[k];
  });
  return out;
}

// ── Load model ────────────────────────────────────────────────
// The scenario in a profile IS the k6 executor config — no second translation
// layer, so profiles/*.json read exactly like the k6 docs with no
// intermediate layer to maintain.
const scenario = stripComments(profileCfg.scenario);

// Common dimensions allow CLI overrides (only these change during step-up load runs)
if (__ENV.VUS !== undefined && scenario.vus !== undefined) scenario.vus = pickInt('VUS', scenario.vus);
if (__ENV.DURATION !== undefined && scenario.duration !== undefined) scenario.duration = pick('DURATION', scenario.duration);
if (__ENV.RATE !== undefined && scenario.rate !== undefined) scenario.rate = pickInt('RATE', scenario.rate);
if (__ENV.ITERATIONS !== undefined && scenario.iterations !== undefined) scenario.iterations = pickInt('ITERATIONS', scenario.iterations);

export const cfg = {
  envName: ENV_NAME,
  profileName: PROFILE_NAME,

  baseUrl,
  workersUrl: baseUrl('workers'),

  // Identity: fixed maker / checker, no rotation. Rationale in config/dev.json and NFR SEC-02.
  makerUserId: pick('MAKER_USER_ID', envCfg.identity.makerUserId),
  checkerUserId: pick('CHECKER_USER_ID', envCfg.identity.checkerUserId),


  requestTimeout: pick('REQUEST_TIMEOUT', envCfg.timeouts.request),

  // abort | warn (prune not implemented)
  preflightPolicy: pick('PREFLIGHT_POLICY', envCfg.preflightPolicy || 'warn'),

  scenario,
  thresholds: stripComments(profileCfg.thresholds),
  profileDescription: profileCfg.description || '',
};
