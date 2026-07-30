#!/usr/bin/env bash
#
# run.sh — the single entry point for the three orthogonal dimensions
#
#   ./run.sh <plan> <env> <profile> [KEY=value ...]
#
#   plan     file name under scenarios/ (without .js)
#   env      file name under config/ (without .json)
#   profile  file name under profiles/ (without .json)
#   KEY=value  overrides, written as-is, **no -e prefix**
#
# Examples:
#   ./run.sh p02-trade-create dev smoke
#   ./run.sh p02-trade-create dev baseline
#   ./run.sh p02-trade-create dev baseline VUS=8 DURATION=300s
#   ./run.sh p02-trade-create dev arrival  RATE=4
#   ./run.sh p02-trade-create dev baseline CREATE_DATA_FILE=data/workers/trade-management/create-trade-lock-variant.json
#
# Print every HTTP message (k6's native K6_HTTP_DEBUG, **smoke-level verification only**):
#   K6_HTTP_DEBUG=headers ./run.sh p02-trade-create dev smoke   # request/response headers only
#   K6_HTTP_DEBUG=full    ./run.sh p02-trade-create dev smoke   # bodies included
# ⚠ Leaving it on during a real load round invalidates the numbers; full dumps the
#   multipart .dat binary wholesale into the log, and messages contain real
#   portfolio/counterparty data — delete this k6.log as soon as you're done with it.
#
# ⚠ Overrides deliberately do NOT use `-e KEY=value`: on the Windows side, in run.ps1
#   PowerShell matches `-e` as a parameter-name prefix and reports "ambiguous parameter".
#   Both sides standardize on bare KEY=value — **the command lines look identical,
#   so notes stay portable**. That's the small price paid for cross-platform consistency.
#
# Send metrics into Prometheus (same timeline as the backend metrics):
#   K6_PROMETHEUS_RW_SERVER_URL=http://<prom>:9090/api/v1/write \
#   ./run.sh p02-trade-create dev baseline
#
# k6's open() resolves relative paths against the **script file**, not the cwd —
# it would run without a cd. We still cd into the project directory so that results/
# lands in a fixed location, and behavior is identical from any cwd.

set -euo pipefail

K6_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$K6_ROOT"

usage() {
    echo "usage: $0 <plan> <env> <profile> [KEY=value ...]" >&2
    echo "" >&2
    echo "plans:    $(ls scenarios/*.js       2>/dev/null | xargs -n1 basename | sed 's/\.js//'   | tr '\n' ' ')" >&2
    echo "envs:     $(ls config/*.json        2>/dev/null | xargs -n1 basename | sed 's/\.json//' | tr '\n' ' ')" >&2
    echo "profiles: $(ls profiles/*.json      2>/dev/null | xargs -n1 basename | sed 's/\.json//' | tr '\n' ' ')" >&2
    exit 1
}

[[ $# -lt 3 ]] && usage

PLAN="$1"; ENV="$2"; PROFILE="$3"; shift 3

# ── Override validation: fail early, don't wait for k6 to start before finding the typo ──
# Kept in sync with run.ps1's validation (same regex, same error wording)
RAW_OVERRIDES=("$@")
OVERRIDE_ARGS=()
for o in "${RAW_OVERRIDES[@]+"${RAW_OVERRIDES[@]}"}"; do
    [[ -z "$o" ]] && continue
    [[ "$o" == "-e" ]] && continue                 # a stray -e slipped in; ignore it
    if [[ ! "$o" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
        echo "ERROR: malformed override: '$o'" >&2
        echo "       expected KEY=value (no -e prefix), e.g. VUS=8" >&2
        exit 1
    fi
    OVERRIDE_ARGS+=(-e "$o")
done

PLAN_FILE="scenarios/$PLAN.js"
ENV_FILE="config/$ENV.json"
PROFILE_FILE="profiles/$PROFILE.json"

[[ -f "$PLAN_FILE"    ]] || { echo "ERROR: plan '$PLAN' not found ($PLAN_FILE)" >&2; usage; }
[[ -f "$ENV_FILE"     ]] || { echo "ERROR: env '$ENV' not found ($ENV_FILE)" >&2; usage; }
[[ -f "$PROFILE_FILE" ]] || { echo "ERROR: profile '$PROFILE' not found ($PROFILE_FILE)" >&2; usage; }

# ── Read one flat scalar out of config/<env>.json ──
# ⚠ Deliberately NOT a JSON parser. bash has none built in, and neither jq nor
#   python3 can be assumed on a load-test box, so this handles exactly what is
#   needed and nothing more: one `"key": value` pair written on its own line,
#   quotes and a trailing comma stripped. Keys read this way must be unique in
#   the file. Anything structural stays on the k6 side, where lib/config.js
#   parses the same file with a real JSON parser.
cfg_get() {
    sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\(.*\)$/\1/p" "$ENV_FILE" \
        | head -1 | sed 's/,[[:space:]]*$//; s/^"//; s/"$//'
}

# Grafana dashboard: the address belongs to the environment, so it lives in
# config/<env>.json -- dev's dashboard is not perf's (var-host alone differs).
# The env var still wins, so a one-off run needs no file edit (an edited file
# gets committed by accident, and manifest's overrides line would not show it).
GRAFANA_URL="${GRAFANA_DASHBOARD_URL:-$(cfg_get grafanaDashboard)}"

command -v k6 >/dev/null 2>&1 || {
    echo "ERROR: k6 not on PATH" >&2
    echo "  macOS:   brew install k6" >&2
    echo "  Windows: winget install k6 --source winget" >&2
    echo "  Linux:   https://grafana.com/docs/k6/latest/set-up/install-k6/" >&2
    exit 2
}

# Stamp is taken ONCE and the day folder is derived from it -- calling date
# twice could straddle midnight and put the run under the wrong day.
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DAY="${STAMP%%-*}"
RUN_ID="${PLAN}_${ENV}_${PROFILE}_${STAMP}"
# One folder per day: results/<YYYYMMDD>/<runId>/. The runId keeps its own
# date on purpose -- a folder copied out of the tree still says when it ran.
RUN_DIR="results/$RUN_DAY/$RUN_ID"
mkdir -p "$RUN_DIR"

# ── run manifest ──
# The "change only one variable per run" discipline only holds if it can be
# verified after the fact. Without a manifest, three months from now a load-test
# result is just a pile of unexplainable numbers.
MANIFEST="$RUN_DIR/manifest.txt"
{
    echo "runId:        $RUN_ID"
    echo "timestamp:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "epochMillis:  $(( $(date +%s) * 1000 ))    # ← paste into the Grafana URL's &from="
    echo "plan:         $PLAN_FILE"
    echo "env:          $ENV_FILE"
    echo "profile:      $PROFILE_FILE"
    echo "overrides:    ${RAW_OVERRIDES[*]:-<none>}"
    echo "grafana:      ${GRAFANA_URL:-<none>}"
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

echo "▶ plan     $PLAN_FILE"
echo "▶ env      $ENV_FILE"
echo "▶ profile  $PROFILE_FILE"
[[ ${#RAW_OVERRIDES[@]} -gt 0 ]] && echo "▶ override ${RAW_OVERRIDES[*]}"
echo "▶ results  $RUN_DIR"
echo ""

# ── Outputs ──
OUT_ARGS=(--out "csv=$RUN_DIR/result.csv")

# Prometheus remote-write: send load metrics into the backend's existing Prometheus,
# so TPS/P95 sit on the same panel and the same timeline as metrics like
# hikaricp_connections_pending.
# ⚠ On some versions the output name is experimental-prometheus-rw; if it errors, try the other one.
if [[ -n "${K6_PROMETHEUS_RW_SERVER_URL:-}" ]]; then
    OUT_ARGS+=(--out "experimental-prometheus-rw")
    # k6's default trend stats for remote write is p(99) ONLY -- the official
    # k6 Prometheus dashboard (grafana.com id 19665) wants p95/min/max/avg too;
    # without them its latency panels sit half empty. Explicit env still wins.
    export K6_PROMETHEUS_RW_TREND_STATS="${K6_PROMETHEUS_RW_TREND_STATS:-p(95),p(99),min,max,avg}"
    # Mark series stale when the test ends. Without this, the last values
    # linger for ~5 minutes in from->now queries after the run -- one of the
    # classic "Grafana disagrees with summary.txt" causes.
    export K6_PROMETHEUS_RW_STALE_MARKERS="${K6_PROMETHEUS_RW_STALE_MARKERS:-true}"
    echo "▶ prometheus  $K6_PROMETHEUS_RW_SERVER_URL  (trend stats: $K6_PROMETHEUS_RW_TREND_STATS)"
    echo ""
fi

# ── k6 web dashboard (built into k6 ≥ v0.49; "unknown environment variable" means upgrade k6) ──
# Live curves at http://127.0.0.1:5665 during the run, self-contained HTML export after —
# until Prometheus remote-write is approved, this is the only time-series view.
# ⚠ Do not use it for pass/fail: the dashboard's error rate is http_req_failed (HTTP layer),
#   and in this project business failures still return HTTP 200 — the three error
#   categories in summary.txt are authoritative.
# On by default. A second parallel instance collides on the port: K6_WEB_DASHBOARD_PORT=5666
# to change it, or K6_WEB_DASHBOARD=false to turn it off entirely.
# ⚠ For very short runs k6 skips the export ("report generation was skipped, not enough
#   data"; the aggregation bucket defaults to 10s) — no report.html for smoke is normal,
#   only real rounds get one.
if [[ "${K6_WEB_DASHBOARD:-true}" != "false" ]]; then
    export K6_WEB_DASHBOARD=true
    export K6_WEB_DASHBOARD_EXPORT="$RUN_DIR/report.html"
    echo "▶ dashboard  http://127.0.0.1:${K6_WEB_DASHBOARD_PORT:-5665} → exports $RUN_DIR/report.html"
    echo ""
fi

# Per-message debugging is passed straight through via k6's native K6_HTTP_DEBUG
# environment variable (same convention as K6_WEB_DASHBOARD /
# K6_PROMETHEUS_RW_SERVER_URL); the runner does no translation.
if [[ -n "${K6_HTTP_DEBUG:-}" ]]; then
    echo "⚠ K6_HTTP_DEBUG=$K6_HTTP_DEBUG — printing every HTTP message, smoke-level verification only;"
    echo "  messages contain real refdata, and full also dumps .dat binaries — delete this k6.log when done."
    echo ""
fi

set +e
RESULT_DIR="$RUN_DIR" k6 run \
    -e ENV="$ENV" \
    -e PROFILE="$PROFILE" \
    -e RESULT_DIR="$RUN_DIR" \
    "${OVERRIDE_ARGS[@]+"${OVERRIDE_ARGS[@]}"}" \
    "${OUT_ARGS[@]}" \
    --tag "testid=$RUN_ID" \
    --summary-trend-stats "avg,min,med,p(90),p(95),p(99),max,count" \
    "$PLAN_FILE" 2>&1 | tee "$RUN_DIR/k6.log"
K6_RC=${PIPESTATUS[0]}
set -e

# End timestamp — pairs with epochMillis for pasting into Grafana's &from= &to=
echo "endEpochMillis: $(( $(date +%s) * 1000 ))" >> "$MANIFEST"

echo ""
echo "── Results ──────────────────────────────────────────"
echo "summary:  $RUN_DIR/summary.txt"
echo "raw:      $RUN_DIR/summary.json"
echo "csv:      $RUN_DIR/result.csv"
[[ -f "$RUN_DIR/report.html" ]] && echo "report:   $RUN_DIR/report.html   ← time-series curves (summary is authoritative for pass/fail)"
echo "manifest: $MANIFEST"
echo ""
if [[ -n "$GRAFANA_URL" ]]; then
    sep='?'; [[ "$GRAFANA_URL" == *\?* ]] && sep='&'
    START_MS=$(grep -oE 'epochMillis: *[0-9]+' "$MANIFEST" | head -1 | grep -oE '[0-9]+')
    END_MS=$(grep -oE 'endEpochMillis: *[0-9]+' "$MANIFEST" | grep -oE '[0-9]+')
    # var-testid: both the official k6 dashboard (19665) and grafana/oreo-k6-verdicts.json
    # key their run selector on the testid label -- the link lands on exactly this run.
    echo "Grafana:  ${GRAFANA_URL}${sep}from=${START_MS}&to=${END_MS}&var-testid=${RUN_ID}"
else
    echo "Grafana time range (replace from=now-1h&to=now in the URL):"
    grep -E 'epochMillis' "$MANIFEST" | sed 's/^/  /'
    echo "  To get a ready-made link: set grafanaDashboard in '$ENV_FILE' (or export GRAFANA_DASHBOARD_URL for one run)"
fi

if grep -q 'PREFLIGHT FAILED' "$RUN_DIR/k6.log" 2>/dev/null; then
    echo ""
    echo "⚠ PREFLIGHT FAILED — the data file failed local validation (placeholders / missing fields / empty pool)."
    grep 'PREFLIGHT' "$RUN_DIR/k6.log" | tail -5
    echo "  Nothing was sent. Fill in the data first; see data/workers/trade-management/README.md."
fi

exit $K6_RC
