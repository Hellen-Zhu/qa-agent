# KPI Definitions (OREO)

> **Confluence location**: Testing & Quality → Specialized Testing → Performance Testing → 1. Strategy & Workload Model
> **System**: OREO — Optimized Real-time Execution Orchestrator
> **Status**: Draft v0.2 · **Owner**: TBA
> **中文**: [kpi-definitions.zh.md](kpi-definitions.zh.md)
>
> **Rule**: every load-test report, CI gate, and NFR document must use the definitions on this page. Without shared definitions two reports cannot be compared — changes here require review and must state which report version they take effect from.
>
> **This page defines only *how* things are measured, never *what value passes*.** Thresholds live in [OREO NFR](oreo-nfr.en.md); load levels in [Workload Modeling](workload-modeling.en.md).

---

## 1. General API-layer metrics

### 1.1 Response time (RT)

- **Measurement points**: first byte sent by the load generator → last byte of the response received (JMeter's `elapsed`). **Excludes think time.**
- **`elapsed` vs `Latency`**: JMeter's `Latency` is time-to-first-byte; `elapsed` is the full response time. **Upload endpoints (`.dat`-related) must report both** — `elapsed - Latency` is server processing plus response transfer time, which separates "slow upload" from "slow parse".
- **Reporting**: **P50 / P90 / P95 / P99. The mean must not be used as an SLA basis** — averages hide the tail, and the tail is what users complain about. Report max separately for spike analysis, with no threshold attached.
- **Segment latency**: when end-to-end misses target, use distributed tracing to split across API Service / UC gRPC / risk-engine gRPC / DB, each segment measured entry-to-exit.

### 1.2 Throughput (TPS / RPS)

- **TPS**: transactions per second that **complete and pass business validation**. Requests returning HTTP 200 with a business-rejected status **do not count** toward effective TPS (especially important on OREO: stale reference data produces large volumes of 200-with-rejection).
- **RPS**: HTTP requests per second including failures — describes offered load only, never a pass conclusion.
- Reports must state the load-generation mode: **constant arrival rate** or **fixed thread count**. The two behave differently once the system slows and cannot be compared.
- ⚠️ **OREO's TPS numbers are inherently low** (single-digit design capacity, see Workload Modeling §6). **Do not read low TPS as "good performance"** — it only reflects small business volume. OREO's capacity conclusions come from the §2 metrics.

### 1.3 Error rate — three separate classes

Three classes, **counted separately and presented side by side**. Any one exceeding threshold fails the round:

| Class | Definition | Counts toward SLA | Verdict |
|---|---|:---:|---|
| **Technical** | HTTP 5xx, timeout, connection reset, pool exhaustion | **Yes** | NFR violation; locate and fix |
| **Business rejection** | HTTP 200 but business status rejected (risk check failed, stale reference data, state machine disallows) | No | Track as a separate "rejection rate"; **any anomalous swing must be investigated** |
| **Script** | Extractor NOT_FOUND, unresolved variable, missing template | No | **Must be 0.** Non-zero means the round is untrustworthy |

**Why three classes are mandatory**: a report with one blended error rate is unusable — does 12% mean call a developer (technical), fix the data (business rejection), or fix the script? Three conclusions, three entirely different actions.

Implementation: `qa/trade-performance/k6/lib/errors.js`; the classification lands in the `oreo_ok` / `oreo_err_technical` / `oreo_err_business` / `oreo_err_script` metrics and the `errClass` tag of the result csv.

### 1.4 Knee point

The load level at which **latency begins climbing persistently while throughput stops growing proportionally**. The report must attach saturation evidence (§4) showing which resource is the constraint.

> On OREO the knee point has limited practical value (design capacity sits far below it) and is used only to understand overload behaviour. See the demotion of Stress in [Strategy](performance-test-strategy.en.md) §4.

---

## 2. OREO-specific metrics (**the core of this page**)

The generic template has no concept of these, yet they are where OREO's capacity conclusions come from.

### 2.1 Two-phase transaction timing (four-eyes)

An approval-required event spans two business transactions separated by a **human interval**:

| Metric | Definition | Notes |
|---|---|---|
| `TX_Event_Submit` | Maker submits → response received (trade now `pending approve`) | System latency; has an SLA |
| `TX_Event_Approve` | Checker clicks approve → response received (event executed) | System latency; has an SLA |
| `TX_Event_Reject` | Checker clicks reject → response received (restored from snapshot) | **Tracked separately**; usually slower than approve |
| `TX_Notify_Delivery` | `checker_tasks` write → task visible in the checker's `unread-count` | System latency; has an SLA |
| **Time-to-Approve** | Maker submits → checker completes | **A business metric including the human interval. No system SLA.** |

**Hard rule: `TX_Event_Submit` and `TX_Event_Approve` must never be summed or stitched into one end-to-end transaction.** The gap between them is set by a person (minutes to hours); a combined figure mostly reflects when the checker went to lunch, not system performance.

Time-to-Approve is still measured, but as a **business-process efficiency** metric answering "can the checker team keep up with maker submission rate" (see the queue metrics in §2.5). It is not a performance acceptance criterion.

### 2.2 Fan-out factor

```
fan-out factor = downstream calls triggered by one frontend API request
```

Counted separately for: **UC gRPC calls** / **risk-engine gRPC calls** / **DB queries** / **notification gRPC calls**.

| Result | Meaning |
|---|---|
| Fan-out = O(1) | Independent of returned row count — healthy |
| Fan-out = O(n), n = returned rows | **N+1 problem.** A 200-row blotter means 200 downstream calls |

**This is OREO's single most important metric.** If blotter enrichment is N+1, 33 TPS of list queries generates 6,600 QPS of UC gRPC traffic — the only path that can push OREO into three-digit QPS, and the most likely real bottleneck.

Collection: APM trace span counts, or server-side counters. **Must be measured, never inferred.**

### 2.3 Per-request cost (Cost Profile)

For `.dat`-related endpoints (`create`, `dat-to-json`, `calculate-risk-for-new`), measured tier by tier at **1 concurrent**:

| Metric | Definition |
|---|---|
| Parse duration | Reported per file-size tier (small / medium / large) |
| **Peak memory per parse** | Heap after GC before parse → maximum heap during parse, difference |
| **Memory amplification factor** | Peak memory ÷ file size. **Determines the OOM threshold; must not be assumed** |
| CPU time per parse | Process CPU time delta; used to estimate the concurrency ceiling |
| Duration vs file size relationship | Linear or super-linear. **Super-linear is a design-defect signal** |

**Theoretical max concurrent parses = available heap ÷ peak memory per parse.** If that number is below the design concurrency, it is a hard capacity ceiling with no remedy other than more memory.

### 2.4 Latency per unit of work (batch endpoints)

For `bulk-approve` / `bulk-reject` / `trigger-event` / `sync-cashflows-batch` / `trade-aging`:

```
latency per unit of work = total request duration ÷ items in batch
```

Must be measured at **several batch sizes** (e.g. 1 / 5 / 20 / 50) to determine:

| Shape | Meaning |
|---|---|
| Per-unit latency constant | Linear, healthy. Batching only saves round trips |
| Per-unit latency **falls** as batch grows | Batch optimisation present (e.g. bulk SQL) — healthy |
| Per-unit latency **rises** as batch grows | **Super-linear cost** (widening lock scope, over-long transaction, memory accumulation). Batch size needs a cap |

Reports must always state the **batch size** — a batch-endpoint latency figure without it cannot be interpreted.

### 2.5 Queue and backlog metrics

| Metric | Definition | Verdict |
|---|---|---|
| `checker_tasks` pending depth | Count of unapproved tasks over time | **Persistent monotonic growth fails**, regardless of latency figures |
| Task residency distribution | Task created → approved, P50/P95 | Reflects checker-team capacity |
| Notification delivery lag | Task created → visible to checker | See `TX_Notify_Delivery` in §2.1 |

**Backlog is the failure mode of a queue system, not a rate problem.** A system processing 100/s while 101/s arrive may show all-green latency while it is failing.

### 2.6 Transaction naming and nesting

Transaction names carry service and module, so the jtl can be sliced by service with no extra instrumentation:

```
TX_<svc>_<module>_<api>    atomic transaction, 1:1 with §2 here and the PERF-xx NFR IDs
TX_flow_<name>             composite transaction spanning several atomics (e.g. TX_flow_refdata_load)
```

Filtering results by the `name` tag prefix `workers_` answers "how slow is the workers service overall".

**Two binding rules:**

| Rule | Reason |
|---|---|
| **TX_flow_\* and its inner TX_\<svc\>_\* must never be summed** | A composite **contains** its atomics. Summing counts the same work twice and doubles TPS. Pick one level when computing throughput |
| **Filter to `runPhase=main` first** | setUp preflight includes the *same* fragment as the main path, so its transaction names are identical. Without filtering, preflight samples enter capacity statistics — at OREO's single-digit TPS, one extra sample is a several-percent error |

### 2.7 Data-volume scaling

The same load repeated at several data-volume tiers, reporting a **degradation curve** rather than a single point:

| Volume tier | Purpose |
|---|---|
| 1,000 trades | Baseline (approximately empty) |
| 50,000 trades | Mid-life |
| 250,000 trades | Target (Workload Modeling A16) |

Verdict: P95 growth with data volume must be **sub-linear**. If P95 at 250k is more than 10× that at 1k, an index is missing or a full scan is happening.

**Results from an empty database must not be written into conclusions** (see §5.4).

---

## 3. Frontend metrics (lab conditions: uniform 4× CPU throttling — see Frontend Strategy page)

| Metric | Definition | Collection |
|---|---|---|
| LCP | Moment the page's main content (first blotter table on Trade Portal) finishes rendering | PerformanceObserver |
| INP | Interaction to next paint, taking the worst interaction of the session | PerformanceObserver |
| CLS | Cumulative layout shift score | PerformanceObserver |
| **Blotter first render** | List response arrives → table rows painted, **reported per row-count tier** (50 / 200 / 500) | Custom marks |
| **Blotter refresh jank** | Dropped frames caused by auto-refresh, and whether scroll position is lost | CDP tracing |
| **Right-click menu latency** | Right-click → menu interactive | Custom marks |
| **Lifecycle event submit interaction latency** | Click submit → state shows `pending approve` and the UI reflects it (P95) | Custom marks, `performance.mark/measure` |
| Frame drop rate | Dropped frames ÷ frames due (60fps basis), **tiered by blotter count and refresh interval** | CDP tracing |
| Long tasks | Count of main-thread tasks >50ms; >200ms listed individually | CDP tracing |
| **Long-session memory growth** | Soak JS heap: end value − stable baseline (excluding first 10 min warm-up); **read after GC** | CDP `performance.memory` |
| Bundle size | Gzipped size of first-paint critical-path JS | size-limit (build time) |

> **A loading spinner does not count as "complete."** The end point of an interaction latency must be the moment the user can see the result, not the moment the request was sent.

> OREO's distinctive frontend risk is **long sessions plus constant auto-refresh**: users idle for hours while blotters repaint every 30 seconds. Memory growth and frame drops are the primary observations, ranking above first-paint load.

---

## 4. Saturation metrics (server side)

| Resource | What to watch | Empirical alert line\* |
|---|---|---|
| CPU | Node utilisation + run queue | Sustained >75% is near saturation |
| **Heap memory** | RSS trend + GC frequency/pause | **A GC pause reaching the same order as P99 latency is the bottleneck.** Especially relevant on OREO due to `.dat` parsing |
| **Peak heap** | Single peak, not the mean | `.dat` parsing allocates in pulses; the mean hides the risk entirely |
| DB connection pool | Active/max ratio + waiters | Record any waiting |
| **gRPC pools / channels** | Concurrent streams and queuing, counted separately for UC and risk-engine | First thing to exhaust when fan-out amplifies |
| **DB lock waits** | Lock wait count and duration, per table | Where OREO's `pending approve` lock contention shows up |
| Message queue | Backlog depth trend | Persistent growth fails regardless of latency |
| DB slow queries | Slow query count | Every new slow query during a test **must be explained individually** |

\* Alert lines are analysis aids, not pass criteria. Pass criteria come only from the thresholds in [OREO NFR](oreo-nfr.en.md).

---

## 5. Measurement validity conditions

Data failing any of these is reference-only and **must not be written into conclusions**:

1. **Measure after warm-up**: start the window only once caches, JIT, and connection pools are ready (exclude the ramp; for frontend, exclude the first cold load and report cold/warm separately).
2. **One variable**: only one difference from the comparison data set.
3. **Repeatable**: re-run key conclusions; a >10% P95 difference is noise and must be investigated (load-generator capacity? noisy neighbour? data skew?) before concluding.
4. **Data volume met**: seeded data reaches the scale assumed in [Workload Modeling](workload-modeling.en.md) A16. **Empty-database results are invalid** — OREO's blotter is a range query, so empty-DB P95 has no reference value.
5. **Reference data verified usable**: counterparty / portfolio must be validated in setUp by actually creating a trade. A query returning 200 does not prove the data is usable in business terms (a counterparty deactivated by the third party still returns from a query). Runs where preflight failed are void.
6. **Script error rate is 0**: non-zero voids the round; passing "after deducting script errors" is not permitted.
7. **Declare the environment**: state the scale-down ratio for non-proportional environments; conclusions are trend and relative comparison only.
8. **Batch endpoints state batch size**, **upload endpoints state file-size tier**, **list endpoints state data volume and returned row count** — a figure missing any of these cannot be interpreted.

---

## 6. Presentation rules

- **Standard result table** (uniform across all reports):

  | Stage | Load | RPS | Effective TPS | P50 | P95 | P99 | Technical err% | Business rej% | Script err% |
  |---|---|---|---|---|---|---|---|---|---|

- **OREO-specific columns** appended per scenario: fan-out factor · latency per unit of work · batch size · file tier · data-volume tier · peak memory.
- **Percentiles cannot be averaged**: P95 values from different generators or time windows must not be merged by averaging — re-aggregate from raw samples or histograms.
- Trend charts start the y-axis at 0; **latency and error-rate charts must be placed side by side**.
- **Low-TPS scenarios must present resource usage alongside.** "0.1 TPS passed" carries no information on OREO; "heap at 3.2 GB while serving 0.1 TPS" is the conclusion.
- CI smoke reports only "pass/fail + regressions"; full distributions go to a time-series store for trend queries.
- Slicing results by dimension relies on low-cardinality tags (`runPhase` / `caseId` / `productType`, …); the current set is documented in the `qa/trade-performance/k6/lib/errors.js` header (⚠ high-cardinality values such as tradeId never become tags).

---

## 7. Current gaps

| Gap | Impact |
|---|---|
| **WebSocket metrics undefined** | create / trigger-event trigger WS pushes, currently untested. Push latency, connection capacity, and backlog definitions are outstanding (see [v2 plan](../trade-api-perf-test-plan-v2-jmeter.md) Appendix C-1) |
| **No collection mechanism for fan-out factor** | Requires server-side APM traces or counters — an observability prerequisite, not yet requested |
| **No collection mechanism for parse peak memory** | Requires JVM instrumentation or JFR, not yet requested |
| gRPC saturation metrics | Need to confirm whether UC / risk-engine expose pool and stream metrics |

---

## Related pages

- [Performance Test Strategy](performance-test-strategy.en.md) — which test types these metrics serve
- [Workload Modeling](workload-modeling.en.md) — where the capacity-table figures come from
- [OREO NFR](oreo-nfr.en.md) — the actual thresholds (this page defines measurement only)
- [OREO Performance Test Plan](oreo-performance-test-plan.en.md) — which metrics each scenario must report
