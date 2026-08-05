#!/usr/bin/env bash
#
# run.sh — local runner (modeled on the runner design of the internal
#          trade-performance framework; runs directly on Linux/macOS,
#          Windows runs the same script via Git Bash)
#
#   ./run.sh <scenario>[.js] [env] [profile] [KEY=value ...]
#
#   scenario   scenario name under src/scenarios/ (.js suffix optional)
#   env        environment name under config/environments/, default local
#   profile    load profile under profiles/, default smoke
#   KEY=value  __ENV overrides, passed through verbatim as k6 -e (no -e prefix), e.g.:
#              VUS=2 RATE=30 DURATION=600s MAX_VUS=50 PRODUCT=FX_TRF CREATE_DATA_FILE=...
#
# Examples:
#   ./run.sh trades-create.js dev smoke
#   ./run.sh trades-query                        # defaults to local + smoke
#   ./run.sh trades-create local baseline VUS=1 DURATION=600s
#
# Per-HTTP-message debugging (smoke-level verification only; messages go to k6.log
# only, no terminal spam; full dumps the entire .dat binary into the log — delete
# k6.log when done):
#   K6_HTTP_DEBUG=headers ./run.sh trades-query
#   K6_HTTP_DEBUG=full ./run.sh trades-create local smoke RATE=1 DURATION=5s MAX_VUS=1
set -euo pipefail
K6_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$K6_ROOT"

# ── UTC across the whole chain ───────────────────────────────
# Server logs are UTC, and one of the main values of k6.log/manifest is
# reconciling them against server-side logs — local +08:00 vs UTC would mean
# mental timezone math on every troubleshooting session. TZ is inherited by the
# k6 child process (k6 is Go; every platform honors TZ), and the runId and daily
# results directory produced by date below are UTC as well.
export TZ=UTC

usage() {
  echo "Usage: $0 <scenario>[.js] [env] [profile] [KEY=value ...]" >&2
  echo "" >&2
  echo "scenarios: $(ls src/scenarios/*.js 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.js$//' | tr '\n' ' ')" >&2
  echo "seed:      $(ls src/seed/*.js 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.js$//' | tr '\n' ' ')" >&2
  echo "envs:      $(ls config/environments/*.json 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.json$//' | tr '\n' ' ')" >&2
  echo "profiles:  $(ls profiles/*.json 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.json$//' | tr '\n' ' ')" >&2
  exit 2
}

[[ $# -lt 1 ]] && usage

SCENARIO="${1%.js}"; shift
ENV_NAME="local" PROFILE="smoke" POS=0
RAW_OVERRIDES=()
for a in "$@"; do
  if [[ "$a" == *=* || "$a" == "-e" ]]; then
    RAW_OVERRIDES+=("$a")
  else
    POS=$((POS + 1))
    if [[ "$POS" == 1 ]]; then ENV_NAME="$a"; else PROFILE="$a"; fi
  fi
done

# ── Pre-validate overrides: catch typos before k6 starts, not after a wasted run ──
OVERRIDE_ARGS=()
for o in ${RAW_OVERRIDES[@]+"${RAW_OVERRIDES[@]}"}; do
  [[ -z "$o" || "$o" == "-e" ]] && continue          # silently ignore any stray bare -e
  if [[ ! "$o" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
    echo "ERROR: malformed override: '$o' (expected KEY=value, no -e prefix, e.g. VUS=8)" >&2
    exit 1
  fi
  OVERRIDE_ARGS+=(-e "$o")
done

# Entry lookup order: measurement scenarios first, then seed producers (spec §10.1)
SCENARIO_FILE=""
IS_SEED=0
for dir in src/scenarios src/seed; do
  if [[ -f "$dir/${SCENARIO}.js" ]]; then SCENARIO_FILE="$dir/${SCENARIO}.js"; break; fi
done
[[ "$SCENARIO_FILE" == src/seed/* ]] && IS_SEED=1
ENV_FILE="config/environments/${ENV_NAME}.json"
PROFILE_FILE="profiles/${PROFILE}.json"
[[ -n "$SCENARIO_FILE" ]] || { echo "ERROR: scenario not found: ${SCENARIO} (looked in src/scenarios/ and src/seed/)" >&2; usage; }
[[ -f "$ENV_FILE" ]] || { echo "ERROR: environment not found: ${ENV_NAME} (${ENV_FILE}) — argument order is <scenario> <env> <profile>" >&2; usage; }
[[ -f "$PROFILE_FILE" ]] || { echo "ERROR: profile not found: ${PROFILE} (${PROFILE_FILE}) — argument order is <scenario> <env> <profile>" >&2; usage; }

command -v k6 >/dev/null 2>&1 || {
  echo "ERROR: k6 not in PATH" >&2
  echo "  macOS:   brew install k6" >&2
  echo "  Windows: winget install k6 --source winget" >&2
  echo "  Linux:   https://grafana.com/docs/k6/latest/set-up/install-k6/" >&2
  exit 2
}
# ── Read one flat scalar from config/<env>.json ──
# ⚠ Deliberately NOT a JSON parser: bash has no built-in parsing, and jq/python/node
#   cannot be assumed to exist on the load generator. Handles exactly one shape —
#   a `"key": value` pair on a line of its own (strips quotes and trailing comma) —
#   so any key read this way must be unique within the file. All structured parsing
#   lives on the k6 side (lib/config.js).
cfg_get() {
  sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\(.*\)$/\1/p" "$ENV_FILE" \
    | head -1 | sed 's/,[[:space:]]*$//; s/^"//; s/"$//'
}

# Environment-level addresses: the config file is authoritative; env vars are one-off
# overrides (editing the file risks an accidental commit, an override does not)
PROM_URL="${K6_PROMETHEUS_RW_SERVER_URL:-$(cfg_get promRwUrl)}"
GRAFANA_URL="${GRAFANA_DASHBOARD_URL:-$(cfg_get grafanaDashboard)}"

# ── Results directory: results/<UTC day>/<runId>/ ────────────
# Take the timestamp exactly once and derive the day directory from it — taking it
# twice could straddle midnight and land in the wrong day; the runId embeds the
# date, so a directory copied elsewhere can still explain when it ran.
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DAY="${STAMP%%-*}"
RUN_ID="${SCENARIO}_${ENV_NAME}_${PROFILE}_${STAMP}"
RUN_DIR="results/${RUN_DAY}/${RUN_ID}"
mkdir -p "$RUN_DIR"

# ── run manifest ─────────────────────────────────────────────
# The "change one variable at a time" discipline only holds if it can be verified
# after the fact — without a manifest, load-test results from three months ago are
# just a pile of unexplainable numbers.
MANIFEST="$RUN_DIR/manifest.txt"
{
  echo "runId:        $RUN_ID"
  echo "timestamp:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "epochMillis:  $(( $(date +%s) * 1000 ))    # ← paste into the Grafana URL's &from="
  echo "scenario:     $SCENARIO_FILE"
  echo "env:          $ENV_FILE"
  echo "profile:      $PROFILE_FILE"
  echo "overrides:    ${RAW_OVERRIDES[*]:-<none>}"
  echo "grafana:      ${GRAFANA_URL:-<none>}"
  echo "prometheus:   ${PROM_URL:-<none>}"
  echo "host:         $(hostname)"
  echo "user:         $(whoami)"
  echo "k6:           $(k6 version 2>&1 | head -1 || echo unknown)"
  if git -C "$K6_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    echo "scriptCommit: $(git -C "$K6_ROOT" rev-parse --short HEAD)"
    echo "scriptDirty:  $(git -C "$K6_ROOT" status --porcelain | wc -l | tr -d ' ') file(s)"
  fi
  echo ""
  echo "--- $ENV_FILE ---";     cat "$ENV_FILE"
  echo "--- $PROFILE_FILE ---"; cat "$PROFILE_FILE"
} > "$MANIFEST"

echo "▶ scenario $SCENARIO_FILE"
echo "▶ env      $ENV_FILE"
echo "▶ profile  $PROFILE_FILE"
[[ "${#RAW_OVERRIDES[@]}" -gt 0 ]] && echo "▶ override ${RAW_OVERRIDES[*]}"
echo "▶ results  $RUN_DIR"
echo ""

# ── Output channels ──────────────────────────────────────────
# result.csv = per-request detail (with all tags); any per-request digging beyond
# the three-class counts relies on it
OUT_ARGS=(--out "csv=$RUN_DIR/result.csv")

if [[ -n "$PROM_URL" ]]; then
  OUT_ARGS+=(--out experimental-prometheus-rw)
  export K6_PROMETHEUS_RW_SERVER_URL="$PROM_URL"
  # By default only p(99) is pushed; the quantile dropdown in official dashboard
  # 19665 enumerates the series suffixes that actually exist, so whatever we push
  # here becomes selectable there (p50 is the denominator of the P95/P50 ratio
  # diagnostic). An explicit setting still takes precedence.
  export K6_PROMETHEUS_RW_TREND_STATS="${K6_PROMETHEUS_RW_TREND_STATS:-p(50),p(95),p(99),min,max,avg}"
  # Mark series stale the moment the run ends — otherwise tail values keep drifting
  # for ~5 more minutes in from->now queries, one of the classic sources of
  # "Grafana doesn't match the summary".
  export K6_PROMETHEUS_RW_STALE_MARKERS="${K6_PROMETHEUS_RW_STALE_MARKERS:-true}"
  echo "▶ prometheus  $PROM_URL  (trend stats: $K6_PROMETHEUS_RW_TREND_STATS)"
  echo ""
fi

# ── k6 built-in web dashboard (k6 ≥ v0.49) ─────────────────
# Watch live curves at http://127.0.0.1:5665 while running; a self-contained HTML
# is exported on finish — until Prometheus is wired up, this is the only
# time-series view. ⚠ Never use it to decide pass/fail: its error rate is
# http_req_failed (HTTP layer), and this system returns 200 even on business
# failures — the three-class breakdown in the summary is the authority. A second
# parallel instance collides on the port: switch with K6_WEB_DASHBOARD_PORT=5666,
# or disable with K6_WEB_DASHBOARD=false. k6 skipping the export on very short
# runs is normal.
if [[ "${K6_WEB_DASHBOARD:-true}" != "false" ]]; then
  export K6_WEB_DASHBOARD=true
  export K6_WEB_DASHBOARD_EXPORT="$RUN_DIR/dashboard.html"
  echo "▶ dashboard  http://127.0.0.1:${K6_WEB_DASHBOARD_PORT:-5665} → exports $RUN_DIR/dashboard.html"
  echo ""
fi

# Per-message debugging passes straight through k6's native K6_HTTP_DEBUG; the
# runner does no translation. When enabled, k6's native K6_LOG_OUTPUT writes the
# log stream (message dumps included) directly to k6.log — messages easily run
# hundreds of KB and terminal spam is unreadable; the terminal keeps only
# progress and the text summary.
if [[ -n "${K6_HTTP_DEBUG:-}" ]]; then
  export K6_LOG_OUTPUT="${K6_LOG_OUTPUT:-file=$RUN_DIR/k6.log}"
  echo "⚠ K6_HTTP_DEBUG=${K6_HTTP_DEBUG} — every HTTP message is written to ${K6_LOG_OUTPUT#file=} (not the terminal); smoke-level verification only;"
  echo "  messages contain real business data, and full also dumps the entire .dat binary — delete this log when done."
  echo ""
fi

K6_ARGS=(run
  --tag "testid=$RUN_ID"
  -e ENV="$ENV_NAME"
  -e PROFILE="$PROFILE"
  -e TESTID="$RUN_ID"
  -e SCENARIO="$SCENARIO"
  -e RESULT_DIR="$RUN_DIR")
K6_ARGS+=(${OVERRIDE_ARGS[@]+"${OVERRIDE_ARGS[@]}"})
K6_ARGS+=("${OUT_ARGS[@]}" "$SCENARIO_FILE")

set +e
if [[ -n "${K6_HTTP_DEBUG:-}" ]]; then
  # k6 already writes k6.log directly (K6_LOG_OUTPUT), so no tee — two writers
  # on the same file would trample each other
  k6 "${K6_ARGS[@]}"
  K6_RC=$?
else
  k6 "${K6_ARGS[@]}" 2>&1 | tee "$RUN_DIR/k6.log"
  K6_RC=${PIPESTATUS[0]}
fi
set -e

# End timestamp — pairs with epochMillis for pasting into Grafana's &from= &to=
echo "endEpochMillis: $(( $(date +%s) * 1000 ))" >> "$MANIFEST"

# ── Verdict: summary.json/summary.txt are written to disk directly by k6's
#    handleSummary (including the synthetic failure entry that guards against a
#    zero-request false green, see src/lib/report.js); the runner only extracts
#    the verdict field. Missing files = handleSummary never ran, which almost
#    always means an init-stage error (a preflight abort still produces them and
#    verdicts FAIL).
VERDICT="FAIL(no-summary)"
if [[ -f "$RUN_DIR/summary.json" ]]; then
  VERDICT="$(sed -n 's/^[[:space:]]*"verdict": *"\([A-Z]*\)".*/\1/p' "$RUN_DIR/summary.json" | head -1)"
  [[ -z "$VERDICT" ]] && VERDICT="FAIL(bad-summary)"
else
  echo "⚠ summary.json was not generated (k6 never reached handleSummary, usually an init-stage error — check the top of k6.log)" >&2
fi

echo ""
# ⚠ The braces in ${VERDICT} are mandatory: bash 3.2 under the C locale, while
#   parsing a variable name, wrongly merges the bytes of an immediately following
#   multibyte character (e.g. a full-width parenthesis) into the name, raising
#   unbound variable
echo "── Result (${VERDICT}) ────────────────────────────────"
[[ -f "$RUN_DIR/summary.txt" ]] && echo "summary:   $RUN_DIR/summary.txt   ← three-class / dual-latency text summary (same as terminal), the verdict authority"
[[ -f "$RUN_DIR/summary.json" ]] && echo "raw:       $RUN_DIR/summary.json  ← machine-readable (verdict / baseline-comparison input)"
[[ -f "$RUN_DIR/dashboard.html" ]] && echo "dashboard: $RUN_DIR/dashboard.html ← time-series curves (not used for the verdict)"
[[ -f "$RUN_DIR/report.html" ]] && echo "report:    $RUN_DIR/report.html    ← single-file share-out for business/leadership (exact caliber, presentation only)"
# ── Seed harvest: collect SEEDID lines (emitted by src/seed/ scenarios, captured in k6.log
#    via the tee above / K6_LOG_OUTPUT in debug mode) into a ready-to-activate pool file.
#    Deliberately NOT copied into data/ automatically — overwriting a pool is a human decision.
if [[ "$IS_SEED" == 1 && -f "$RUN_DIR/k6.log" ]]; then
  POOL_FILE="$RUN_DIR/seed-pool.json"
  {
    echo '{'
    echo '  "_comment": "Harvested by run.sh from SEEDID lines. Activate: cp this file over data/worker-svc/trade/update-ids.json (from seed-update-pool) or approve-tasks.json (from seed-approve-pool). Pools are single-use — re-seed after each measurement round.",'
    echo '  "ids": ['
    sed -n 's/.*SEEDID \([A-Za-z0-9-]\{1,\}\).*/    "\1",/p' "$RUN_DIR/k6.log" | sed '$ s/,$//'
    echo '  ]'
    echo '}'
  } > "$POOL_FILE"
  SEED_N=$(sed -n 's/.*SEEDID .*/x/p' "$RUN_DIR/k6.log" | wc -l | tr -d ' ')
  echo "seed pool: $POOL_FILE   ← $SEED_N ids harvested"
  echo "  activate: cp $POOL_FILE data/worker-svc/trade/<update-ids|approve-tasks>.json"
fi
echo "csv:       $RUN_DIR/result.csv"
echo "k6 log:    $RUN_DIR/k6.log"
echo "manifest:  $MANIFEST"
echo ""
if [[ -n "$GRAFANA_URL" ]]; then
  sep='?'; [[ "$GRAFANA_URL" == *\?* ]] && sep='&'
  START_MS=$(grep -oE 'epochMillis: *[0-9]+' "$MANIFEST" | head -1 | grep -oE '[0-9]+')
  END_MS=$(grep -oE 'endEpochMillis: *[0-9]+' "$MANIFEST" | grep -oE '[0-9]+')
  echo "Grafana:   ${GRAFANA_URL}${sep}from=${START_MS}&to=${END_MS}&var-testid=${RUN_ID}"
else
  echo "Grafana time range (replace from=now-1h&to=now in the URL):"
  grep -E 'epochMillis' "$MANIFEST" | sed 's/^/  /'
  echo "  For a ready-made link: set grafanaDashboard in $ENV_FILE (or a one-off export GRAFANA_DASHBOARD_URL)"
fi

# ── Baseline promotion hint: when this combination has no baseline yet and this
#    run PASSed, print a ready-to-run command ──
# The comparison itself happens on the k6 side (the Baseline comparison section of
# the summary, see src/lib/report.js); promotion is a human decision — is the
# sample size sufficient (see the summary's Sample size section), and is this run
# representative.
BASELINE_FILE="baselines/${SCENARIO}_${ENV_NAME}_${PROFILE}.json"
if [[ ! -f "$BASELINE_FILE" && "$VERDICT" == "PASS" ]]; then
  echo ""
  echo "Baseline: <${SCENARIO} × ${ENV_NAME} × ${PROFILE}> has no baseline yet; regression comparison is disabled. This run can be promoted:"
  echo "  cp $RUN_DIR/summary.json $BASELINE_FILE"
fi

if grep -q 'PREFLIGHT FAILED' "$RUN_DIR/k6.log" 2>/dev/null; then
  echo ""
  echo "⚠ PREFLIGHT FAILED — the case pool failed local validation (placeholders / missing fields / empty pool); not a single request was sent."
  grep 'PREFLIGHT' "$RUN_DIR/k6.log" | tail -5
  echo "  Fill in the data first: see data/worker-svc/trade/README.md"
fi

# Exit code: a nonzero k6 exit (threshold abort / interruption / script error) wins;
# k6 exiting zero with a FAIL verdict (e.g. 0 samples) is also nonzero
if [[ "$K6_RC" -ne 0 ]]; then exit "$K6_RC"; fi
[[ "$VERDICT" == PASS ]] || exit 1
exit 0
