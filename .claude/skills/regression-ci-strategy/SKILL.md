---
name: regression-ci-strategy
description: This skill should be used when the user asks to "design a regression suite", "what tests should run in CI", "handle flaky tests", "speed up the test pipeline", "set up quality gates", or needs strategy for test selection, suite tiers, or flaky-test triage.
---

# Regression & CI Strategy

Design test suites as tiers with explicit time budgets and run triggers. The regression suite's job is confidence per minute — every test must earn its runtime.

## Suite tiers

| Tier | Budget | Runs on | Contents |
|---|---|---|---|
| **Smoke** | < 5 min | Every push / PR open | App boots, login works, top 3 revenue journeys pass |
| **PR gate** | < 15 min | Every PR (blocking) | Smoke + unit/API tests for changed areas + affected E2E |
| **Full regression** | < 60 min | Merge to main + nightly | Entire automated suite, all tiers, cross-browser if applicable |
| **Extended** | Hours, ok | Nightly/weekly | Performance (see `performance-testing` skill), long soak, exhaustive browser matrix |

A blocking gate slower than ~15 minutes gets bypassed culturally — people batch changes and stop trusting it. Budget first, then choose what fits.

## Selecting what goes in regression

Score each candidate: **breakage history × business impact × cheapness to run**. Include:
- Every P1 journey from test plans (`test-plan-design` skill)
- Every automated test written for a previously-shipped bug (regression = "bugs we refuse to re-ship")
- Integration points and shared components — highest blast radius

Actively remove: tests that duplicate lower-level coverage, tests for removed features, tests that have never failed for a product reason in 6+ months (move to extended tier). A suite that only grows becomes a suite nobody runs.

## Flaky test protocol

A flaky test is worse than no test: it costs runtime *and* trains people to ignore red.

1. **Detect**: track pass-after-retry rate per test (CI analytics or retry reports). Anything > 1% retry-pass is flaky.
2. **Quarantine same day**: tag `@flaky`, exclude from blocking gates, keep running in a non-blocking job so data accumulates. Never leave a known-flaky test in the PR gate.
3. **Diagnose within a sprint** — flake causes, in observed order of frequency:
   - Timing/waits (fixed sleeps, missing await) → see `ui-automation` skill
   - Test interdependence (shared accounts/data, order dependence)
   - Environment (parallel workers colliding, CI resource limits, third-party calls not mocked)
   - Genuine product race condition — **~10% of "flakes" are real bugs**; rule this out first, not last
4. **Fix or delete.** Quarantine with no owner and no deadline is deletion with extra steps — be honest and set a 2-week expiry.

## CI pipeline shape

```yaml
# Order: fail fastest first
lint+typecheck → unit → API/integration → E2E smoke → [merge] → full regression
```

- Parallelize E2E with sharding (`--shard=1/4`); keep total wall-clock inside the tier budget.
- Retries: at most 1, and only in E2E tiers — retried passes must be *reported* (that's the flake signal), never silently absorbed.
- Every E2E failure must ship artifacts (trace, screenshot, video) — a red build without artifacts wastes a developer round-trip.
- Quality gate = tests + coverage-on-changed-code + no new Sev1/Sev2. Gate on *changed-code* coverage, not total coverage — total invites gaming.

## Metrics that matter

- **PR gate p50/p95 duration** — the developer experience number
- **Flake rate** (retry-passes / total runs) — target < 1%
- **Escape rate** — production bugs that a regression tier should have caught; each one triggers "which tier failed and why"
- Ignore raw test counts and total coverage % as goals; they optimize for volume, not protection.
