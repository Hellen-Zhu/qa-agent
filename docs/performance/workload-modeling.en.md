# Workload Modeling (OREO)

> **Confluence location**: Testing & Quality → Specialized Testing → Performance Testing → 1. Strategy & Workload Model
> **System**: OREO — Optimized Real-time Execution Orchestrator (FX structured products, full trade lifecycle)
> **Status**: Draft v0.2 · **Owner**: TBA · **Sign-off**: Business Ops (A1–A9 values), Frontend (A10–A13 polling parameters), Architecture (capacity targets)
> **Update trigger**: recalibrate monthly against real traffic after go-live, then quarterly / per major release
> **中文**: [workload-modeling.zh.md](workload-modeling.zh.md)
>
> ⚠️ The system is pre-launch. Every figure on this page is an **assumption-driven v0 model**. Each assumption is registered in §4 with a status flag.
> **No unconfirmed figure may be used as an acceptance criterion.**

---

## 1. The most important conclusion: OREO is not a throughput problem

This goes first because it determines how everything downstream is tested.

Deriving from the v0 assumptions in §4 (52 named users, 120 bookings/day), OREO's load decomposes as:

| Load source | Steady-state TPS | Nature |
|---|---:|---|
| Blotter auto-refresh (31 concurrent × 4 blotters ÷ 30s) | **4.13** | Constant, independent of business volume |
| Notification polling `/notifications/unread-count` (÷ 15s) | **2.07** | Constant, independent of business volume |
| User-initiated blotter opens | 0.14 | Tracks user activity |
| **New booking (cutoff-hour peak)** | **0.013** | One every 75 seconds |
| Lifecycle event (cutoff-hour peak) | 0.009 | — |

**Ambient load (6.20 TPS) exceeds peak business load (0.022 TPS) by roughly 280×.**

> Definition: the numerator is blotter auto-refresh + notification polling (4.13 + 2.07); the
> denominator is cutoff-hour booking + lifecycle events (0.0133 + 0.009). User-initiated blotter
> opens (0.14) are excluded from both, being neither timer-driven nor a business write. §5.2
> re-derives this with the same definition.

Three unavoidable consequences:

1. **OREO's system-wide peak TPS is in the single digits.** Testing it with the retail playbook — "ramp to 1,200 TPS and find the knee" — yields an all-green report with no information in it, because the system will never see that load.
2. **The busiest endpoint is a polling endpoint that returns a number.** `unread-count` and blotter auto-refresh together account for roughly **97%** of request volume (`unread-count` alone is 33%) while carrying no business value. **Frontend polling intervals (A11 / A12) are a stronger capacity lever than headcount** — relaxing blotter refresh from 30s to 60s removes roughly a third of total system load.
3. **The risk is not "how many per second" but "how expensive is one".** A single large `.dat` parse may consume gigabytes of heap and stall the whole JVM; a 200-row blotter query, if UC enrichment is N+1, is 200 gRPC calls. These break at 1 TPS, and **ramping load is not how you find them**.

**OREO's testing therefore centres on** (see [Performance Test Strategy](performance-test-strategy.en.md) §3):

> per-request resource cost · data-volume scaling · downstream fan-out amplification · low-concurrency contention · batch-vs-online interference · long-run stability

**Not**: high-TPS knee points · spike absorption · large-scale connection concurrency.

---

## 2. Modelling method

Having no production data does not mean you cannot model. The method is to **substitute assumptions for data, but register every assumption explicitly**:

1. Split load into **three components** (§3), because their drivers and remedies differ entirely;
2. Register each business assumption with its value, basis, and confirmation status (§4);
3. Derive capacity targets from the assumptions using one formula set (§5);
4. Produce the target capacity table that drives load generation (§6);
5. Replace assumptions with real data after go-live and bump the model version (§8).

### 2.1 Key differences from retail trading system modelling

| Dimension | Retail derivatives platform | **OREO** |
|---|---|---|
| User scale | Hundreds of thousands of clients | **Tens of named users** (makers + checkers) |
| Load driver | Client count × order frequency | **Frontend polling interval** + a small number of high-value operations |
| Peak cause | Market-open pulse, volatility spikes (10–30×) | **Booking cutoff, month/quarter-end roll, checker batch queue-clearing** (3–5×) |
| Per-request cost | Uniform, lightweight | **Highly skewed**: `.dat` parsing and risk computation are orders of magnitude costlier than queries |
| Write-path shape | Single-phase (order → fill) | **Two-phase** (maker submits → lock → checker approves), see §3.2 |
| Primary capacity constraint | CPU / network throughput | **Peak memory, gRPC fan-out, DB locks, query plans at data volume** |

Copying the retail model **overestimates throughput needs and underestimates per-request cost simultaneously** — wrong in both directions, and the two errors mask each other.

---

## 3. The three load components

### 3.1 Decomposition

| Component | Definition | Driver | Relationship to business volume |
|---|---|---|---|
| **A. Ambient** | Frontend timed polling and auto-refresh | Concurrent users ÷ polling interval | **None.** Generated even by idle users with a tab open |
| **B. Business** | Bookings, lifecycle events, approvals | Trade volume | Correlated, clustered around cutoff |
| **C. Compute** | `.dat` parsing, risk computation | Booking volume × file-size distribution | Correlated, but with **very high variance** |

They are modelled separately because their **remedies are mutually exclusive**. Reducing A means tuning polling intervals (a one-line frontend config change); reducing B is impossible (it is the business); reducing C means algorithmic work and resource isolation. Collapsed into a single "total TPS", you cannot tell which lever to pull.

### 3.2 The two-phase write path (modelling consequences of four-eyes)

OREO applies four-eyes control to high-risk lifecycle events, which splits the write path into two shapes:

```
[APPROVAL REQUIRED]  new booking / amendment / cancellation
  maker submits ──► trade locked in `pending approve`
                    ├─ write to checker_tasks
                    ├─ notify checker
                    └─ store pre-execution snapshot
                           ↓   ← human interval: minutes to hours, NOT system latency
  checker acts ──┬─ approve ──► event executes → trade state updated → confirmation sent
                 └─ reject  ──► event cancelled → restore from snapshot → write audit log

[NO APPROVAL YET]  novation / step-in / step-out (partial|full) / early termination /
                   partial novation (+remaining) / portfolio reassignment / allocation
  maker submits ──► executes directly
```

**Four modelling consequences:**

1. **One approval-required event produces 2 business transactions and roughly 6 API calls**, separated by a human interval. Load tests **must not** stitch submit and approve into one continuous timed transaction — that number has no business meaning (it is mostly determined by when someone goes to lunch). The two must be **timed separately with separate SLAs**.
2. **Reject costs more than approve.** Approve follows the normal execution path; reject additionally performs snapshot restore plus an audit write. Testing only approve systematically underestimates approval-path cost. Rejection rate (A8) is therefore a mandatory registered assumption.
3. **The `pending approve` lock is a contention dimension.** Concurrent events against the same trade block each other. Conventional load tests where every thread targets a different trade will **never** surface this; it needs a purpose-built scenario (Test Plan S-05).
4. **`checker_tasks` is a queue that can back up.** If makers submit 143 approval-required events/day and the checker team cannot clear that many, the queue grows monotonically. This is a capacity problem but not a TPS problem — its metrics are **queue-depth trend** and **time-to-approve**, see [NFR](oreo-nfr.en.md) §6.

> ⚠️ The background states that novation / step-out / early termination and others do **not currently** (as of 2026-07) require approval — but the wording is "not **yet**". §4.3 must be structured so that migrating those events into the approval flow requires **changing one column**, not rewriting the model.

### 3.3 Blotter: request amplification from multiple blotters

The Trade Portal page contains **multiple trade blotters**, each issuing an independent list query. Therefore:

```
List queries per page load = blotters per page (A10)
Steady-state list-query TPS = concurrent users × blotters per page ÷ auto-refresh interval (A11)
```

**The product of A10 and A11 is OREO's single largest capacity variable.** Four blotters at a 30-second refresh means 8 list queries per user per minute. If the blotter list also performs per-row UC gRPC enrichment (see the checker-enrich path in [v2 plan](../trade-api-perf-test-plan-v2-jmeter.md) §2.2), fan-out amplifies by another order of magnitude — **the only path in this model that could reach three-digit QPS**.

---

## 4. Assumption register

Status flow: ⚠️ Unconfirmed → ✅ Confirmed (business sign-off) → 📊 Calibrated (replaced by real post-launch data).

### 4.1 Users and concurrency

| ID | Assumption | v0 value | Basis | Status |
|---|---|---|---|---|
| A1 | Named makers (traders / sales) | 40 | Single-desk scale, illustrative | ⚠️ Unconfirmed |
| A2 | Named checkers (middle office / risk) | 12 | maker : checker ≈ 3 : 1, industry norm | ⚠️ Unconfirmed |
| A3 | Peak simultaneously-online share | 60% | A cross-timezone desk is never fully online at once | ⚠️ Unconfirmed |
| A4 | Browser tabs per user | 1 | If multi-tab is allowed, scale A10's effect accordingly | ⚠️ Unconfirmed |

### 4.2 Business volume

| ID | Assumption | v0 value | Basis | Status |
|---|---|---|---|---|
| A5 | New bookings per day | 120 | Structured products: large notional, low count | ⚠️ Unconfirmed |
| A6 | Lifecycle events per day (excl. booking) | 80 | Routine adjustment of the existing book | ⚠️ Unconfirmed |
| A7 | Event-type mix and approval requirement | See §4.3 | Inferred from business shape | ⚠️ Unconfirmed |
| A8 | **Approval rejection rate** | 5% | The reject path is costlier, see §3.2 | ⚠️ Unconfirmed |
| A9 | Tasks per checker batch (`bulk-approve`) | 20 | The existence of `bulk-approve` itself implies batch working | ⚠️ Unconfirmed |

### 4.3 Event-type mix and approval requirement (A7)

| Event | Entry point | Checker approval | v0 per day | Notes |
|---|---|:---:|---:|---|
| New booking | New Trade button (with `.dat` upload) | ✅ | 120 | Primary source of compute load C |
| Amendment | Detail page / update | ✅ | 15 | |
| Cancellation | Right-click menu | ✅ | 8 | |
| Early Termination | Right-click menu | ❌ **not yet** | 12 | Rises with market volatility |
| Novation Remaining | Right-click menu | ❌ **not yet** | 8 | |
| Partial Novation | Right-click menu | ❌ **not yet** | 10 | |
| Partial Novation Remaining | Right-click menu | ❌ **not yet** | 5 | |
| Step Out Full | Right-click menu | ❌ **not yet** | 6 | |
| Step Out Partial | Right-click menu | ❌ **not yet** | 6 | |
| Step In | Entry point TBC | ❌ **not yet** | 4 | |
| Portfolio Reassignment | Right-click menu | ❌ **not yet** | 4 | |
| Allocation | Right-click menu | ❌ **not yet** | 2 | One trade → many portfolios; **write amplification TBC** |
| **Total requiring approval** | | | **143** | → 143 `checker_tasks` per day |
| **Total not requiring approval** | | | **57** | Single-phase execution |

> `View Details` is a read and does not count as an event, but it is the **most frequently used** right-click item — modelled as part of component A's read path.

### 4.4 Frontend polling parameters (**the most critical group**)

| ID | Assumption | v0 value | Basis | Status |
|---|---|---|---|---|
| A10 | Blotters per Trade Portal page | 4 | Background states "multiple trade blotters" | ⚠️ **Frontend to confirm** |
| A11 | Blotter auto-refresh interval | 30 s | If refresh is actually manual, most of component A vanishes | ⚠️ **Frontend to confirm** |
| A12 | Notification polling interval (`unread-count`) | 15 s | Endpoint is tagged High freq Polling in the v2 inventory | ⚠️ **Frontend to confirm** |
| A13 | Portal opens per user per day | 25 | Repeated intraday checking | ⚠️ Unconfirmed |

> **These four are the highest-priority confirmations in the whole model.** A11 and A12 directly determine ~97% of request volume, and they are **frontend configuration, not business constraints** — cheap to confirm, enormous capacity payoff. If they are actually 5 seconds, total system load jumps roughly 6×. If the blotter is in fact manual-refresh only, component A barely exists and the entire capacity conclusion must be rewritten.

### 4.5 Data volume and compute load

| ID | Assumption | v0 value | Basis | Status |
|---|---|---|---|---|
| A14 | `.dat` file size distribution | small 70% / medium 25% / large 5% | Matches the `trade-performance/data/dat/` tiers | ⚠️ Unconfirmed |
| A15 | Large-tier file size | Assumed 20 MB | **Determines the peak-memory ceiling** | ⚠️ **Unconfirmed** |
| A16 | Trade table size at 3 years | 250,000 rows | A5 × 250 trading days × 3 years + migrated book | ⚠️ Unconfirmed |
| A17 | Default rows per blotter | 200 | **Determines UC gRPC fan-out multiplier** | ⚠️ **Unconfirmed** |
| A18 | `.dat` parse memory amplification factor | To be measured | Parsed object graph ÷ file size | ⚠️ **Must be measured, not assumed** |

### 4.6 Peaks and safety factors

| ID | Assumption | v0 value | Basis | Status |
|---|---|---|---|---|
| A19 | Effective business hours | 10 h / day | Cross-timezone desk | ⚠️ Unconfirmed |
| A20 | Cutoff-hour concentration | 40% of daily bookings in the hour before cutoff | Humans rush the deadline | ⚠️ Unconfirmed |
| A21 | Peak coefficient (cutoff hour / period mean) | **4×** | Manual operation has a speed ceiling; no retail-style 20× pulse | ⚠️ Unconfirmed |
| A22 | Month / quarter-end multiplier | 3× a normal day | Rolls, valuation, portfolio reassignment cluster | ⚠️ Unconfirmed |
| A23 | Design safety factor | 2× peak | Team convention, growth headroom | ⚠️ Unconfirmed |

---

## 5. Formulas and worked example

### 5.1 Formulas

```
[A — AMBIENT]  independent of business volume
concurrent users     = (A1 + A2) × A3
notification TPS     = concurrent users ÷ A12
blotter refresh TPS  = concurrent users × A10 ÷ A11
UC gRPC fan-out QPS  = blotter refresh TPS × A17        ← only if per-row enrichment is N+1

[B — BUSINESS]  clustered around cutoff
booking period mean  = A5 ÷ (A19 × 3600)
booking peak         = A5 × A20 ÷ 3600
approval events/day  = §4.3 total = checker_tasks arrival rate
approval calls/day   = approval events × (1 + A8)       ← approve or reject
batch approval       = A9 tasks per request; a burst shape, not a rate

[C — COMPUTE]
concurrent parses    = booking peak × single-parse duration   ← duration must be measured
peak memory demand   = concurrent parses × A15 × A18

[DESIGN CAPACITY]
design capacity = peak × A21 × A23        (× A22 again for month-end scenarios)
```

### 5.2 Worked example (all v0 illustrative values)

```
concurrent users     = (40 + 12) × 60%         = 31

-- A: AMBIENT --
notification polling = 31 ÷ 15                 = 2.07 TPS   <- constant
blotter refresh      = 31 × 4 ÷ 30             = 4.13 TPS   <- constant
UC gRPC fan-out      = 4.13 × 200              = 826 QPS    (!) the real bottleneck if N+1
component A total                              ~ 6.2 TPS

-- B: BUSINESS --
booking period mean  = 120 ÷ 36,000            = 0.0033 TPS
booking peak         = 120 × 40% ÷ 3600        = 0.0133 TPS = one every 75 s
approval events/day  = 120 + 15 + 8            = 143
approval calls/day   = 143 × 1.05              ~ 150
component B total (peak) = 0.0133 + 0.009      = 0.0223 TPS

-- COMPARISON (same definition as §1) --
A : B = 6.20 : 0.0223 ~ 278 : 1     (the gap widens further once UC fan-out is counted)

-- DESIGN CAPACITY --
booking capacity     = 0.0133 × 4 × 2          ~ 0.11 TPS ~ one every 9 s
month-end booking    = 0.11 × 3                ~ 0.32 TPS
list-query capacity  = 4.13 × 4 × 2            ~ 33 TPS
```

**How to read this correctly**: do not conclude "33 TPS is low, so there is no risk". Look instead at **the resource cost behind each individual booking** and **the potential 6,600 QPS of gRPC fan-out behind 33 TPS of list queries**. OREO's capacity risk lives in the amplification factors, not in the request counts.

---

## 6. Target capacity table (v0 — derived from assumptions; refreshes when they change)

| Target | Design capacity | Latency target | Basis |
|---|---|---|---|
| Blotter list query | 33 TPS | See [NFR](oreo-nfr.en.md) §2 | §5.2, includes auto-refresh |
| `unread-count` polling | 17 TPS | See NFR §2 | 2.07 × 4 × 2 |
| Trade detail + risk-metrics | 8 TPS | See NFR §2 | Inferred from detail open rate |
| **New booking (incl. `.dat` parse)** | **0.11 TPS (0.32 month-end)** | See NFR §2 | §5.2 |
| Lifecycle event submit | 0.08 TPS | See NFR §2 | Derived from A6 |
| Single approve / reject | 0.07 TPS | See NFR §2 | Approval event volume |
| **`bulk-approve` batch** | **20 tasks/batch, 3 concurrent batches** | See NFR §2 | A9; timed per unit of work |
| UC gRPC fan-out (derived) | **826 QPS ⚠️** | — | Primary bottleneck if N+1 holds |
| `checker_tasks` queue depth | No monotonic growth at steady state | See NFR §6 | A queue metric, not a rate metric |
| Trade table volume | Queries meet target at 250,000 rows | See NFR §6 | A16 |
| Concurrent `.dat` parses | 3 concurrent large-tier without OOM | See NFR §10 | A14 / A15 / A18, must be measured |

> **Latency thresholds are never defined on this page.** This page produces "how much load"; thresholds live in [OREO NFR](oreo-nfr.en.md) and measurement definitions in [KPI Definitions](kpi-definitions.en.md). Each page owns one layer, so the same number never appears in three places with three values.

---

## 7. Peak causes (OREO-specific)

A retail system peaks at market open. OREO has four entirely different peak sources, and testing must cover each:

| Peak scenario | Cause | Shape | Test scenario |
|---|---|---|---|
| **Booking cutoff** | Makers rush entries before the value-date deadline | 4× mean within one hour | Test Plan S-02 |
| **Month / quarter-end roll** | Maturity rolls, valuation, portfolio reassignment cluster | 3× a normal day, all day | Test Plan S-07 |
| **Checker batch queue-clearing** | A checker sits down and clears 20 tasks | **Burst, not a rate** | Test Plan S-04 |
| **Market volatility** | Surge in early termination / novation requests | Unpredictable, multiplier TBC | Test Plan S-06 |

**Note the peculiar shape of the checker batch**: it is not "N per second" but "one person clicks through 20 tasks in 30 seconds". A constant-arrival-rate load model cannot reproduce its real behaviour — the risk lies in the **transaction boundary and lock scope of a single `bulk-approve` request carrying 20 tasks**. This is also why `bulk-approve` is classified P0.

---

## 8. Revision mechanism

| Trigger | Action |
|---|---|
| **Frontend confirms polling parameters (A10–A12)** | **Highest priority.** These three determine ~97% of request volume; recompute §5.2 and refresh §6 immediately |
| Confirm large-tier `.dat` size (A15) and blotter row count (A17) | Recompute peak memory and gRPC fan-out; may relocate the bottleneck |
| Measure parse memory amplification (A18) | The one parameter that **may not be assumed**: an OOM threshold cannot be guessed |
| Confirm whether UC enrichment is N+1 | If so, 826 QPS becomes the primary capacity constraint and needs architecture review |
| Business review | Sign off A1–A23 line by line; flip status to ✅ |
| Novation etc. migrate into the approval flow | Change only the approval column in §4.3 and recompute; structure unchanged (see note in §3.2) |
| 1 month after go-live | Replace assumptions with gateway logs + RUM, flip to 📊, bump model to v1; refresh capacity table and NFR together |
| Quarterly / major release | Re-run §5; a >20% deviation triggers a capacity review |

---

## Related pages

- [Performance Test Strategy](performance-test-strategy.en.md) — when we test and what types
- [OREO NFR](oreo-nfr.en.md) — the acceptance thresholds for the capacity targets on this page
- [OREO Performance Test Plan](oreo-performance-test-plan.en.md) — the scenario library this model drives
- [KPI Definitions](kpi-definitions.en.md) — the shared definitions behind TPS / P99 in these tables
- [Trade API Performance Test Plan v2](../trade-api-perf-test-plan-v2-jmeter.md) — API inventory and JMeter implementation
