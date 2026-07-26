# Performance Test Strategy (OREO)

> **Confluence location**: Testing & Quality → Specialized Testing → Performance Testing → 1. Strategy & Workload Model
> **System**: OREO — Optimized Real-time Execution Orchestrator (FX structured products, full trade lifecycle)
> **Status**: Draft v0.2 · **Owner**: TBA · **Reviewers**: one each from Architecture / Backend / Frontend / QA
> **Update trigger**: architecture change, real traffic data after go-live, retrospective after each major release
> **中文**: [performance-test-strategy.zh.md](performance-test-strategy.zh.md)

---

## 1. Purpose and scope

This page defines OREO's overall performance-testing strategy: what we test, when, and how pass/fail is decided. All performance activity — API load testing, frontend performance, CI performance gates — derives from this page.

**In scope**: all API paths behind the Trade Portal and Composer pages, the four-eyes approval chain, `.dat` parsing and risk computation paths, batch-vs-online interference, frontend web load and long-running performance, CI performance gates.

**Out of scope** (separate initiatives where applicable): the performance of the third-party refdata source itself; the internal performance of the UC / risk-engine / notification downstreams (this page only tests their *effect* on OREO); the WebSocket push channel (a current gap — see [v2 plan](../trade-api-perf-test-plan-v2-jmeter.md) Appendix C-1).

---

## 2. System performance profile — why neither the generic-web nor the retail-trading playbook applies

[Workload Modeling](workload-modeling.en.md) §1 concludes: **OREO's peak TPS is in the single digits, and ambient polling load exceeds peak business load by roughly 280×.** That invalidates two common methodologies at once.

| Characteristic | What it means | What testing must do |
|---|---|---|
| **Low throughput, high unit cost** | 120 bookings/day, but each carries `.dat` parsing and risk computation | **Profile per-request cost, don't hunt TPS knees.** Ramping load will never reveal "one parse consumes 3 GB of heap" |
| **Two-phase write path** | maker submits → `pending approve` lock → checker acts, with a human interval between | Time submit and approve **separately, with separate SLAs**; a stitched-together number has no business meaning |
| **Reject costs more than approve** | Reject performs snapshot restore + audit write | The load model must include the reject path, not just approve |
| **Same-entity contention** | Concurrent events on one trade block each other | Needs a purpose-built "same-target concurrency" scenario; the usual one-trade-per-thread design can never surface it |
| **Read amplification** | 4 blotters × 200 rows per page, possibly with per-row UC gRPC enrichment | **Audit the fan-out factor**: one frontend request = how many downstream calls? |
| **Data-volume sensitivity** | 250k trades at 3 years; the blotter is a range query | Empty-database results are invalid. Test at **target data volume**, and at several volume tiers |
| **In-process CPU/memory competition** | `.dat` parsing shares the process with every API | Large-file parsing slows down **endpoints with no business relationship to it**; needs cross-interference scenarios |
| **Coexisting batch jobs** | trade-aging, sync-cashflows, refdata sync run alongside online traffic | Online degradation during batch windows is its own test dimension |
| **Long trading day** | Cross-timezone; users idle for hours with blotters auto-refreshing | Soak ranks **above** Spike: connection leaks, memory growth, slow backlog |
| **Audit must not be lost** | Every state transition must be attributable and traceable | Audit writes must not be dropped or degraded under load — a correctness requirement, not a performance one |

**Three retail assumptions explicitly ruled out for OREO:** market-open pulse (OREO peaks at booking cutoff and month-end) · high connection concurrency (users number in the tens) · market-data push floods (no such channel).

---

## 3. Layered testing strategy

| Layer | Question answered | Variables | Tool | Details |
|---|---|---|---|---|
| API | How expensive is one request, what is the latency distribution at target capacity, how large is the fan-out | Input size, data volume, concurrency | **JMeter** | [v2 plan](../trade-api-perf-test-plan-v2-jmeter.md), `qa/trade-performance/` |
| Frontend | How fast do 4 blotters × 200 rows render; does an hours-long session degrade | Row count, refresh interval, session length | Playwright + CDP | Frontend / Web Performance |
| Combined | What real user experience looks like while the backend is at target load | Both, superimposed | JMeter load + 3–5 Playwright sessions | [Test Plan](oreo-performance-test-plan.en.md) S-08 |

The three layers do not substitute for each other: passing at the API layer does not mean the UI is smooth (DOM updates for 200 rows × 4 blotters is a frontend problem), and a smooth UI does not mean the server survives a concurrent batch job.

**Tool choice**: the API layer uses JMeter rather than k6 because OREO's core paths need multipart `.dat` upload, cross-thread-group maker→checker data handoff, and direct reuse of a large body of existing curl assets; see [v2 plan](../trade-api-perf-test-plan-v2-jmeter.md) Appendix B. **The implemented harness lives in `qa/trade-performance/`.**

---

## 4. Test types and priority

OREO's type list departs from the generic template: **the top three are the main event, and traditional Stress / Spike are demoted.**

| Priority | Type | Question answered | Load shape | Why it matters for OREO |
|:---:|---|---|---|---|
| — | **Smoke** | Do the script and system work at all | 1 thread, 1 iteration | Every script change; first step of every round |
| **1** | **Cost Profile** | How much CPU / memory / time does **one** request consume | **1 concurrent**, sweep input-size tiers | OREO's top risk. The peak memory of one large `.dat` parse sets the resource floor for the entire service |
| **2** | **Volume Scaling** | Does it degrade as data grows | Fixed load, sweep data volume (1k / 50k / 250k trades) | The blotter is a range query; P95 on an empty DB and at 250k rows can differ by an order of magnitude |
| **3** | **Fan-out Audit** | How many downstream calls does one frontend request cause | Single request + downstream call counting | If blotter enrichment is N+1, 33 TPS of lists = 6,600 QPS of gRPC. This is the **only** path that can push OREO into three-digit QPS |
| **4** | **Load** | Does it meet the NFR at target capacity | Ramp to design capacity, hold 30 min | Still required, but the numbers are low (see Workload Modeling §6) |
| **5** | **Contention** | Do concurrent operations on one trade deadlock, block, or lose updates | **Low concurrency (5–20) against the same target** | The four-eyes `pending approve` lock; a blind spot of conventional load testing |
| **6** | **Interference** | How much do online endpoints degrade while batch jobs / large parses run | Background job + online load in parallel | `.dat` parsing shares the process with the APIs; batch jobs share the DB |
| **7** | **Soak** | Does a long trading day degrade it | Design capacity for 4–8 hours | **Ranks above Spike**: blotter auto-refresh runs constantly all day, so connection and memory leaks are a real risk |
| 8 | **Spike** | Can bursts be absorbed | Bursts shaped like checker batch queue-clearing | Only for `bulk-approve` and cutoff clustering; **no retail-style 20× pulse** |
| 9 | **Stress** | Where and how does it break | Ramp beyond peak | Demoted to "understand overload behaviour"; not a basis for capacity conclusions |
| 10 | **Capacity** | What is the architecture's ceiling | Incremental load + scaling comparison | Redo after go-live with real data; low value now |

**Progression rule (no skipping):**
```
Smoke → Cost Profile → Volume Scaling → Fan-out Audit → Load → the rest
```
Putting Cost Profile before Load is deliberate: **applying concurrency without knowing per-request cost yields a number you cannot attribute.** Only once you know a large parse takes 3 seconds and 2 GB can you explain why it dies at 3 concurrent.

---

## 5. Trigger rules — what changes mandate a performance test

| Trigger | Minimum requirement |
|---|---|
| Every merge (PR) | CI performance smoke (JMeter low load + frontend bundle-size gate), automated |
| **`.dat` parsing logic or dependency change** | **Full-tier Cost Profile + peak-memory comparison vs baseline.** OREO's most fragile link |
| **Blotter query / UC enrichment logic change** | Volume Scaling (three tiers) + Fan-out Audit |
| Four-eyes workflow change (including **a new event type migrating into the approval flow**) | Re-test the two-phase path + Contention scenario |
| Snapshot / audit-write logic change | Contention scenario + audit-completeness check (see [NFR](oreo-nfr.en.md) §4) |
| Data model / index / SQL change | Volume Scaling for affected endpoints, focused on target data volume |
| Frontend polling interval change (A11 / A12) | Recompute Workload Modeling §5 and re-run Load |
| Middleware / dependency upgrade (DB, gRPC, JVM) | One Load + Soak regression round |
| Batch logic change (trade-aging, sync-cashflows, refdata sync) | Interference scenario |
| Composer product-definition / lifecycle-config logic change | Interference scenario on the config-cache invalidation path |
| Frontend framework upgrade / blotter component change | Frontend load performance + long-session Soak |
| Pre-release (every major version) | Full round: Smoke → Cost Profile → Volume Scaling → Fan-out → Load → Contention → Interference → Soak, with a formal report |

---

## 6. Pass / fail principles

1. **A load test without pass/fail criteria is a demo, not a test.** Every scenario needs written thresholds before execution — thresholds come from [OREO NFR](oreo-nfr.en.md), definitions from [KPI Definitions](kpi-definitions.en.md).
2. **Criteria live in the script**: encoded as JMeter assertions + `scripts/assert-sla.py` (or Taurus `passfail`), so execution decides automatically rather than depending on someone reading a report.
3. Choose one comparison target and state it in the report: against the **NFR** (absolute) or against a **baseline** (relative, e.g. P95 regression >10% fails).
4. **Latency conclusions must be presented alongside error rate** — a system that fails fast "looks faster".
5. **Three error classes counted separately** (technical / business / script), see KPI Definitions §1.3. **Script error rate must be 0**; a non-zero value means the round is untrustworthy, and "passing after deducting script errors" is not a permitted conclusion.
6. **Correctness red lines outrank performance red lines**: if any round produces inconsistent trade state, a snapshot restore that drops fields, or a missing audit record, the round **fails regardless of latency**, and correctness must be fixed before performance is discussed again.

---

## 7. Method discipline

- **One variable at a time**: change only load, or code version, or config, or data volume — otherwise results cannot be attributed.
- **Warm up before measuring**: start the measurement window only once caches, JIT, and connection pools are ready.
- **Seed data to volume**: data volume must reach the scale assumed in [Workload Modeling](workload-modeling.en.md) A16. **Empty-database results are invalid** — especially fatal for OREO, because the blotter is a range query.
- **Repeatable**: re-run key conclusions; a >10% P95 difference between runs is noise and must be investigated before any conclusion is drawn.
- **Declare the environment**: results from a non-proportional environment must state the scale-down ratio and conversion assumptions.
- **Reference-data freshness**: counterparty / portfolio arrive via a sync batch job from a third party and are **outside test control**. Every run must resolve them in setUp and archive a snapshot; otherwise stale data manifests as "HTTP 200 + wholesale business rejection", which reports as a 0% error rate. See [v2 plan](../trade-api-perf-test-plan-v2-jmeter.md) §4.4.
- **Never** load-test production or third-party services (including the refdata source) without authorisation and coordination.

---

## 8. Current phase (asset-building)

There is no dedicated performance environment yet. All current work targets "ready to run on day one once the environment exists":

| Work item | Status |
|---|---|
| JMeter harness skeleton (four-layer architecture, three-dimension orthogonality, run.sh, static validation) | ✅ Built — see `qa/trade-performance/` |
| create-trade single-API + E2E journey scripts | ✅ Built |
| Workload model and assumption register | ✅ Established this round ([Workload Modeling](workload-modeling.en.md)) |
| NFR and acceptance thresholds | ✅ Established this round ([OREO NFR](oreo-nfr.en.md)); values await business sign-off |
| Scenario library (18 scenarios) | ✅ Established this round ([Test Plan](oreo-performance-test-plan.en.md)). **S-03 implemented; S-01 has a script but no memory collection (partial); the other 16 pending** |
| Frontend polling parameter confirmation (A10–A12) | ⚠️ **Blocker, highest priority** |
| Data factory (seed 250k trades) | ⚠️ Not built |
| Observability prerequisites (gRPC fan-out counters, parse memory instrumentation) | ⚠️ Not yet requested |
| CI smoke against baseline | ⚠️ Not built |

**Results from a functional environment are only used for trend comparison and to expose implementation-level problems; they are never extrapolated to production capacity.**

---

## Related pages

- [Workload Modeling](workload-modeling.en.md) — how much load
- [OREO NFR](oreo-nfr.en.md) — pass criteria
- [OREO Performance Test Plan](oreo-performance-test-plan.en.md) — scenario library and execution plan
- [KPI Definitions](kpi-definitions.en.md) — metric definitions
- [Trade API Performance Test Plan v2](../trade-api-perf-test-plan-v2-jmeter.md) — API inventory and JMeter implementation
