# baselines — performance baselines

A baseline = the `summary.json` of some trusted run, **promoted** — it is not a new format:

```bash
cp results/<UTC-date>/<runId>/summary.json baselines/<scenario>_<env>_<profile>.json
```

All three segments of the filename's composite key are indispensable — comparisons across environments or across load tiers are meaningless. Afterwards, every run of the same combination
gets a **Baseline comparison** section automatically appended to its summary by k6 (when no baseline exists and the current run PASSes, run.sh
prints a ready-made promote command).

## Comparison dimensions and tolerances

| Dimension | Tolerance | Notes |
|---|---|---|
| Success-latency P50/P95/P99 increase | +10% (`BASELINE_TOL_PCT=15` for a one-off override) | Only looks at perf_success_duration (business-successful requests) |
| Business success rate decrease | -1.0pp | |
| technical going from none to some | Baseline 0 while current run >0 is flagged red | |
| ok-samples | No tolerance; shown side by side | Percentile credibility tracks sample size — when the two sides are wildly apart, the reader must see it |

rps is deliberately not compared: under the open model the rate is whatever the profile configured, so comparing it carries no information.

## Discipline

- **Exceeding tolerance only flags red, never changes the verdict** — the authority on the verdict is always the thresholds (spec §7/§9); baseline comparison is a regression-discovery mechanism, and making it a gate is a discussion for when P2 wires up CI.
- **Only promote runs with sufficient sample size**: a run qualifies as a baseline only if the summary's Sample size section has no warnings (P95 >= 200 samples); using a smoke run as a baseline is using a random number as a reference point.
- Baselines go stale with the environment (when data, machine, or version changes, re-promote); promotion means committing to the repo — git history is the baseline change history, no separate log needed.
- A corrupted baseline (invalid JSON) makes the next run's init fail loudly rather than silently skip — fix or delete the file.
