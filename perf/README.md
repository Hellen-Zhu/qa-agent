# perf — k6 performance-testing framework

Server-side load-testing framework for the FX Structured Products Trading System, triggered by a local runner (runs directly on Linux/macOS; Windows runs the same run.sh via Git Bash).
Design doc: `../docs/superpowers/specs/2026-07-31-k6-perf-framework-design.md`.

## Quick start

```bash
# <scenario> [env] [profile] [KEY=value...], defaults to local+smoke
./run.sh trades-create.js dev smoke
./run.sh trades-query                                      # equivalent to trades-query local smoke
./run.sh trades-create local baseline VUS=1 DURATION=600s  # KEY=value: arbitrary __ENV overrides

# Artifacts land in results/<UTC day>/<runId>/:
#   summary.txt   three-class / dual-latency text summary (same as terminal), the verdict authority
#   summary.json  machine-readable (runner extracts verdict for the exit code; baseline-comparison input)
#   dashboard.html k6 web dashboard time-series export (not used for the verdict; skipped on very short runs)
#   result.csv    per-request detail (with all tags)
#   manifest.txt  full environment snapshot of this run; k6.log full log (UTC, reconcilable against server logs)

# Local static validation (sends no load)
k6 inspect -e ENV=local src/scenarios/trades-query.js
```

No dependencies beyond k6 (no Node/jq/python); the summary is written to disk directly by k6's handleSummary.

## Directory layout

- `config/environments/` environments (service address mapping, allowlist, promRwUrl, grafanaDashboard, identity pools); **everything in the repo is localhost/example placeholders — real values are filled in only on the intranet; there is no prod entry and none is allowed**
- `config/slas/` API-level percentile SLAs organized by service/module (attached to perf_success_duration; error rate and abort thresholds/breakers are profile-level)
- `profiles/` load profiles (declarative JSON; the scenario block is verbatim k6 executor config; keys starting with `_` are comments; seven profiles — smoke/baseline/load/ladder/stress/spike/soak — methodology in each file's description)
- `data/<service>/<module>/` per-API dedicated data: query field pools + create case pools (one line = one complete same-origin case; discipline in `data/worker-svc/trade/README.md`); `data/datfiles/products/<productType>/` dat samples (placeholders, must be replaced with real captures)
- `src/lib` pure-logic modules (config/users/data/rows/sla/report, loadable in Node) + k6-side modules (http.js pure send pipeline, errors.js three-class engine, bootstrap.js scenario assembly + handleSummary dual-channel output)
- `src/api/<service>/<module>/` API client layer: `<api>.js` (request construction + response contract classification) + `<api>-data.js` for APIs that need a case pool — one file per API, naturally isolated in the init graph; created on demand (only when an API is actually load-tested)
- `src/setup/` preflight (local data gate; no requests sent during the setup stage)
- `src/scenarios` scenario entry points (data + one business action)
- `dashboards/` Grafana dashboard JSON (single-board overview + pinned-version archive of official 19665)
- `baselines/` performance baselines = promoted summary.json files (`<scenario>_<env>_<profile>.json`); when one exists, the summary automatically gains a Baseline comparison section — exceeding tolerance only flags red and never changes the verdict; discipline in `baselines/README.md`

## Conventions

- **UTC across the whole chain**: run.sh already does `export TZ=UTC` (k6 is Go and honors TZ; also effective under Windows Git Bash), so runId / results directory / manifest / k6.log share one clock and can be reconciled against server logs directly; **bare-k6 debug runs that bypass run.sh must bring their own `TZ=UTC k6 run ...`**, otherwise k6.log falls back to the machine's local timezone. The dashboard.html chart x-axis renders in the browser's local timezone — that is frontend behavior and takes no part in log reconciliation
- **Three-class error split**: technical (the performance conclusion) / business (usually a data problem) / script (invalidates the run) must be examined separately; SLA percentiles look only at `perf_success_duration` (business-successful requests)
- The verdict authority is the summary (three-class + thresholds + zero-request false-green guard), not dashboard.html — the web dashboard's error rate is the HTTP-layer http_req_failed, and this system returns 200 even on business failures
- Data selection always uses the global cursor (`exec.scenario.iterationInTest`); metric tags may only take bounded values — unique values like tradeId are strictly forbidden
- Adding a write-path API: under `src/api/<service>/<module>/` add `<api>.js` (contract) + `<api>-data.js` (case pool) + a `data/<service>/<module>/<scenario>.json` case file + preflight; adding a read-path API: add `<api>.js` using `classifyRead` + a field-pool data file
- RATE/VUS/DURATION/MAX_VUS overrides apply only to same-named scalar keys that exist in the profile (stages literals are untouched); any `KEY=value` passes through as k6 `-e`

## Enabling real environments

See `docs/env-checklist.md` — this repo has no mocks and no unit tests, so **the first intranet smoke run is the framework's first end-to-end verification**; start with low traffic and work through the checklist item by item.
