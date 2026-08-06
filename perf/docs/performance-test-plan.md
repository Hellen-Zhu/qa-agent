# Performance Test Plan (corporate template)

> Corporate-template performance test plan (sanitized: internal system codename redacted). Companion to `test-plan.md` — that file tracks phases/gaps for execution; this one follows the corporate sign-off template structure. Paste section by section into the internal Confluence template, restoring the internal system name there. **TBC** items carry an owner — they are formal input requests, not omissions.

---

## 1. Introduction

### Purpose

This document outlines the scope, approach and plan for performance testing to be undertaken for the trading platform. This plan, once signed off, serves as the final confirmation that the approach and scope of performance testing for the release is confirmed and approved by the stakeholders.

This release's performance testing targets the **API layer** (HTTP, service-side) of the platform, organised in three scenario levels: **single-API rounds** — capacity probing, SLA compliance at target load and regression baselining, one endpoint per run for clean attribution; **business journeys** — one actor's complete operational flow for one business action, i.e. the main API plus the auxiliary calls the screen actually fires (booking: refdata lookups → risk calc → dat-to-JSON → create; checker workflow: pending list → approve → status check; lifecycle event: read trade → trigger event → verify state, P1). Journeys are the realistic unit of load — production concurrency IS N independent actors running such flows; and **mixed workload** — flows injected concurrently at production ratios (§6.1 workmix; journey-ratio mix once auxiliary-call contracts are captured, API-ratio mix as the interim), measuring capacity under cross-endpoint contention. The cross-role lifecycle chain (create → approve → update → approve) is NOT a journey but a measurement probe (§6.4 E2E Peak): synchronized cross-role chains match no real traffic shape, so it is never scaled as load. Resilience characterisation (stress / spike / soak) applies to the load models. UI rendering and WebSocket channels are out of scope for this cycle (see §5).

### Project / Release Overview

(Keep the template's standard platform description and component list: Gateway, Workers Backend, User Center, Notification Service, Refdata Service, Ops Service, Risk Engine, Trade Composer UI.)

Testing entry point is the gateway; the primary system under test is the Workers Backend (trade composition, approval workflow) with its downstream fan-out to the Risk Engine (gRPC), Notification Service and the database layer.

---

## 2. NFR and Volumetrics

### NFR

| # | NFR description | Reference document link | Comments |
|---|---|---|---|
| 1 | Response-time SLAs per API (p95/p99, business-successful samples only) | Perf framework `config/slas/` (git) | **Current values are engineering placeholders** — formal values require the SLA calibration session with business. Owner: Business / QA. TBC |
| 2 | Business success rate ≥ 99% at target load (excludes technical/env failures, measured on the three-class verdict) | Perf framework spec §7 | Framework-enforced verdict line |
| 3 | Sustained peak: no degradation over 8h at peak volume (soak) | This plan §6.4 | Aligned with the corporate endurance requirement |
| 4 | Gateway per-user rate limit must not be the binding constraint at target load | Measured 2026-08-04 (429 analysis) | Requires either dedicated-account pool sizing or a limiter policy decision. Owner: Platform. |

### Volumetrics and Flows

| SN | Volumetric / Flow description | Type | Volume | Information Source |
|---|---|---|---|---|
| 1 | Trade creation (maker) per peak hour | API | **TBC — production traffic profile required** | Owner: Business/Architecture. Blocking input for §6.1 workmix |
| 2 | Trade amendment (update) per peak hour — flagged by management as the future high-frequency operation | API | **TBC** | Same source |
| 3 | Checker approvals per peak hour | API | **TBC** (≈ create + update volume) | Derived once 1–2 are known |
| 4 | Trade queries / detail views per peak hour | API | **TBC** | Same source |
| 5 | Measured capacity reference (dev PT env): linear scaling to 40 VUs ≈ 120 req/s at ~330 ms p95 (create), CPU < 10% — knee not yet reached | Measured | n/a | Perf framework ladder rounds 2026-08-04/05 |

### API

| SN | API Endpoint | Microservice | NFR Volume | SLA (p95/p99 ms) | Rate Limit | Information Source |
|---|---|---|---|---|---|---|
| 1 | GET /api/v1/trades | Workers Backend | TBC | 300 / 800 * | Per-user gateway limit (threshold TBC) | SLA: placeholder pending calibration |
| 2 | GET /api/v1/trades/{id} | Workers Backend | TBC | 300 / 800 * | same | same |
| 3 | POST /api/v1/trades/create | Workers Backend | TBC | 800 / 2000 * | same | same |
| 4 | POST /api/v1/trades/{id}/update | Workers Backend | TBC | 800 / 2000 * | same | same |
| 5 | GET /api/v1/trades/{tradeId}/risk-metrics | Workers Backend (+ Risk Engine) | TBC | 500 / 1500 * | same | same |
| 6 | POST /api/v1/checker/tasks/{taskId}/approve | Workers Backend | TBC | 500 / 1500 * | same | same |
| 7 | POST /api/v1/checker/tasks/{taskId}/reject | Workers Backend | TBC | 500 / 1500 * | same | contract not yet calibrated |
| 8 | GET /api/v1/notifications/unread-count | Notification Service | TBC | 200 / 500 * | same | same |
| 9 | POST /api/v1/trades/{id}/calculate-risk (+ partial-novation / for-new variants) | Workers Backend + Risk Engine | TBC | TBC | same | contracts to be captured (P0 phase-W remainder) |
| 10 | POST /api/v1/trades/{id}/trigger-event | Workers Backend | TBC | TBC | same | lifecycle-event phase (P1) |

\* Engineering placeholders — formal SLA calibration pending (NFR #1).

---

## 3. Environment

### 3.1 Performance Test Environment Analysis

| Environment attribute | Production Env Spec | PT Env Spec | Variance and Impact on validity of PT results |
|---|---|---|---|
| Service deployment | Multi-node / HA (TBC — confirm with platform) | All platform services co-located on a single host | Co-location shares CPU between services; per-service attribution uses process-level (JVM) CPU, and absolute capacity numbers must be labelled PT-env-only until a prod-like env is available |
| Load balancing | Gateway + LB (TBC) | Single instance, no LB | Horizontal-scaling behaviour not measurable; results characterise single-node capacity |
| Database | Production-grade sizing (TBC) | Shared dev DB instance | Standing data volume below production ⇒ query results optimistic; mitigated by the waterline discipline (grow towards prod-like volume, record per-run waterline, compare only within a band) |
| Standing data volume | Production volume | Currently far below production | As above — capacity conclusions on read paths discounted until waterline reaches target |
| Rate limiting | Per-user gateway limiting (policy TBC) | Same limiter active | With small account pools the limiter, not the system, is measured; mitigated by 20 maker + 20 checker dedicated accounts; exemption decision pending (RAID R2) |
| Monitoring | Prometheus + Grafana + OTel agents | Same stack, same instance | No variance — a strength: identical observability calibers |

### 3.2 End to End Performance Test Analysis

**Transactional E2E flow** (state machine):

```
create (maker) ──► PENDING APPROVAL ──► approve (checker) ──► LIVE ──► update (maker) ──► PENDING APPROVAL (amend cycle)
                                                                └────► lifecycle events (P1 scope)
```

Observed component fan-out under load (backend dashboards): Gateway → Workers Backend → Risk Engine (gRPC, ~5× request amplification on risk paths), Notification Service, database (HikariCP pools per service).

| E2E Component | In/Out Scope | Rationale | Mitigation |
|---|---|---|---|
| Gateway | In | Single entry point; all API load traverses it | — |
| Workers Backend | In | Core orchestration layer; primary SUT | — |
| Risk Engine | In (indirect) | Exercised via risk-metrics / calculate-risk fan-out | gRPC in/out rates monitored on backend board |
| Notification Service | In | unread-count P0 API + downstream of trade writes | — |
| User Center | In (indirect) | Identity resolution on every request (X-User-Id) | — |
| Refdata Service | In (indirect) | Reference data lookups within trade flows | Not separately load-targeted this cycle |
| Ops Service | Out | No P0 API in scope this release | Revisit if release adds ops-path load |
| Trade Composer UI | Out | API-layer testing this cycle; UI adds browser rendering, not server load | UI perf tracked separately if required |

---

## 4. RAID

### Risk and Issues

| # | Risk/Issue Description | Severity | Probability | Mitigation Plan | Owner |
|---|---|---|---|---|---|
| R1 | Production traffic profile (volumetrics) unavailable — target load for compliance testing undefined | H | H | Formal request via this plan §2; interim: capacity probing continues (system-can-do numbers) | Business / Architecture |
| R2 | Per-user gateway rate limiting caps deliverable load (observed 429s) | H | M | 20+20 dedicated accounts provisioned; limiter exemption vs end-to-end caliber decision requested | Platform / QA lead |
| R3 | Dedicated PERF portfolio not yet created — test trades currently land in real business portfolios, weakening the cleanup key | M | H | Prioritise PERF portfolio creation; interim cleanup by time-window + counterparty signature | Environment team |
| R4 | No cascade cleanup script — seeded data accumulates, waterline drift breaks round-to-round comparability | M | H | Request cleanup script (portfolio + time-window key, cascading to task/audit tables); waterline recorded per run meanwhile | Environment team |
| R5 | Checker permission is granted per product — an account missing a productType silently 403s part of the mix | M | M | Account request specifies full productType coverage of the case pool; 403 attribution documented | QA |
| R6 | Shared dev environment — other users' activity pollutes measurement windows | M | M | Off-peak execution windows; abort thresholds protect the environment; testid isolation in metrics | QA |
| R7 | SLA values are placeholders — verdicts have engineering meaning only until calibrated | M | H | SLA calibration session (NFR #1); baselines promoted only after calibration | Business / QA |

### Key Assumptions and Dependencies

| # | Assumption/Dependency | Rationale | Impact | Owner |
|---|---|---|---|---|
| A1 | X-User-Id header identity (no token lifecycle) remains the auth model in PT env | Measured behaviour | Soak scenarios need no token refresh logic | Platform |
| A2 | Response envelope contract (code/status/msg/data) and msg-embedded TaskId format remain stable across releases | Calibrated 2026-08-05/06 | Contract drift breaks seed pipeline & classification; smoke round per release detects it | Dev |
| A3 | Error semantics: permission = HTTP 403, state conflict = HTTP 400, throttling = 429 | Measured 2026-08-06 | Failure attribution rules depend on it | Dev |
| A4 | k6 load generator and backend share one Prometheus instance | Confirmed 2026-08-04 | Single-pane correlation of client and server metrics | Platform |
| A5 | Dedicated accounts (20 maker / 20 checker) will be approved | Pending | Without them the limiter is the measured object | Platform |

---

## 5. Scope

### Interfaces

| Interface | Direction | In/out scope | Rationale for not in scope |
|---|---|---|---|
| REST API via Gateway | Inbound | In | — |
| gRPC inter-service calls | Internal | In (observed, not directly injected) | Load enters via REST; gRPC monitored as fan-out |
| WebSocket / live messaging | Inbound | Out | Planned next phase (P2); no NEW WebSocket API in this release |
| UI (Trade Composer) | Inbound | Out | API-layer cycle; UI adds no server-side load beyond the same APIs |
| Batch interfaces | — | N/A | The platform has no batch flows; settlement batch belongs to a separate platform with its own PT report |

### API

| Interface | In/out scope | Rationale for not in scope |
|---|---|---|
| GET /api/v1/trades; GET /api/v1/trades/{id}; GET .../risk-metrics; GET /api/v1/notifications/unread-count | In | — |
| POST /api/v1/trades/create; POST /api/v1/trades/{id}/update | In | — |
| POST /api/v1/checker/tasks/{taskId}/approve, /reject | In | — |
| POST calculate-risk ×3 variants | In (phase-W remainder, contracts pending) | — |
| POST /api/v1/trades/{id}/trigger-event | In (lifecycle phase P1) | — |
| POST /api/v1/checker/tasks/bulk-approve, /bulk-reject | Out as measurement target | Operational/tooling endpoints (seed accelerator only); not user-facing peak load; NOT new in this release |
| GET /api/v1/checker/tasks/pending | Out as measurement target | Demoted to ops tooling — TaskId travels in write-response msg, so the hot path never calls it |

---

## 6. Test Approach

### 6.1 API/UI/Live Message Workmix

**User/Injection thread breakdown** (rates pending volumetrics calibration — current values are capacity-probing settings, iterations/hour = rate × 3600):

| Scenario Flow | # Users/threads | Iterations per hour |
|---|---|---|
| trades-query (read mix) | open model, target 2–20 req/s (probing) | 7,200–72,000 |
| trades-create (maker) | open model, target rate TBC vs volumetrics | TBC |
| trades-update (maker, consumable LIVE pool) | open model, target rate TBC — management-flagged high-frequency path | TBC |
| checker-approve (checker, consumable task pool) | open model, ≈ create+update rate | TBC |
| Capacity probe (ladder) | closed model, 10→20→40→80 VUs stepped | n/a (knee finding) |

**Scenario Flow Description**

| Scenario | Action | Action | Action | Action |
|---|---|---|---|---|
| Trade booking journey (Maker) | Refdata lookups (contracts TBC) | Risk calc (calculate-risk) | dat-to-JSON conversion (contract TBC) | Create trade |
| Checker workflow journey (Checker) | Pending-task list (contract TBC) | Approve | Trade status check (detail) | |
| Lifecycle event journey (Maker, P1) | Read original trade | Trigger cancel / novation / termination | Verify resulting state | |
| Trade lifecycle (E2E cross-role probe, P1) | Create (Maker) | Approve (Checker) | Update (Maker) | Approve (Checker) |
| Single-API rounds | one action per scenario (isolation for attribution) | | | |

### 6.2 Data Requirements

| Data Requirement | Data Source | Owner |
|---|---|---|
| Create case rows (productType + ownership fields) — same-source captured from real curl; shape-calibrated 2026-08-06 | System UI + DevTools capture; placeholders in repo, real values PT-env only | QA |
| Consumable LIVE trade pool for update (one id consumed per request) | Seed pipeline: create→approve, exactly-once cursor, volume preflight ≥ planned ×1.2 | QA (framework automated) |
| Consumable pending-task pool for approve | Seed pipeline (create only, TaskId harvested from response msg) | QA |
| Trade ID pool for read scenarios (detail / risk-metrics) | Re-use of seeded trades (reads may use real standing data) | QA |
| Identity pools: 20 maker + 20 checker accounts, checker covering all productTypes | Account provisioning request | Platform |
| Standing data waterline near production volume, then maintained in a band; per-run waterline recorded | Environment + data factory (future); cleanup script (RAID R4) | Environment team |
| Data is NOT a production cut | Synthetic via business APIs (full-fidelity by construction) | — |

### 6.3 Peak Batch Test Flows

**N/A.** The platform exposes no batch flows; batch settlement resides on a separate platform covered by its own performance report. No batch interactions overlap the API paths under test.

### 6.4 API/UI/Live Test Types

| Test Types | Description | User/Thread Setup |
|---|---|---|
| Peak | SLA compliance at production peak × 1.5–2 safety factor (target TBC per volumetrics); 3 consecutive stable rounds gate baseline promotion | Open model (constant arrival rate), rate = target; ~10 min per round |
| E2E Peak | Whole-transaction latency under peak: the mixed workmix supplies the realistic background load; a low-rate journey stream rides on it as a measurement probe. Journeys are never scaled as load — synchronized chains match no real traffic shape | P1 phase; mix profile + dual-identity journey probe (~1–2/min) |
| Stress | Beyond-knee behaviour: failure mode, error onset, recovery on load removal | Open model ramp past measured knee; breakers guard shared env |
| Soak | 8h at peak volume; no p95 drift, no leak (heap/GC trend flat) | Open model at peak rate; consumable pools sized for full duration |
| Capacity probe (additional) | Stepped closed-model ladder to locate the knee before Peak targets exist | ramping-vus 10/20/40/80, 5-min plateaus |

All four corporate-required types are run — no justification-for-omission needed. NEW APIs in this release are covered at interface, soak and stress levels per API governance.

### 6.5 Tooling and Monitoring

| Tool/Monitoring | Usage | Coverage |
|---|---|---|
| k6 (+ zero-dependency runner) | Load injection; three-class verdict (technical/business/script) with business-caliber success rate; exact end-of-run statistics | All scenarios; PASS/FAIL per run |
| Prometheus (shared instance) | k6 remote-write (5s windows) + backend OTel metrics | Client and server series, single instance |
| Grafana — Perf Trade Overview board | Reconciliation cards (exact counters = summary), trends, capacity row (load/throughput/response time + XY), server utilization/saturation, run history | Per-testid; env/profile filters |
| Grafana — official k6 board (19665) | k6-native detail incl. HTTP phase timings (blocked/connect/TLS/wait/receive) | Deep-dive diagnosis |
| Backend OTel dashboards | HTTP RED per service, gRPC in/out, JVM CPU/heap/threads, **GC**, HikariCP pools (active/pending/timeouts) | **CPU ✓ Memory ✓ GC ✓**; **IO: gap** — host-level IO not yet wired (flagged; DB-host metrics requested) |
| k6 web dashboard | Live watch during runs (:5665) | Non-authoritative |
| report.html (per run) | Single-file share-out for business/leadership, exact caliber | Every run |
| Artefact archive | summary.txt/json (verdict authority), CSV per-request detail, k6 log (UTC), env manifest, per-run waterline | Every run, full traceability |

### 6.6 Execution Checklist

**Pre and Post Execution checklist**

| Activity | Description | Owner |
|---|---|---|
| Env checklist green | Accounts valid, services reachable, contracts smoke-checked | QA |
| Seed consumable pools | seed pipeline → harvest → activate pool files; volume ≥ planned ×1.2 | QA |
| Record waterline | Standing-data volume into run manifest; compare only within band | QA |
| Smoke (single-shot) | One VU, one iteration; three-class must be clean before any big round | QA |
| Run + live watch | Execute profile; abort thresholds protect shared env | QA |
| Reconcile | Summary vs Grafana reconciliation cards must match exactly | QA |
| Verdict + baseline | PASS ×3 stable → promote median run as baseline; regressions auto-flagged thereafter | QA |
| Cleanup / re-seed | Consumed pools are dirty — re-seed before rerun; cleanup per portfolio+time-window (script pending, RAID R4) | QA / Env |
| Defect tracking | Issues raised in JIRA project (link) with run artefacts attached | QA |
