# OREO Non-Functional Requirements

> **Confluence location**: Testing & Quality → Specialized Testing → Performance Testing → 2. NFR & Pass/Fail Criteria
> **System**: OREO — Optimized Real-time Execution Orchestrator (FX structured products, full trade lifecycle)
> **Status**: Draft v0.1 · **Owner**: TBA
> **Sign-off**: Architecture (technical items), Business Ops (latency and capacity targets), Compliance/Risk (§4 §5 §6), Operations (§3 §8)
> **Update trigger**: architecture change, workload-model revision, change to four-eyes scope, calibration against real post-launch data
> **中文**: [oreo-nfr.zh.md](oreo-nfr.zh.md)

---

## 0. How to read this document

### 0.1 Numbering and status

Every requirement has a unique ID (e.g. `NFR-PERF-03`) so test cases, defects, and review records can reference it.

| Status | Meaning |
|---|---|
| 🟡 **Proposed** | A value proposed by QA from the business shape. **Not yet signed off; must not be used as an acceptance criterion** |
| 🟢 **Confirmed** | Signed off; usable as an acceptance criterion |
| 🔵 **Calibrated** | Revised with real post-launch data |

**Every item in this document is currently 🟡 Proposed.** Proposed values are not placeholders — each carries its derivation, so a sign-off party can change the number without re-arguing the structure.

### 0.2 Verification tags

Writing a requirement down does not make it verifiable. Each requirement is tagged with **the activity that verifies it**:

| Tag | Meaning | Who runs it |
|---|---|---|
| **PT** | Verifiable by performance test ([Test Plan](oreo-performance-test-plan.en.md) scenario) | QA, k6 suite (see plan §1.1) |
| **FT** | Verifiable by functional test | QA, functional automation |
| **AR** | Requires architecture review (cannot be proven black-box) | Architecture |
| **OPS** | Requires an operational drill (fault injection, recovery exercise) | Operations + QA |
| **NV** | **Not currently verifiable** — a required capability or environment is missing | Capability must be built first, see §12 |

The **NV** items are the most important part of this document: they mark exactly where we have stated a requirement we currently cannot prove.

### 0.3 Source of thresholds

- **Load levels** behind latency and throughput targets come from [Workload Modeling](workload-modeling.en.md)
- **Measurement definitions** come from [KPI Definitions](kpi-definitions.en.md)
- This page defines **thresholds only**. No number is defined in more than one place.

---

## 1. Quality model and priority

### 1.1 OREO's non-functional priority order

**This order differs from most systems and needs stating explicitly:**

```
1. Data integrity      <- a half-executed trade is far worse than a slow blotter
2. Auditability        <- the entire value of four-eyes rests on provability after the fact
3. Access control      <- if identity can be forged, four-eyes collapses entirely
4. Availability        <- unavailability during the trading day blocks business directly
5. Performance         <- important, but ranks below the four above
6. Everything else
```

**Rationale**: OREO is a trading system governed by four-eyes control. The output of four-eyes is a **provable control record**, not speed. A system whose P95 is 500 ms slow gets complaints; a system that loses an approval record or drops a field during snapshot restore causes regulatory exposure and real losses.

**This order has an executable consequence** (see [Strategy](performance-test-strategy.en.md) §6.6): if any performance round produces inconsistent state, a snapshot restore that drops fields, or a missing audit record, the round **fails regardless of latency**, and correctness must be fixed first.

### 1.2 Quality attributes covered

| § | Attribute | Items | Primary sign-off |
|---|---|---:|---|
| 2 | Performance | 21 | Business Ops + Architecture |
| 3 | Availability & Continuity | 6 | Operations + Business |
| 4 | Data Integrity | 7 | Architecture + Risk |
| 5 | Auditability & Compliance | 6 | Compliance + Risk |
| 6 | Security & Access Control | 6 | Architecture + Compliance |
| 7 | Scalability & Capacity | 5 | Architecture |
| 8 | Observability | 5 | Architecture + Operations |
| 9 | Degradation & Resilience | 6 | Architecture |
| 10 | Maintainability & Configurability | 4 | Architecture + Product |
| 11 | Resource Ceilings | 4 | Architecture + Operations |

---

## 2. Performance (NFR-PERF)

### 2.1 Latency thresholds — read paths

Timing definitions in [KPI Definitions](kpi-definitions.en.md) §1.1; load levels in [Workload Modeling](workload-modeling.en.md) §6.

| ID | Endpoint / transaction | P95 | P99 | Technical error rate | Verify | Status |
|---|---|---:|---:|---:|:---:|:---:|
| PERF-01 | **`GET /notifications/unread-count`** | **200 ms** | 500 ms | < 0.1% | PT | 🟡 |
| PERF-02 | **Blotter list `GET /trades`** (200 rows, incl. UC enrichment) | **1,500 ms** | 3,000 ms | < 0.1% | PT | 🟡 |
| PERF-03 | `GET /trades/{id}` (detail) | 800 ms | 1,500 ms | < 0.1% | PT | 🟡 |
| PERF-04 | `GET /trades/{id}/risk-metrics` (all) | 2,000 ms | 4,000 ms | < 0.5% | PT | 🟡 |
| PERF-05 | RefData / UC / Product queries | 500 ms | 1,000 ms | < 0.1% | PT | 🟡 |
| PERF-06 | `GET /checker/tasks/pending` | 800 ms | 1,500 ms | < 0.1% | PT | 🟡 |

**PERF-01 has the tightest threshold, because**: `unread-count` carries the highest request volume in the system ([Workload Modeling](workload-modeling.en.md) §1, roughly 33%) and delivers no business value. Every extra 100 ms is multiplied across all concurrent users at the polling frequency, wasting connections and threads. **An endpoint called by 31 users every 15 seconds has no business taking more than 200 ms.**

**PERF-02 is the main-screen threshold** and is therefore looser than the detail page: it returns 200 rows with per-row enrichment. **But if the Fan-out Audit ([Test Plan](oreo-performance-test-plan.en.md) S-09) confirms enrichment is N+1, this threshold should be lowered and an architecture change pursued rather than accepting 1.5 seconds.**

### 2.2 Latency thresholds — write and compute paths

| ID | Endpoint / transaction | P95 | P99 | Technical error rate | Verify | Status |
|---|---|---:|---:|---:|:---:|:---:|
| PERF-07 | **`POST /trades/create`** — small `.dat` | **5,000 ms** | 8,000 ms | < 0.5% | PT | 🟡 |
| PERF-08 | `POST /trades/create` — medium | 10,000 ms | 15,000 ms | < 0.5% | PT | 🟡 |
| PERF-09 | `POST /trades/create` — large | 20,000 ms | 30,000 ms | < 1% | PT | 🟡 |
| PERF-10 | `POST /trades/dat-to-json` (small) | 2,000 ms | 4,000 ms | < 0.5% | PT | 🟡 |
| PERF-11 | `POST /trades/calculate-risk-for-new` | 5,000 ms | 8,000 ms | < 1% | PT | 🟡 |
| PERF-12 | **`TX_Event_Submit`** (lifecycle event submit) | **3,000 ms** | 5,000 ms | < 0.5% | PT | 🟡 |
| PERF-13 | **`TX_Event_Approve`** (single approve) | **3,000 ms** | 5,000 ms | < 0.5% | PT | 🟡 |
| PERF-14 | **`TX_Event_Reject`** (single reject, incl. snapshot restore) | **4,000 ms** | 6,000 ms | < 0.5% | PT | 🟡 |

**Upload thresholds must be split by file tier** (PERF-07/08/09). A create latency figure without a stated file size cannot be interpreted and cannot be used to judge regression — see [KPI Definitions](kpi-definitions.en.md) §5.8.

**PERF-14 is one second looser than PERF-13** because the reject path additionally performs snapshot restore plus an audit write. **If measured reject and approve durations are identical, suspect that snapshot restore is not actually running** — an example of using performance data to interrogate functional correctness.

**PERF-09's 30-second P99 must be aligned with gateway/load-balancer timeouts** (see RES-03). If the gateway times out at 30 seconds, this requirement is unachievable in practice and users see a 504 rather than a slow response.

### 2.3 Batch and notification paths

| ID | Requirement | Threshold | Verify | Status |
|---|---|---|:---:|:---:|
| PERF-15 | `bulk-approve` with 20 tasks, **total duration** | P95 ≤ 15,000 ms | PT | 🟡 |
| PERF-16 | `bulk-approve` **latency per unit of work** | ≤ 750 ms/task, and **must not rise as batch size grows** | PT | 🟡 |
| PERF-17 | **`TX_Notify_Delivery`** (task created → visible to checker) | P95 ≤ 30,000 ms | PT | 🟡 |
| PERF-18 | `POST /trades/trigger-event` latency per unit of work | ≤ 1,000 ms per affected trade | PT | 🟡 |

**The "must not rise" clause in PERF-16 matters more than the absolute value.** Rising per-unit latency means lock scope or transaction length grows with batch size (see [KPI Definitions](kpi-definitions.en.md) §2.4), which means batch size needs a hard cap — an architectural constraint, not a tuning problem.

**PERF-17's 30 seconds is derived from the polling interval**: `unread-count` polls every 15 seconds (A12), so visibility within two polling cycles is a reasonable ceiling. **If the frontend moves to WebSocket push, this threshold should drop sharply to the 2-second range.**

### 2.4 Throughput targets

| ID | Requirement | Threshold | Verify | Status |
|---|---|---|:---:|:---:|
| PERF-19 | PERF-01–18 all met **simultaneously** at every design capacity in [Workload Modeling](workload-modeling.en.md) §6 | See §6 capacity table | PT | 🟡 |
| PERF-20 | Latency degradation in the month-end scenario (3× a normal day) | ≤ 20% | PT | 🟡 |
| PERF-21 | Script error rate | **= 0** | PT | 🟡 |

**PERF-19 says "simultaneously", not "individually".** Testing endpoints one at a time hides resource competition: `.dat` parsing and blotter queries contend for CPU in the same process, so both may pass alone and both fail together.

### 2.5 Explicitly not NFRs

Excluded deliberately, to stop review discussions from reopening them:

| Item | Why there is no NFR |
|---|---|
| **Time-to-Approve** (maker submits → checker completes) | Includes a human interval, mostly determined by checker rostering. Observed as a **business-process efficiency** metric (SCALE-02), not a system SLA |
| Knee-point TPS | Design capacity sits far below the knee; the number has no decision value for OREO (see [Strategy](performance-test-strategy.en.md) §4) |
| Mean response time | Averages hide the tail; never an SLA basis |
| Concurrent connection count | Users number in the tens; not a constraint |

---

## 3. Availability & Continuity (NFR-AVAIL)

| ID | Requirement | Threshold / note | Verify | Status |
|---|---|---|:---:|:---:|
| AVAIL-01 | Availability during business hours ([Workload Modeling](workload-modeling.en.md) A19: 10 h/day) | ≥ 99.9% monthly, within business hours | OPS | 🟡 |
| AVAIL-02 | **A trade in `pending approve` must not be orphaned by a service restart** | The lock must be recoverable or time-bounded; after restart the checker can still approve or reject it | **OPS + FT** | 🟡 |
| AVAIL-03 | RTO (recovery time objective) | ≤ 30 minutes | OPS | 🟡 |
| AVAIL-04 | RPO (recovery point objective) | **0** — no committed transaction may be lost | OPS | 🟡 |
| AVAIL-05 | Planned maintenance must not lose or hide tasks in `checker_tasks` | Queue intact after the maintenance window | OPS | 🟡 |
| AVAIL-06 | Single-node failure does not break business continuity | Depends on whether the deployment topology is multi-instance | **AR** | 🟡 |

**AVAIL-02 is an OREO-specific high risk.** Four-eyes locks a trade in `pending approve`. If the service restarts while the lock is held:

- Lock in memory → the lock vanishes on restart, leaving trade state and `checker_tasks` inconsistent
- Lock in the database with no timeout → the trade is **frozen permanently** and needs manual intervention

Neither failure is discoverable by conventional performance testing; both need a deliberate process-kill drill. **This requirement is simultaneously a data-integrity issue** (see INTEG-06).

**AVAIL-04 is set to RPO = 0** because losing a committed booking is unacceptable in a trading system. If the architecture cannot achieve this (e.g. asynchronous replication), this requirement must be explicitly relaxed with a documented compensating mechanism.

---

## 4. Data Integrity (NFR-INTEG)

**Highest-priority section** (see §1.1).

| ID | Requirement | Note | Verify | Status |
|---|---|---|:---:|:---:|
| INTEG-01 | **Snapshot restore after reject must be field-complete** | After reject, the trade must match its pre-submission state field by field (excluding audit and version fields). **"Main fields match" is not acceptable** | **FT + PT** | 🟡 |
| INTEG-02 | **Event execution atomicity** | An event either fully applies or fully rolls back. Killing the process mid-execution must not leave a half-executed state | **OPS + FT** | 🟡 |
| INTEG-03 | **A trade in `pending approve` must not accept a second event** | Concurrent submissions: exactly one succeeds, the rest receive an explicit business rejection (not 5xx, not silent overwrite) | **PT** (S-05) | 🟡 |
| INTEG-04 | A failed `.dat` parse must not leave a partially created trade | All three failure paths verified: parse exception, OOM, timeout | FT + PT | 🟡 |
| INTEG-05 | **Allocation write-amplification atomicity** | When one trade splits across portfolios, all child records and the parent commit in one transaction | FT | 🟡 |
| INTEG-06 | Lock state and `checker_tasks` must stay consistent | No state where a trade is locked with no task, or a task exists with no lock | **FT + OPS** | 🟡 |
| INTEG-07 | No lost updates under load | Concurrent amendments need optimistic or pessimistic concurrency control; a later write must not silently overwrite an earlier one | **PT** (S-05) | 🟡 |

**The phrase "main fields match is not acceptable" in INTEG-01 is deliberate.** The classic snapshot-restore defect is forgetting to restore a newly added field — someone adds a column and does not update the snapshot logic. Functional tests rarely catch it, because test cases usually assert only the fields they care about, yet in production it produces silent data corruption. **The recommended verification is a full-field diff, not an assertion list.**

**INTEG-03 and INTEG-07 can only be verified by a same-target concurrency scenario** ([Test Plan](oreo-performance-test-plan.en.md) S-05). Conventional load tests point each thread at a different trade and will never reach either condition.

---

## 5. Auditability & Compliance (NFR-AUDIT)

| ID | Requirement | Note | Verify | Status |
|---|---|---|:---:|:---:|
| AUDIT-01 | Every state transition produces an audit record | Containing: actor identity, timestamp, event type, before/after values, associated trade and task | FT | 🟡 |
| AUDIT-02 | **No audit record may be lost under load** | After a load round, audit record count must **exactly equal** successful event count. Dropping or sampling under backpressure is not permitted | **PT** | 🟡 |
| AUDIT-03 | The audit log is tamper-evident | Append-only; no delete/update path at the application layer | **AR** | 🟡 |
| AUDIT-04 | Rejection reason must be recorded and non-empty | The background requires "reason written to audit log" | FT | 🟡 |
| AUDIT-05 | Audit records are searchable by trade / user / time range | For regulatory enquiry and after-the-fact reconstruction | FT | 🟡 |
| AUDIT-06 | A failed audit write must fail the business operation | **"Business succeeded but audit failed" is not permitted** | **AR + FT** | 🟡 |

**AUDIT-02 is an integrity requirement verifiable by performance testing, and the most easily overlooked item in this document.** A common performance optimisation is to make audit writes asynchronous behind a bounded queue that drops when full. In a load report that looks like "latency improved"; in reality it is **trading compliance risk for speed**.

The verification is simple and should close out every Load round:

```
After the run:
  SELECT count(*) FROM audit_log WHERE run_id = <this run>
  must exactly equal the count of successful event samples in the jtl
  any non-zero difference fails AUDIT-02, regardless of latency
```

**AUDIT-06 is in direct tension with performance**: synchronous audit writes add latency. That trade-off must be made explicitly rather than settled by default behaviour — which is why it is tagged **AR** and needs architecture to confirm which path the current implementation takes.

---

## 6. Security & Access Control (NFR-SEC)

| ID | Requirement | Note | Verify | Status |
|---|---|---|:---:|:---:|
| SEC-01 | **User identity must not be self-asserted by the client** | See discussion below | **AR** | 🟡 |
| SEC-02 | **Four-eyes must not be self-satisfiable** | The same identity must not approve its own submission, enforced **server-side**, not by hiding a UI button | **FT** | 🟡 |
| SEC-03 | Entitlement checks execute server-side | Maker / checker eligibility decided by the server; the UI is a display optimisation only | **FT + AR** | 🟡 |
| SEC-04 | Unauthorised access to another user's trade / task must be refused | A hand-constructed request for an unauthorised resource returns 403 and no data | FT | 🟡 |
| SEC-05 | `.dat` uploads validate type and size limits | Rejections return an explicit business error (see RES-02) | FT | 🟡 |
| SEC-06 | Audit and notification content must not leak unauthorised data | Notifications must not expose trade detail to a checker without entitlement | FT | 🟡 |

### SEC-01 discussion — an open question for architecture

**Current state**: authorisation for every API is decided by the `X-User-Id` request header. There is no login endpoint, no token, and no 401 retry path (see [v2 plan](../trade-api-perf-test-plan-v2-jmeter.md) §8.4).

**Why this is different in kind for a four-eyes system**: in an ordinary CRUD system, a client-settable identity header is a crude authentication model. In a **four-eyes** system it voids the entire control — one person can submit as maker, change one header, and approve as checker. However complete the `checker_tasks` record is, it does not help, because both recorded identities were chosen by the same actor.

**Requirement wording**: the value of `X-User-Id` must be established by an authenticated component the client **cannot influence** (gateway, mTLS, SSO session), and the server must reject that header when it arrives from an untrusted source.

**Open questions (for architecture to answer)**:

1. Is there a gateway/BFF that injects `X-User-Id` after authenticating, and strips any client-supplied header of the same name?
2. Is the API Service reachable directly from the internet or the corporate network?
3. Does the server validate `X-User-Id` against a transport-layer identity (mTLS certificate / SSO session)?

**If the answers are "yes, gateway; no, not reachable; yes, validated", this requirement is already satisfied** — record that mechanism here and flip the status to 🟢. **The available evidence is insufficient to conclude either way, which is why this is flagged as needing architecture confirmation rather than logged as a defect.**

**Impact on performance testing**: the load scripts currently construct `X-User-Id` directly (`groovy/resolve-identity.groovy`). If gateway authentication is introduced, the load-test entry point must change accordingly — an engineering impact worth knowing about in advance.

---

## 7. Scalability & Capacity (NFR-SCALE)

| ID | Requirement | Threshold / note | Verify | Status |
|---|---|---|:---:|:---:|
| SCALE-01 | **Blotter queries scale sub-linearly with data volume** | P95 at 250,000 trades ≤ **3×** P95 at 1,000 trades | **PT** (S-10) | 🟡 |
| SCALE-02 | **`checker_tasks` queue must not grow monotonically** | Pending depth converges at steady state; includes assessment of checker-team capacity | PT + OPS | 🟡 |
| SCALE-03 | Audit and trade tables need an archival/partitioning strategy | 250k trades over 3 years plus a multiple of that in audit records; growth handling must be defined | **AR** | 🟡 |
| SCALE-04 | The service scales horizontally | Requires confirming whether it holds local state (in-memory locks, local caches, sessions) | **AR** | 🟡 |
| SCALE-05 | Reference-data growth does not affect booking | counterparty / portfolio are synced from a third party; their volume is outside our control | PT | 🟡 |

**SCALE-01's factor of 3 is a proposed value**, reasoned as: data grows 250× while P95 is allowed to degrade only 3×, which is equivalent to requiring an index rather than a full scan. **If measured degradation exceeds 10×, a missing index or full scan can be assumed** — that is this requirement's main use. It is an index-absence detector as much as a capacity metric.

**SCALE-04 is linked to AVAIL-06**: if the service holds in-memory locks (see AVAIL-02) it can neither scale horizontally nor restart safely. Both requirements point at the same architectural question.

---

## 8. Observability (NFR-OBS)

**This entire section consists of testing prerequisites** — unmet, they make parts of §2 and §7 unverifiable.

| ID | Requirement | Note | Verify | Status |
|---|---|---|:---:|:---:|
| OBS-01 | **Expose gRPC fan-out counts** | The number of UC / risk-engine calls triggered per API request must be observable | **NV** | 🟡 |
| OBS-02 | **Expose `.dat` parse peak memory** | Peak heap allocation of a single parse must be observable (JFR / instrumentation) | **NV** | 🟡 |
| OBS-03 | End-to-end correlation ID | API → UC gRPC → risk-engine gRPC must be traceable as one chain | AR | 🟡 |
| OBS-04 | **Server logs distinguish the three error classes** | Technical / business rejection / parameter error distinguishable in logs (see [KPI Definitions](kpi-definitions.en.md) §1.3) | AR | 🟡 |
| OBS-05 | Expose `checker_tasks` queue depth as a metric | Needed to verify SCALE-02 | **NV** | 🟡 |

**The consequences of OBS-01 and OBS-02 being NV must be stated plainly**:

- Without OBS-01, **the Fan-out Audit cannot run**, and PERF-02's threshold is just a number — we would not know whether 1 or 200 gRPC calls sit behind it. And that is the primary risk identified in [Workload Modeling](workload-modeling.en.md) §1.
- Without OBS-02, **Cost Profile cannot produce a memory conclusion**, and the OOM threshold for concurrent `.dat` parsing can only be inferred by loading until it crashes — expensive, imprecise, and it contaminates the environment.

**These two are the highest-priority "build the capability first" items in this document** and should be raised as requirements with development before formal load testing is scheduled.

---

## 9. Degradation & Resilience (NFR-RESIL)

The dependency/impact matrix is in [v2 plan](../trade-api-perf-test-plan-v2-jmeter.md) §2.2. The following are **architectural criteria** and take effect without business sign-off.

| ID | Requirement | Threshold | Verify | Status |
|---|---|---|:---:|:---:|
| RESIL-01 | **While UC gRPC is degraded**, degradation of `create` / `unread-count` | ≤ 10% | PT (S-11) | 🟡 |
| RESIL-02 | **While risk-engine is degraded**, degradation of `create` / blotter list | ≤ 10% | PT (S-11) | 🟡 |
| RESIL-03 | **During high-concurrency large `.dat` parsing**, degradation of unrelated read endpoints | ≤ 20% | PT (S-12) | 🟡 |
| RESIL-04 | **During batch windows** (trade-aging / sync-cashflows / refdata sync), degradation of online endpoints | ≤ 20% | PT (S-13) | 🟡 |
| RESIL-05 | **While notification is degraded**, approvals still complete | Approval succeeds; tasks remain visible in the pending list (discovery must not depend on notifications) | PT + FT | 🟡 |
| RESIL-06 | Downstream timeouts are bounded and fail fast | A hung downstream must not exhaust this service's connection pool | AR + PT | 🟡 |

**RESIL-02 verifies an architectural assumption, not a performance metric.** [v2 plan](../trade-api-perf-test-plan-v2-jmeter.md) §2.2 concludes that "create's dependency chain is DAT parsing → DB → audit → WebSocket, excluding risk-engine, so a risk-engine failure should architecturally leave create unaffected". **That assumption must be verified rather than assumed** — shared thread pools, shared connection pools, and synchronous health checks can all invalidate it.

**RESIL-05 deliberately includes "discovery must not depend on notifications"**: if the notification service is down and checkers can only learn of pending tasks through notifications, the four-eyes workflow has effectively stopped — even with a perfectly healthy approval API. The degraded path must be that a checker who actively opens the pending list still sees every task.

---

## 10. Maintainability & Configurability (NFR-MAINT)

| ID | Requirement | Note | Verify | Status |
|---|---|---|:---:|:---:|
| MAINT-01 | **Migrating a new event type into the approval flow should be a configuration change, not a code change** | The background states explicitly that novation / step-out / early termination and others do "**not yet**" require approval — this scope is **expected to change** | **AR** | 🟡 |
| MAINT-02 | Composer product-definition / lifecycle-config changes take effect without deployment | Config-cache invalidation delay must be bounded and observable | FT + AR | 🟡 |
| MAINT-03 | Marking a product deleted must not break lifecycle operations on existing trades | Soft-delete semantics must be defined | FT | 🟡 |
| MAINT-04 | Config-cache refresh must not cause online latency spikes | Degradation during refresh ≤ 10% | PT | 🟡 |

**MAINT-01 is the only requirement in this document driven by a single word.** When the business background describes approval scope, it says events do "not require checker approval **yet**". That "yet" means the current approval scope is a **transitional state**.

If approval scope is hard-coded, migrating each event type costs a code change, a regression, and a release; if it is configuration, it costs a config change and one verification round. **The value of this requirement is not today — it is that it marks a known future change point in advance** and lets architecture leave an interface for it now.

Testing impact: the approval column in [Workload Modeling](workload-modeling.en.md) §4.3 was deliberately designed so that only one column changes when this happens.

---

## 11. Resource Ceilings (NFR-RES)

| ID | Requirement | Note | Verify | Status |
|---|---|---|:---:|:---:|
| RES-01 | **Concurrent `.dat` parsing must be capped with backpressure applied** | Beyond the cap, queue or return an explicit business error — **never OOM**. The cap is derived from measured peak memory in Cost Profile | **PT** (S-14) | 🟡 |
| RES-02 | **Upload size limits must reject explicitly** | Over-limit returns a clear business error (413 or a business code), **never a timeout or 504** | FT | 🟡 |
| RES-03 | Gateway / LB timeouts must align with PERF-09 | Large-tier create targets a 30 s P99, so the gateway timeout must exceed that | **AR** | 🟡 |
| RES-04 | DB and gRPC pool capacity must cover fan-out at design capacity | Including worst-case fan-out under an N+1 pattern (see OBS-01) | AR + PT | 🟡 |

**RES-01 is where §2 and §11 intersect.** [KPI Definitions](kpi-definitions.en.md) §2.3 gives the formula:

```
theoretical max concurrent parses = available heap / peak memory per parse
```

If that number is below the design concurrency (Workload Modeling capacity table: 3 concurrent large-tier), it is a **hard capacity ceiling** with no remedy but more memory. RES-01 therefore does not ask for a bigger heap — it asks that **an explicit concurrency gate exist**. Without one, the N+1-th concurrent parse crashes the whole JVM, killing every unrelated in-flight request with it.

**RES-03 is an easily missed consistency check**: if the gateway timeout is 30 seconds and PERF-09's P99 target is also 30 seconds, large-tier create returns 504 at the boundary and users see an error rather than a slow response. The two numbers must be aligned explicitly by architecture, with headroom on the gateway side.

---

## 12. Sign-off and capability backlog

### 12.1 Values needing sign-off (all 🟡)

| # | Item | Who | Why it cannot be set now |
|---|---|---|---|
| 1 | All latency thresholds PERF-01–18 | Business Ops + Architecture | Proposed values are derived from business shape; business must confirm what users tolerate |
| 2 | AVAIL-01 availability target, AVAIL-03 RTO | Operations + Business | Depends on operational capability and business tolerance |
| 3 | AVAIL-04 RPO = 0 | Architecture | If unachievable, must be explicitly relaxed with a compensating mechanism |
| 4 | SCALE-01's factor of 3 | Architecture | Needs to be confirmed against the index design |
| 5 | All assumptions A1–A23 in [Workload Modeling](workload-modeling.en.md) | Business Ops + Frontend | Every capacity threshold in this document derives from them |

### 12.2 Items requiring a capability before they can be verified (**highest priority**)

| # | Item | What is missing | What it blocks |
|---|---|---|---|
| 1 | **OBS-01** gRPC fan-out counts | Server-side APM traces or counters | Fan-out Audit cannot run; PERF-02's threshold becomes meaningless |
| 2 | **OBS-02** parse peak memory | JVM instrumentation / JFR | Cost Profile has no memory conclusion; RES-01's cap cannot be derived |
| 3 | **OBS-05** `checker_tasks` queue depth | Server-side metric | SCALE-02 unverifiable |
| 4 | 250k-trade seed data | Data factory | Validity of SCALE-01 and PERF-02 (see [KPI Definitions](kpi-definitions.en.md) §5.4) |
| 5 | Fault-injection capability | Controllably degrading UC / risk-engine / notification | All of RESIL-01–06 |
| 6 | Process-kill and recovery drill environment | Controlled restarts | AVAIL-02, INTEG-02 |

### 12.3 Open questions for architecture

| # | Question | Related items |
|---|---|---|
| 1 | **Is there a gateway that injects `X-User-Id` after authentication and strips the client-supplied header? Can the API Service be reached directly?** | **SEC-01** |
| 2 | Where does the `pending approve` lock live (memory / DB)? Is there a timeout release? | AVAIL-02, INTEG-06, SCALE-04 |
| 3 | Are audit writes synchronous or asynchronous? If async, is the queue bounded and what happens when it fills? | AUDIT-02, AUDIT-06 |
| 4 | Is blotter UC enrichment a batch query or per-row N+1? | PERF-02, OBS-01, SCALE-01 |
| 5 | Is approval scope (which events need a checker) configuration or code? | MAINT-01 |
| 6 | Does the service hold local state? Can it run multi-instance? | SCALE-04, AVAIL-06 |
| 7 | What are the gateway / LB timeout values? | RES-03, PERF-09 |
| 8 | What is the maximum write-amplification factor for `Allocation` splitting one trade across portfolios? | INTEG-05, PERF-18 |
| 9 | refdata sync job schedule, write mode (upsert vs truncate-reload), and whether it shares a DB instance with the API | RESIL-04, SCALE-05 |

---

## Related pages

- [Workload Modeling](workload-modeling.en.md) — where the capacity thresholds on this page derive from
- [KPI Definitions](kpi-definitions.en.md) — how the thresholds on this page are measured
- [Performance Test Strategy](performance-test-strategy.en.md) — when we test, and pass principles
- [OREO Performance Test Plan](oreo-performance-test-plan.en.md) — the scenarios behind each PT tag
- [Trade API Performance Test Plan v2](../trade-api-perf-test-plan-v2-jmeter.md) — API inventory, dependency matrix, JMeter implementation
