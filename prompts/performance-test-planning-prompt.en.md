# Performance Test Planning · Prompt (English)

> Purpose: When the AI has access to your frontend and backend code, use this prompt to have it plan a performance testing scheme.
>
> Core principle: **Don't hand-feed what the AI can mine from the code; you must supply what the code cannot reveal (traffic volume, SLA, environment).** The prompt's job is to *assign the analysis, set the constraints, and define the deliverable* — not to describe the system.

---

## The Prompt

```
# Role
You are a senior performance test engineer. You have access to this project's full frontend and backend code.

# Goal
Produce a performance testing plan for this system. The purpose of testing is:
[Release acceptance / Capacity assessment / Establish a performance baseline — pick one or combine].

# Step 1: Analyze the code first and extract the following facts (do not speculate; base it on the code and cite file locations)
1. List of public-facing endpoints, and the call chain behind each (Controller → Service → DAO / external calls).
2. Identify "heavy operations": endpoints involving large-result queries, batch processing, exports, complex aggregations, or looped calls.
3. Database access: key SQL statements, whether pagination is used, tables involved, and queries that may be missing indexes or suffer from deep pagination / full-table scans.
4. External and middleware dependencies: third-party APIs, cache (Redis), message queues, scheduled jobs — list them and flag which ones would cause real side effects during load testing (send SMS / charge money / write to downstream systems).
5. Async persistence points: which operations return "success" from the API but actually write to the database asynchronously, requiring special verification.
6. Resource configuration: current values for the web container thread pool, database connection pool, and HTTP client connection pool.
7. Frontend: identify pages with heavy first-paint load, long request waterfalls, or that fetch large amounts of data at once.

# Step 2: Incorporate the following business constraints (not readable from code — I provide them)
- User scale: total users __, daily active __, peak hours __
- Peak pattern: any "everyone at once" scenarios (e.g., company-wide clock-in, month-end batch operations) __
- Data volume: current row count of core tables __, annual growth __, seed data to the volume expected 2–3 years out
- SLA / acceptance criteria: P95 response time ≤ __ s, error rate < __%, target concurrency __
- Test environment: configuration relative to production is __ (equivalent / how much smaller), available tools __

# Step 3: Produce the performance testing plan, including
1. Test scenario design (single-endpoint baseline + mixed business scenarios, with operation ratios and concurrency ramp).
2. Acceptance metrics for each scenario (aligned with the SLA above).
3. Key monitoring metrics and instrumentation points (based on the bottlenecks you predicted in Step 1).
4. Seed-data and parameterized-data strategy.
5. Recommendations for handling external dependencies (real call / mock / stub), with rationale.
6. Risks and mitigations (load-test side effects, data pollution, impact on shared middleware).
7. Recommended execution order and number of iteration rounds.

# Constraints
- This round is planning only — do not write load-test scripts.
- Clearly separate "facts confirmed in the code" from "your inferences / assumptions."
- At the end, separately list what information you still need me to confirm to complete the plan (a gap list).
```

---

## How to Use It

1. **Treat "Step 1" as the AI's core value area.** The "heavy operations list," "un-indexed SQL," and "dependencies with real side effects" it extracts from the code are exactly the parts that are most time-consuming and most easily missed when done by hand. Scenario design, monitoring instrumentation, and risk plans all grow out of this.

2. **"Step 2" is your irreplaceable input.** User volume, peak patterns, SLA, environment parity — none of this is in the code, so the AI can only guess. Fill in the numbers you negotiated with your manager; plan quality depends directly on this.

3. **Force a "fact vs. assumption" split and a gap list** — this is the key defense against hallucination. Your review effort drops from "read everything to find mistakes" to "only check the handful of items it flagged as assumptions."

## Recommended Iterative Workflow (Two Rounds)

- **Round 1:** Send only "Step 1" and have the AI produce a **code analysis report** (endpoint list, heavy operations, dependencies, bottleneck predictions). Verify it and fill any gaps.
- **Round 2:** Then, with the confirmed analysis plus business constraints, have it produce the full plan.

This decouples "AI reads code" from "AI plans," making each step verifiable — far more reliable than doing it all in one shot.
