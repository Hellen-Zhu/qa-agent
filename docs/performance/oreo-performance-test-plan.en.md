# OREO Performance Test Plan

> **Confluence location**: Testing & Quality → Specialized Testing → Performance Testing → 3. Test Plan & Scenario Library
> **System**: OREO — Optimized Real-time Execution Orchestrator (FX structured products, full trade lifecycle)
> **Status**: Draft v0.2 (2026-07-29: primary tooling switched to k6; first p02 measurements and monitoring reality folded in) · **Owner**: TBA · **Reviewers**: Architecture / Backend / Frontend / Business Ops
> **Update trigger**: scenario added or removed, NFR change, implementation progress
> **中文**: [oreo-performance-test-plan.zh.md](oreo-performance-test-plan.zh.md)

---

## 1. Scope of this plan

Five documents cover performance, each owning one layer. **This page answers only "how we prove it"** and does not restate the others:

| Document | Question it answers | Relationship to this page |
|---|---|---|
| [Performance Test Strategy](performance-test-strategy.en.md) | When we test, what types, pass principles | This page classifies and prioritises scenarios by its type list |
| [Workload Modeling](workload-modeling.en.md) | How much load | Every scenario references its load values; **none are defined here** |
| [OREO NFR](oreo-nfr.en.md) | What counts as passing | Every scenario cites the NFR IDs it verifies |
| [KPI Definitions](kpi-definitions.en.md) | How things are measured | Every scenario cites the metrics it must report |
| [k6 harness README](../../trade-performance/README.md) | How the k6 is built | Scenarios are implemented in its four-layer structure (scenarios / steps / profiles / lib) |
| [Trade API Plan v2](../trade-api-perf-test-plan-v2-jmeter.md) | JMeter legacy implementation + API dependency matrix | The dependency matrix (§2.2) still underpins the RESIL scenarios; the JMeter harness was removed from the repo on 2026-07-29 (§1.1) |

**The harness lives in `qa/trade-performance/`: k6 is the only implementation (the JMeter legacy has been removed — see git history).**

### 1.1 Tool selection: k6 primary (JMeter legacy removed)

**Decision**: from this version on, the scenario library is implemented in k6 as the primary line. The JMeter assets were removed from the repo on 2026-07-29 (retained in git history as migration references); the dual p02 implementation has served its cross-validation purpose (see §3.1 S-01 first measurements).

The basis is not "which tool is faster" — the two p02 implementations read the same data files and agree to within noise (see the first measurements in §3.2) — but five engineering differences:

| # | Difference | What it means for OREO |
|---|---|---|
| 1 | **Configuration as code, reviewable in git diff** | JMeter's critical behaviours (CSV cursor sharing, scope inheritance, setUp stealing row 1) live in GUI properties; most traps hit during the p02 phase traced back to "configuration owned by the GUI". In k6 the same concerns are explicit code that code review can catch |
| 2 | **Open model built in** (`constant-arrival-rate`) | [Workload Modeling](workload-modeling.en.md) states load as an arrival rate (from λ = 0.0133/s). JMeter's default Thread Group is a closed model — when the server degrades, the load brakes with it, systematically hiding overload consequences; the open model needs the jpgc plugin |
| 3 | **Multiple scenarios in one file** | PERF-19 demands all design capacities pass **simultaneously** — one k6 options object holds N scenarios with independent arrival rates and start times, exactly the shape S-16 / S-15 need; JMeter requires multiple Thread Groups plus plugins |
| 4 | **Thresholds as built-in SLA verdicts** | The verdict lives in the profile and the process exit code carries it — CI-ready; JMeter needs a self-built jtl parser |
| 5 | **Native Prometheus remote-write** | Load metrics land in the same Prometheus, same time axis, as the server metrics (Prometheus remote-write, already wired into the runners); JMeter's equivalent plugin is pull-model and requires changing Prometheus scrape config — one more approval cycle in a bank |

**k6's costs, recorded honestly**: binary `.dat` cannot enter a `SharedArray`, so each VU holds its own copy (budget load-generator memory before running S-14 with the most expensive product at concurrency); the team has zero k6 experience (mitigation: §8 risk 9); CSV / multi-environment parameterisation is less convenient out of the box than JMeter — but that inconvenience buys exactly the explicit scoping of point 1.

**JMeter asset migration list** (ordered by scenario priority; migration sources live in git history — `jmx/` and `groovy/` before the removal commit):

| Order | Asset | Scenarios served | Status |
|---|---|---|:---:|
| ① | `p05-trades-list` | S-09 · S-10 | ✅ 2026-07-29 (pagination param names still to verify against a real response) |
| ② | `checker-task-pool` logic into `setup()` + `p03`/`p04` | S-15 · S-04 | ⬜ |
| ③ | `s01-create-trade-e2e` (journey + 5 steps) | S-03 | ✅ 2026-07-29 (run with `REFDATA_MODE=static` until the refdata address is confirmed) |
| ④ | `p06-trigger-event` | S-15 submit side · S-05 | ⬜ |

Scenarios not yet migrated have **no runnable implementation** until they land in k6 (the JMeter harness is gone). When citing historical JMeter numbers, label the tool — timing definitions differ (JMeter `elapsed` includes connection setup, k6 `http_req_duration` does not); per [KPI Definitions](kpi-definitions.en.md).

---

## 2. Test targets and priority

### 2.1 Business entry points (not an API list)

OREO's test targets are organised by **user entry point** rather than as a flat list of 33 APIs. Reason: one frontend action usually triggers several APIs, and testing each API alone misses the resource competition and ordering dependencies between them.

| Entry point | Page | Paths involved | Priority |
|---|---|---|---|
| **Blotter browsing + auto-refresh** | Trade Portal | `GET /trades` + UC enrichment | **P0** — largest share of request volume |
| **New Trade (with `.dat` upload)** | Trade Portal | refdata → dat-to-json → calc-risk-for-new → create | **P0** — highest per-request cost |
| **Right-click lifecycle event submit** | Trade Portal | `trigger-event` / per-event endpoints | **P0** — start of the two-phase write path |
| **Checker approve / reject** | Trade Portal | pending → approve / reject / bulk-* | **P0** — end of the two-phase write path |
| **Notification polling** | Global | `unread-count` / `inbox` | **P0** — constant load, second-largest share |
| **View Details + risk-metrics** | Trade Portal | `GET /trades/{id}` + risk-metrics | P1 |
| **Composer product management** | Composer | `/products*` / `product-field-configs` | P2 — low frequency, but its config cache affects hot paths |
| **Batch jobs** | No page | trade-aging / sync-cashflows / refdata sync | P1 — interference risk |

### 2.2 Out of scope for this plan

| Item | Reason | Handling |
|---|---|---|
| WebSocket push channel | Neither tooling nor metric definitions are ready | Registered as a gap, see [KPI Definitions](kpi-definitions.en.md) §7 |
| UC / risk-engine / notification internals | Not this system's responsibility | Only their degradation effect on OREO is tested (S-11) |
| Third-party refdata source | No authorisation to load-test | Only interference during the sync window is tested (S-13) |
| Frontend rendering detail | Covered by the Frontend Performance page | Combined verification only, in S-08 |

---

## 3. Scenario library

### 3.1 Master table

**Implementation**: ✅ implemented · 🟨 partial · ⬜ not implemented. **The k6 column is the primary line**; the JMeter column records the legacy state before removal (migration sources in git history, see §1.1).

| ID | Scenario | Type | Priority | NFRs verified | k6 | JMeter |
|---|---|---|:---:|---|:---:|:---:|
| **S-01** | **`.dat` per-request cost profile** | Cost Profile | **1** | PERF-07–10, RES-01 | 🟨 | 🟨 |
| **S-09** | **Fan-out Audit** | Fan-out | **1** | PERF-02, OBS-01, SCALE-01 | 🟨 | 🟨 |
| **S-18** | **Audit completeness reconciliation** | Integrity | **1** | AUDIT-02 | ⬜ | ⬜ |
| **S-05** | **Same-trade concurrent contention** | Contention | **2** | INTEG-03, INTEG-07, AVAIL-02 | ⬜ | ⬜ |
| **S-10** | **Data-volume scaling** | Volume Scaling | **2** | SCALE-01, PERF-02 | 🟨 | 🟨 |
| **S-14** | **Concurrent parse cap and backpressure** | Resource | **2** | RES-01, RES-02 | 🟨 | ⬜ |
| **S-15** | **Two-phase approval path (maker → checker)** | Load | **2** | PERF-12–14, PERF-17, SCALE-02 | ⬜ | 🟨 |
| S-03 | Create Trade E2E (frontend journey) | Load | 3 | PERF-07, PERF-11, PERF-19 | 🟨 | ✅ |
| S-11 | Downstream degradation isolation (UC / risk / notification) | Interference | 3 | RESIL-01, 02, 05, 06 | ⬜ | ⬜ |
| S-12 | DAT parsing CPU / memory competition | Interference | 3 | RESIL-03 | ⬜ | ⬜ |
| S-02 | Booking cutoff peak | Load | 4 | PERF-07, PERF-19 | ⬜ | ⬜ |
| S-13 | Batch jobs in parallel with online traffic | Interference | 4 | RESIL-04, SCALE-05 | ⬜ | ⬜ |
| S-04 | Checker batch queue-clearing | Spike | 5 | PERF-15, PERF-16 | ⬜ | 🟨 |
| S-16 | Full-capacity mixed load | Load | 5 | **PERF-19**, PERF-01–18 | ⬜ | ⬜ |
| S-07 | Month / quarter-end roll | Load | 6 | PERF-20 | ⬜ | ⬜ |
| S-17 | Soak — long trading day | Soak | 6 | AVAIL-01, MAINT-04 | ⬜ | ⬜ |
| S-06 | Market-volatility event surge | Spike | 7 | PERF-12, PERF-19 | ⬜ | ⬜ |
| S-08 | Combined layer (backend load + real browser) | Combined | 8 | Frontend metrics | ⬜ | ⬜ |

Notes: S-18 is a post-run reconciliation script (SQL), tool-independent, hence ⬜ in both columns. S-14's k6 🟨 means the load shapes are ready (`ladder` / `arrival` profiles); what is missing is most-expensive-product data and memory observability.

**The k6 primary line now carries three vehicles: `p02-trade-create` (S-01), `p05-trades-list` (S-09/S-10), `s01-create-trade-e2e` (S-03).** The priority-1/2 scenarios remain incomplete mainly because of the capability gaps in [NFR](oreo-nfr.en.md) §12.2 (memory instrumentation, data factory, fault injection — tool-independent), not migration progress. See §8.

### 3.2 Priority 1 — the three that must come first

#### S-01 `.dat` per-request cost profile

| Item | Content |
|---|---|
| **Goal** | Answer "how much time, CPU, and memory does **one** create / dat-to-json consume", producing the basis for the concurrency target and the cost envelope |
| **Load shape** | **1 concurrent**, sweeping the **productType representatives** ([Workload Modeling](workload-modeling.en.md) A26: cheapest / most expensive / most common), 30 runs each for a distribution |
| **Variable** | **productType.** File size, fixing count, and schedule length are all **consequences** of productType, not independent variables |
| **Key metrics** | Duration per productType · **peak memory per parse** · memory amplification factor · CPU time · **shape of duration vs cost driver (fixing count / file size)** |
| **Pass criteria** | PERF-07/08/09/10 met; **duration is linear or sub-linear in the cost drivers** |
| **Outputs** | ① Per-representative duration → read the **concurrency target** from [Workload Modeling](workload-modeling.en.md) §4.7.4 (input to S-14)<br>② **Cost envelope A28** (ceiling per driver) → baseline for the new-product re-test trigger |
| **Impl** | 🟨 k6 primary: `scenarios/p02-trade-create.js` + `smoke` / `baseline` profiles; JMeter counterpart removed (git history). **The data pool (`create-trade-data.json`) currently holds only one productType (FX_TRF) and must be extended to the A26 representatives**; **no collection mechanism for memory** |
| **First measurements** | **FX_TRF (late 2026-07, local dev, k6 n=1,045): P50 287 / P95 298 / P99 312 ms**; the JMeter run on the same data files agrees to within noise (P50 257–319). Applying the [Workload Modeling](workload-modeling.en.md) §4.7.4 rule gives a **concurrency target k = 2** (the boundary to 3 sits at a mean per-request time of ≈ 3.4 s). ⚠ Local-environment figures serve only as an order-of-magnitude reference and a regression-baseline starting point — never extrapolated to production |
| **Blocked by** | **OBS-02** (parse peak memory not observable; the JVM heap panel gives a coarse read at 1 concurrent) · **A24 Composer catalogue unconfirmed** · A26 representative `.dat` samples missing (only one FX_TRF sample exists locally; real samples are never committed). Currently only FX_TRF duration conclusions are possible |

**Why the sweep dimension is productType rather than file tier**: file size is a **consequence** of
product structure. "TARF × small" does not exist in reality, so treating productType and datSize as
orthogonal dimensions generates test cases that cannot occur. See
[Workload Modeling](workload-modeling.en.md) §4.7.

**This scenario's outputs determine how two others are designed**: S-14's concurrency tiers come from
the durations measured here, and S-16's degenerate mix comes from whichever product is identified as
most expensive. **Without its results, neither of the other two can be designed.**

**Why it is priority 1**: the progression rule in [Strategy](performance-test-strategy.en.md) §4 requires Cost Profile before Load. Applying concurrency without knowing that one parse takes 3 seconds and 2 GB produces a crash you cannot attribute — you do not know whether it is a concurrency problem or a single request already over the limit. The first measurements have removed FX_TRF from that unknown (~0.3 s); the "seconds per parse" premise now holds only for the unmeasured representatives — which is exactly why the A26 sweep remains this scenario's gate.

**Super-linearity is a design-defect signal**: if the large tier (20 MB) takes more than 100× the small tier (assume 200 KB), the parsing algorithm has super-linear cost — an architectural problem, not a capacity one.

#### S-09 Fan-out Audit

| Item | Content |
|---|---|
| **Goal** | Answer "how many UC gRPC calls does one blotter list request trigger" |
| **Load shape** | **Single request**, sweeping returned rows: 50 / 200 / 500 |
| **Key metrics** | UC gRPC call count · risk-engine call count · DB query count (each vs returned rows) |
| **Pass criteria** | **Fan-out = O(1)** — call count does not grow with returned rows |
| **Impl** | 🟨 k6 primary built (`scenarios/p05-trades-list.js`, row count lands in the `oreo_trades_rows` metric; ⚠ pagination param names inherit the guessed values — the first smoke must verify returned rows); JMeter counterpart removed (git history). **Precise fan-out counting is still missing, but a coarse method now exists** (see below) |
| **Blocked by** | **OBS-01** (precise fan-out not observable) — **now bypassable**: the server's Prometheus already exposes `rpc_client_duration_milliseconds_count`; the delta across a window gives the outbound gRPC call count (take the counter delta across the window) |

**This is the highest information density per unit of cost in the whole plan** — three requests, and a decisive conclusion:

```
If fan-out = O(1):  blotter 33 TPS -> UC 33 QPS      -> no capacity risk
If fan-out = O(n):  blotter 33 TPS -> UC 6,600 QPS   -> primary bottleneck, needs architecture work
```

The two answers imply entirely different capacity plans and optimisation directions. **Until this conclusion exists, PERF-02's 1,500 ms threshold in the [NFR](oreo-nfr.en.md) is just a number** — we do not know whether 1 or 200 downstream calls sit behind it, so we cannot predict how it behaves under load.

**Fallback (executable before OBS-01 lands)**: in a quiet window, send one blotter request per row tier (50 / 200 / 500) and diff `rpc_client_duration_milliseconds_count` before and after — the server's Prometheus already collects this metric, so no new capability is needed. Less precise than an APM trace (no per-request attribution), but sufficient to distinguish O(1) from O(n) — and that distinction is this scenario's entire purpose. **This scenario is effectively unblocked**; it only awaits a quiet window. DB-side query counting / tcpdump remain as backup.

#### S-18 Audit completeness reconciliation

| Item | Content |
|---|---|
| **Goal** | Prove no audit records are lost under load |
| **Load shape** | **Not a standalone scenario** — a **closing step** of every Load round (S-02 / S-15 / S-16) |
| **Execution** | After the run, reconcile: `audit record count == successful event samples in the jtl` |
| **Pass criteria** | **Difference exactly 0.** Non-zero fails AUDIT-02 regardless of latency |
| **Impl** | ⬜ Needs a reconciliation script + read-only access to the audit table |
| **Blocked by** | DB read-only access, or an audit-count API |

**Why it must be automated rather than spot-checked**: switching audit writes to asynchronous behind a bounded queue that drops when full is a common optimisation that **appears to improve latency**. In a load report it looks like progress; in reality it trades compliance risk for speed. Nobody announces such a change — only per-round automated reconciliation finds it.

---

### 3.3 Priority 2 — four high-value scenarios

#### S-05 Same-trade concurrent contention

| Item | Content |
|---|---|
| **Goal** | Verify `pending approve` lock behaviour under concurrency: mutual exclusion, no deadlock, no lost updates |
| **Load shape** | **Low concurrency (5 / 10 / 20 threads) all targeting one trade** |
| **Sub-scenarios** | ① Multiple makers submit events on the same trade simultaneously<br>② Maker submit and checker approve occur simultaneously<br>③ Two checkers approve the same task simultaneously<br>④ Concurrent amendments (lost-update test) |
| **Key metrics** | Success count · business rejection count · 5xx count · DB lock wait duration · **final state consistency** |
| **Pass criteria** | See the decision item below |
| **Impl** | ⬜ |
| **Blocked by** | No technical blocker; **awaiting team confirmation of expected behaviour** |

**This scenario is a blind spot of conventional load testing.** Standard designs point each thread at a different trade (precisely to avoid interference), so they **never trigger** same-entity contention. Yet four-eyes serialises operations on a single trade — OREO's most distinctive concurrency behaviour, and the most likely place for a bug.

> **⚠ Team decision needed: what is the expected behaviour of a concurrent submit?**
>
> The assertion depends on product intent. All three are reasonable designs, but **only one is correct here**:
>
> | Option | Behaviour | Assertion |
> |---|---|---|
> | A | The second request receives an explicit business rejection ("trade is under approval") | `count(success) == 1 && rest are business rejections` |
> | B | The second request queues and proceeds once the first completes | `count(success) == N && state chain intact` |
> | C | The second request receives 409 Conflict | `count(success) == 1 && rest are HTTP 409` |
>
> **Unacceptable behaviours** (a failure whichever option is chosen): silent overwrite · 5xx · both succeed leaving inconsistent state · deadlock timeout.
>
> This decision must come from product/architecture, not be made by the test team — it defines a system contract, not a test detail.

#### S-10 Data-volume scaling

| Item | Content |
|---|---|
| **Goal** | Verify the blotter query degradation curve as data grows |
| **Load shape** | Fixed load (blotter design capacity, 33 TPS), sweeping data-volume tiers |
| **Data tiers** | 1,000 / 50,000 / 250,000 trades |
| **Key metrics** | P95 / P99 per tier · new slow queries · DB execution plan changes |
| **Pass criteria** | SCALE-01: P95 at 250k ≤ 3× P95 at 1k |
| **Impl** | ⬜ |
| **Blocked by** | **Data factory not built** (needs 250k trades, distributed realistically across portfolios, states, product types) |

**It is really an index-absence detector.** Allowing only 3× P95 degradation across a 250× data increase is equivalent to requiring an index. If measured degradation exceeds 10×, a full scan can be assumed — a more useful conclusion than any single P95 figure.

**Seeding must not simply clone one trade 250,000 times**: that distorts index selectivity, produces a query plan unlike reality, and invalidates the conclusion. The distribution must span multiple portfolios, counterparties, states, and product types.

#### S-14 Concurrent parse cap and backpressure

| Item | Content |
|---|---|
| **Goal** | Verify that exceeding the concurrent `.dat` parse limit **queues or rejects rather than OOMs** |
| **Load shape** | The lesser of two ceilings:<br>① **Business concurrency target K** — derived from S-01's measured duration via the [Workload Modeling](workload-modeling.en.md) §4.7.4 rule. **FX_TRF measured at ~0.3 s → K = 2**; the most expensive product is unmeasured — a mean per-request time above 3.4 s makes K = 3, slower still per the §4.7.4 table (not an assumed value; updated as the A26 sweep progresses)<br>② **Theoretical resource ceiling N** = available heap ÷ peak memory per parse<br>Run K-1 / K / N / N+2 / 2N concurrent, all using the **most expensive productType**. k6 vehicles: `ladder` (closed model, find the knee) + `arrival` (open model, see the overload consequences — a closed model brakes itself as the server degrades, hiding queue build-up) |
| **Key metrics** | Peak heap · GC pauses · rejection rate and rejection mode · **degradation of unrelated endpoints during the window** |
| **Pass criteria** | RES-01: over-limit returns an explicit business error or queues; **never OOM**; unrelated endpoints degrade ≤ 20% (RESIL-03) |
| **Impl** | ⬜ |
| **Blocked by** | Depends on S-01's duration and memory conclusions (therefore on OBS-02) |

**If N < K, that is a hard capacity ceiling with no remedy but more memory** — and it must surface
before launch. See [NFR](oreo-nfr.en.md) RES-01.

**Note the feedback loop from §4.7.4**: the concurrency target K is itself a function of per-request
duration. If the most expensive product takes 45 s, P(≥2 concurrent) jumps from 3% to 12% and K rises
from 4 to 5. **A slower product overlaps more readily, and overlapping makes it slower still** —
congestion collapse remains possible at 0.013 TPS. That is the risk this scenario exists to falsify.

**The consequence of OOM is not "this request fails" but "the whole JVM dies"** — taking down every unrelated in-flight request with it, including someone else's blotter query and someone else's task approval. So this scenario does not verify "how much concurrency it survives"; it verifies **whether an explicit concurrency gate exists at all**. Without a gate, the capacity ceiling is a cliff rather than a curve.

#### S-15 Two-phase approval path (maker → checker)

| Item | Content |
|---|---|
| **Goal** | Measure submit and approve/reject system latency separately, and verify notification delivery and queue behaviour |
| **Load shape** | Two k6 scenarios in one options object: makers submit at the business arrival rate, checkers consume `checker_tasks`, each with its own executor and `startTime` |
| **Timing** | `TX_Event_Submit` · `TX_Event_Approve` · `TX_Event_Reject` · `TX_Notify_Delivery`, **timed separately** |
| **Rejection ratio** | Configured to A8 = 5%; **the reject path must be covered** |
| **Key metrics** | Percentiles for all four transactions · `checker_tasks` queue-depth trend · audit record count (S-18) |
| **Pass criteria** | PERF-12/13/14/17 met; SCALE-02 queue does not grow monotonically |
| **Impl** | ⬜ k6 (the carrying pattern is settled, see below); the former JMeter harness had built the task pool and approval fragments (`checker-task-pool.jmx`, `checker-flow/*`, `p03`/`p04` — git history) as migration sources |
| **Blocked by** | No technical blocker, but **the hardest script design in the suite** — see below |

**The maker → checker handoff** is the one non-trivial scripting problem in this plan. The maker side produces taskIds and the checker side consumes them — but k6 VUs have **no mutable shared state** (`SharedArray` is read-only and init-time only), so two scenarios cannot pass values at runtime. Three approaches:

| Option | Approach | Pros | Cons |
|---|---|---|---|
| **A. Pre-seeded task pool** (recommended) | `setup()` submits N events up front and returns the taskId array to every VU; the checker side consumes non-overlapping slices by VU / iteration index | Sides are decoupled, reproducible, easy to attribute; submit and approve can be loaded independently; **no cross-VU coordination at all** | Does not reproduce genuinely interleaved submit/approve concurrency |
| B. External handoff (Redis / helper service) | Makers write to an external queue; checkers poll it | Closer to real timing | Needs an xk6 extension or a bespoke service — new failure surface and noise, plus one more approval in a bank environment |
| C. File handoff | Pass taskIds via a file | — | **Impossible in k6**: `open()` is init-time only; no file I/O at runtime |

**A is recommended**, for the same reason as the reference-data approach: **move the uncontrollable timing dependency into setup so the measurement phase has one variable left.** In k6 it is close to the only practical choice — and that is no compromise: we reached the same verdict for the JMeter version of this three-way choice (realistic interleaving is not worth two sides' rates influencing each other until the result cannot be attributed). The former harness's `checker-task-pool.jmx` (git history) **is** option A; migration copies its logic into `setup()`.

If interleaving genuinely needs verification (e.g. suspicion that submit and approve mutually lock at the DB layer), cover it with **S-05 sub-scenario ②** rather than complicating S-15.

---

### 3.4 Priority 3–8 — remaining scenarios

| ID | Goal | Load shape | Pass criteria | Notes |
|---|---|---|---|---|
| **S-03** | Full Create Trade frontend journey | Call sequence per v2 §5.3 + think time | PERF-07, PERF-11, PERF-19 | k6 🟨 (`s01-create-trade-e2e.js` + `journeys/j01`; run with `REFDATA_MODE=static` until the refdata address is confirmed, deviation must be declared) |
| **S-11** | Downstream degradation isolation | Degrade UC / risk-engine / notification in turn | RESIL-01/02/05/06, degradation ≤ 10% | **Needs fault injection**; UC first (blast radius: 9 APIs) |
| **S-12** | DAT parsing crowding out unrelated endpoints | Background concurrent large-tier parses + foreground refdata reads | RESIL-03, degradation ≤ 20% | Verifies the "in-process CPU competition" assumption |
| **S-02** | Booking cutoff peak | 4× mean sustained for one hour | PERF-07, PERF-19 | Close out with S-18 |
| **S-13** | Batch jobs in parallel with online traffic | trade-aging / sync-cashflows / refdata sync alongside online load | RESIL-04, degradation ≤ 20% | Requires confirming the refdata sync write mode (upsert vs truncate-reload) — the two have entirely different failure models |
| **S-04** | Checker batch queue-clearing | `bulk-approve` at batch 1/5/20/50, 3 concurrent batches | PERF-15/16; **per-unit latency must not rise with batch size** | A burst shape; do not use constant arrival rate. The former JMeter scripts (`p03` / `p04`, git history) are the migration source; k6 follows migration item ② |
| **S-16** | Full-capacity mixed load | All design capacities from [Workload Modeling](workload-modeling.en.md) §6 applied together | **PERF-19** (all thresholds met simultaneously) | The only scenario that can expose cross-path resource competition. Carried by k6 multi-scenario in one file (independent arrival rate per path) — one of the direct reasons k6 was chosen. **Has two productType mix sub-scenarios, see below** |
| **S-07** | Month / quarter-end roll | 3× a normal day, all day | PERF-20, degradation ≤ 20% | Event mix weighted toward rolls / reassignment |
| **S-17** | Soak — long trading day | Design capacity for 4–8 hours | AVAIL-01, MAINT-04; no memory or connection leak | **Ranks above Spike**: blotter auto-refresh runs constantly all day. ⚠ Data-creating paths must run at **arrival rate** (see the "run-generated data" row in §4) |
| **S-06** | Market-volatility event surge | Surge in early termination / novation | PERF-12, PERF-19 | Multiplier awaits business confirmation |
| **S-08** | Combined layer | S-16 load + 3–5 Playwright sessions | Frontend metrics ([KPI](kpi-definitions.en.md) §3) | Verifies "backend passing ≠ UI is smooth" |

### 3.5 S-16's two productType mix sub-scenarios

S-16 is the only scenario where productType acts as a **mix weight** rather than a sweep dimension.
It must run twice:

| Sub-scenario | Mix | Purpose |
|---|---|---|
| **S-16a average mix** | The daily product distribution from [Workload Modeling](workload-modeling.en.md) A25 | Normal-state acceptance against PERF-19 |
| **S-16b degenerate mix** | **A27: 5 consecutive bookings, all the most expensive productType** | Find the real capacity boundary |

**S-16b is not a stress test — it is the normal case.** The reasoning is in
[Workload Modeling](workload-modeling.en.md) §4.7.3:

> The law of large numbers needs sample size. A cutoff hour holds only 48 bookings, and arrivals are
> **correlated** — one salesperson running a campaign books five of the same type back to back.
> **At this volume, the "average mix" never actually occurs.**

Hence a counter-intuitive but binding rule:

> **High-throughput systems test the average mix; low-throughput systems must test the degenerate mix.**

**Practical consequence**: negotiating with the business over "is it 30% or 40% TARF" is low-value
work — that percentage has no statistical meaning across 48 bookings. The question actually worth
asking the business is: **"are there product campaign periods? can one product type cluster over a
short window?"** That determines how extreme A27 must be.

**S-16a passing while S-16b fails must be recorded as a failure.** The degenerate mix is a situation
that genuinely occurs; it is not headroom that can be filed as "extreme scenario, monitor later".

---

## 4. Data preparation

| Data | Quantity | Supply method | Status |
|---|---|---|---|
| **Trade seed data** | Three tiers: 1k / 50k / 250k | Data factory; distribution must span portfolios / counterparties / states / product types | ⬜ **Blocks S-10** |
| **`.dat` samples** | **Several per A26 representative productType**, plus invalid cases | Business provides real samples; directories keyed by productType, not size alone (`data/dat/products/<TYPE>/`, real samples never committed) | 🟨 Only one FX_TRF sample locally; **the other two A26 tiers are missing, blocking the S-01 sweep** |
| **Composer product catalogue** | Full productType list with fixing counts / schedule shapes | Product owner provides (A24) | ⬜ **Blocks A26 representative selection** |
| **Migration dataset statistics** | productType distribution of the existing book | Architecture / DBA produce the statistics (A25) | ⬜ **Blocks the S-16a mix** |
| **Counterparty / Portfolio** | Resolved per run | **setUp query + real trade creation to validate + archived snapshot** | ✅ Implemented |
| **Pending task pool** | For S-15, N ≈ 200 | Pre-seeded submissions in `setup()` (option A) | 🟨 logic proven (former `checker-task-pool.jmx`, git history); porting into k6 `setup()` pending |
| **Shared contention target trade** | For S-05, one per sub-scenario | Created and recorded in `setup()` | ⬜ |
| **User identity pool** | N makers, M checkers | `data/shared/accounts.csv` | ✅ Implemented (needs real accounts) |
| **Run-generated data** (each round's by-product) | Trades created = VUs × duration ÷ per-request time. **The faster the API, the more data**: at 0.3 s, 1 VU × 300 s ≈ 1,000 real `PENDING APPROVAL` trades; 4 VUs flat-out for 4 h ≈ **190k**, whereas the design-capacity arrival rate (0.11 TPS) over 4 h is ≈ 1,600 | ① Agree a cleanup protocol with DBA / dev (bulk reject / archival / dedicated marker); ② long data-creating runs always use the `arrival` rate shape, never flat-out constant-vus | ⬜ **Phase-1 item**; left uncleaned it drifts S-10's data tiers |

**Reference data is the one class the test cannot control**: counterparty / portfolio arrive via a sync batch job from a third party. Hard-coding them goes stale, and staleness manifests as **HTTP 200 + wholesale business rejection** — reporting as a 0% error rate. Handling is described in [v2 plan](../trade-api-perf-test-plan-v2-jmeter.md) §4.4 and implemented in `setup/create-trade-preflight.js`.

---

## 5. Environment requirements

| Requirement | Note | Status |
|---|---|---|
| Dedicated performance environment | Isolated from functional testing to avoid mutual interference | ⬜ Not available |
| Data volume met | Reaches the scale assumed in [Workload Modeling](workload-modeling.en.md) A16 | ⬜ |
| Server-side monitoring | CPU / heap / GC / connection pools / DB locks / slow queries | 🟨 **Grafana + Prometheus are running** (HTTP / gRPC / JVM / HikariCP layers; read them off the dashboards themselves); DB lock and slow-query views missing; HikariCP acquire/usage histograms not enabled (dev to switch on Micrometer percentiles); **pool max = 10 confirmed** (the concrete input to RES-04) |
| **Fan-out counters** (OBS-01) | APM trace or counters | 🟨 Precise counting still missing; **coarse method available**: `rpc_client_duration_milliseconds_count` window deltas (S-09 can proceed) |
| **Parse memory instrumentation** (OBS-02) | JFR or application instrumentation | ⬜ Per-request peak still missing (JVM heap panel suffices only for a coarse read at 1 concurrent) · **blocks S-14's N derivation** |
| Load metrics into the server's Prometheus | k6 native remote-write (already wired in `run.sh` / `run.ps1`); load TPS / P95 land on the same store and time axis as server metrics | ⬜ Prometheus must enable `--web.enable-remote-write-receiver` (approval process). Non-blocking: timestamp alignment (manifest records the epoch window) works meanwhile |
| **Queue depth metric** (OBS-05) | `checker_tasks` pending count | ⬜ **Blocks S-15 / SCALE-02** |
| Fault injection | Controllably degrade UC / risk-engine / notification | ⬜ **Blocks S-11** |
| Process-kill drill | Controlled restarts to verify lock recovery | ⬜ Blocks AVAIL-02 / INTEG-02 |
| Read-only audit table access | For S-18 reconciliation | ⬜ **Blocks S-18** |

**Results from a functional environment are used only for trend comparison and to expose implementation-level problems; they are never extrapolated to production capacity.**

---

## 6. Execution order and phasing

### 6.1 Progression rule (no skipping)

```
Smoke                              <- first step of every round; validates script and environment
  |
S-01 Cost Profile                  <- know what one request costs
  |
S-10 Volume Scaling                <- know what it costs at data volume
  |
S-09 Fan-out Audit                 <- know how many downstream calls one request causes
  |
S-03 / S-15 single-path Load       <- only now apply concurrency
  |
S-05 Contention · S-14 Resource    <- boundaries and contention
  |
S-11 / S-12 / S-13 Interference    <- mutual interference
  |
S-16 Full-capacity mixed           <- the only scenario that supports an "overall pass" conclusion
  |
S-02 / S-04 / S-06 / S-07 peaks    <- the four peak shapes
  |
S-17 Soak · S-08 Combined          <- duration and real experience
```

**Every Load-class round (S-02 / S-15 / S-16 / S-07) must close with the S-18 audit reconciliation.**

**The same progression applies inside each scenario** (k6 profiles): `smoke` (script self-check) → `baseline` (1 VU, the denominator) → design-concurrency / arrival-rate acceptance (`load` / `arrival`) → only then `ladder` / `soak`. Numbers produced by skipping the first two steps are never accepted.

### 6.2 Phased delivery

| Phase | Content | Prerequisite |
|---|---|---|
| **Phase 1: unblock** | Raise OBS-02/05 observability requirements + Micrometer histogram enablement; build the data factory; **agree the run-generated-data cleanup protocol with DBA**; request read-only audit access and Prometheus remote-write; confirm frontend polling parameters A10–A12; obtain the A26 representative `.dat` samples | None — **can start immediately, and everything later is constrained without it** |
| **Phase 2: priority 1–2** | S-01 (A26 sweep) · S-09 (rpc_client delta method, **can go first**) · S-18 · S-05 · S-10 · S-14 · S-15; migration items ①–② of §1.1 in parallel | Phase 1 |
| **Phase 3: priority 3–5** | S-03 (k6 built 🟨, see §3.1) · S-11 · S-12 · S-02 · S-13 · S-04 · S-16 | Fault-injection capability |
| **Phase 4: priority 6–8** | S-07 · S-17 · S-06 · S-08 | Dedicated performance environment |

**Phase 1 produces no performance numbers, but it determines whether the following three phases can produce valid conclusions.** Skipping it and running scenarios directly yields a set of numbers nobody can attribute.

### 6.3 Entry criteria (per-round gate)

Exit criteria (§7) govern "when we are done"; entry criteria govern "whether this round deserves to start". Check every item before each round:

| # | Gate | Consequence if unmet |
|---|---|---|
| 1 | Refdata preflight passed (setup creates one real trade to validate) | Stale reference data → HTTP 200 + wholesale business rejection, yet the report shows 0% errors |
| 2 | `smoke` shows zero errors in all three classes (the profile's thresholds are this gate; exit-code verdict) | Script bugs contaminate the results; the round is void |
| 3 | The gap between actual data volume and the A16 assumption is declared | Empty-database numbers get misread as capacity conclusions |
| 4 | Monitoring reachable, clocks in sync (manifest auto-records the epoch window) | Server metrics cannot be aligned to the time axis; no attribution |
| 5 | Data-creating scenarios: cleanup protocol in place, arrival-rate shape used instead of flat-out constant-vus | One soak leaves six-figure counts of orphaned trades (see §4) |
| 6 | Sample-size budget holds: `VUs × duration ÷ per-request time` ≥ 200 (to report P95) / ≥ 1,000 (to report P99) | The percentile is a random number — and the report gives no hint of it |

---

## 7. Exit criteria

A full performance round may be declared "passed" only when all of the following hold:

| # | Criterion |
|---|---|
| 1 | **Script error rate = 0** (PERF-21). Non-zero voids the round; passing after deduction is not permitted. In k6 this is hard-gated by the `oreo_err_script` threshold — failure makes the process exit non-zero; the verdict is mechanical, not a matter of discipline |
| 2 | **Reference-data preflight passed.** Runs where it failed are void |
| 3 | **Data volume reaches the A16 assumption.** Empty-database results are invalid |
| 4 | PERF-01–18 met **simultaneously** in the S-16 full-capacity mixed scenario |
| 5 | **S-18 audit reconciliation difference is 0** (AUDIT-02) |
| 6 | No correctness red-line event as defined in [NFR](oreo-nfr.en.md) §1.1 (inconsistent state / snapshot dropping fields / missing audit) |
| 7 | Key conclusions re-run and confirmed, with ≤ 10% P95 difference between runs |
| 8 | Every NV-tagged item is explicitly listed in the report as **unverified**, never assumed passing |

**Criterion 8 is the one most easily violated.** A report that covers only what was tested makes the untested look like it passed. Reports must explicitly distinguish "tested and passed", "tested and failed", and "not tested".

---

## 8. Risks and blockers

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | **OBS-02/05 unmet** (OBS-01 now has a fallback) | S-01 memory conclusions, S-14's N, and SCALE-02 cannot be verified | Raise as requirements in Phase 1; S-09 proceeds on `rpc_client` count deltas (see §3.2) |
| 2 | **Frontend polling parameters (A10–A12) unconfirmed** | The base for every capacity figure is wrong, potentially by 6× | Confirmation is very cheap (frontend config); **flagged highest priority** |
| 3 | **No real `.dat` samples** | S-01 cannot run, breaking the first link of the progression chain | Request real samples for the **A26 representative products** from business |
| 3b | **productType universe and mix unknown (A24 / A25)** | S-01 cannot sweep completely; S-16 has no basis for its mix | Obtain the Composer catalogue plus **migration-dataset statistics** (the latter converts A5/A7/A25 from guesses into statistics, see [Workload Modeling](workload-modeling.en.md) §4.7.6) |
| 4 | **Data factory not built** | S-10 cannot run; and every blotter conclusion is invalid on an empty DB | Progress in parallel during Phase 1 |
| 5 | **S-05 expected behaviour undefined** | The scenario runs but cannot be judged | Needs a product/architecture decision, see §3.3 |
| 6 | **SEC-01 identity model unconfirmed** | If gateway authentication is introduced, the load-test entry point needs rework | See [NFR](oreo-nfr.en.md) §6; architecture to answer |
| 7 | No dedicated performance environment | Conclusions limited to trend comparison | Prerequisite for Phase 4 |
| 8 | WebSocket entirely uncovered | No conclusion on the push path of create / trigger-event | Registered as a gap; separate initiative |
| 9 | **Zero team k6 experience** | Script quality and schedule risk | The harness README covers structure, constraints and getting started; the JMeter assets are removed — migration takes its sources from git history per the §1.1 list |
| 10 | **No cleanup protocol for run-generated trades** | Environment data drifts run over run; S-10 tiers distort; ultimately every blotter conclusion suffers | Agree with DBA / dev in Phase 1; data-creating scenarios always use the arrival-rate shape (§6.3 gate 5) |

---

## 9. Deliverables

| Deliverable | Content | Location |
|---|---|---|
| **k6 harness (primary)** | Four-layer structure (scenarios / steps / profiles / lib), three-class error separation, run.sh / run.ps1, static validation via `k6 inspect` | `qa/trade-performance/` |
| JMeter legacy harness (removed) | Migration source, retained in git history | git history (before the 2026-07-29 removal commit) |
| Per-run manifest | git commit, tool versions, all resolved parameters, epoch window (aligns with Grafana) | `results/<YYYYMMDD>/<runId>/manifest.txt` (implemented in both runners) |
| Round report | Three-class error separation + success-only percentiles + sample-size warnings; `summary.txt` (`lib/summary.js`) | `results/<YYYYMMDD>/<runId>/` · metric definitions per [KPI Definitions](kpi-definitions.en.md) §6 |
| SLA verdict | k6 profile thresholds built in; exit code carries the verdict (`load` already enforces technical = 0, business success > 99%); **NFR-ID ↔ threshold mapping table still to write** | `profiles/*.json` 🟨 |
| Audit reconciliation script | S-18 closing check (SQL reconciliation, tool-independent) | ⬜ not built |
| Operating and reading docs | Harness structure, k6 constraints, getting started, open items | [`README.md`](../../trade-performance/README.md) |
| Phase summary | Passed / failed / **unverified** items, capacity conclusions, architecture recommendations | Confluence |

---

## 10. Roles and responsibilities

| Role | Responsibility |
|---|---|
| QA | Scenario design and implementation, execution, reporting; maintains this document and the scenario library |
| Architecture | Answer the 9 open questions in [NFR](oreo-nfr.en.md) §12.3; sign off technical NFRs; design OBS capabilities |
| Backend | Provide OBS-01/02/05 observability; explain new slow queries; fix correctness red lines |
| Frontend | **Confirm polling parameters A10–A12** (highest priority); frontend metric instrumentation |
| Business Ops | Sign off assumptions A1–A23 and PERF latency thresholds; provide real `.dat` samples |
| Operations | Provide the performance environment, monitoring, fault injection, kill drills; sign off AVAIL NFRs |
| Compliance / Risk | Sign off AUDIT and SEC NFRs |

---

## Related pages

- [Performance Test Strategy](performance-test-strategy.en.md) — basis for test types and priority
- [Workload Modeling](workload-modeling.en.md) — where each scenario's load values come from
- [OREO NFR](oreo-nfr.en.md) — pass criteria for each scenario
- [KPI Definitions](kpi-definitions.en.md) — metrics each scenario must report
- [k6 harness README](../../trade-performance/README.md) — primary tool implementation
- [Trade API Performance Test Plan v2](../trade-api-perf-test-plan-v2-jmeter.md) — API inventory, dependency matrix, JMeter legacy implementation
- [Trade Create test cases](../trade-create-perf-testcases-jmeter.md) — the 15 create cases
