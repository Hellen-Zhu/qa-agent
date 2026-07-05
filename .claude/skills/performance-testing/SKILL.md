---
name: performance-testing
description: This skill should be used when the user asks to "load test", "stress test", "performance test an API or page", "how many users can we handle", "write a k6 script", or needs latency/throughput validation, load profiles, or performance thresholds.
---

# Performance Testing Basics

Test performance with k6 against explicit, agreed thresholds. A performance test without a pass/fail criterion is a demo, not a test — get the target ("p95 < 500ms at 200 concurrent users") before writing any script.

## Test types — pick by question

| Type | Question answered | Shape |
|---|---|---|
| **Smoke** | Does the script and system work at all? | 1-5 VUs, 1 min |
| **Load** | Does it meet SLOs at *expected* traffic? | Ramp to normal peak, hold 10-30 min |
| **Stress** | Where does it break, and how? | Ramp past peak until errors/latency degrade |
| **Spike** | Does it survive sudden surges? | Jump 0→high instantly, then drop |
| **Soak** | Does it degrade over time? (leaks, exhaustion) | Moderate load, 2-8 hours |

Start every engagement with smoke, then load. Stress/spike/soak only when the load test passes.

## k6 script pattern

```js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 100 },  // ramp up
    { duration: '10m', target: 100 }, // hold
    { duration: '1m', target: 0 },    // ramp down
  ],
  thresholds: {                        // pass/fail lives HERE
    http_req_duration: ['p(95)<500', 'p(99)<1500'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.get(`${__ENV.BASE_URL}/api/orders`, {
    headers: { Authorization: `Bearer ${__ENV.TOKEN}` },
  });
  check(res, {
    'status 200': (r) => r.status === 200,
    'body has data': (r) => r.json('items') !== undefined,
  });
  sleep(1); // think time — real users pause; 0 sleep tests the wrong thing
}
```

Run: `k6 run -e BASE_URL=https://staging.example.com script.js`

## Metrics to report — and the traps

- **Latency: p50 / p95 / p99 — never mean.** Averages hide the tail; the tail is what users complain about.
- **Error rate** alongside latency, always: a system that fails fast looks "faster." Latency numbers are meaningless without the error rate next to them.
- **Throughput (RPS)** at each load stage — find where latency starts climbing while RPS flattens: that's the knee, your practical capacity.
- Check `checks` failures separately from HTTP failures — 200s with wrong bodies are errors too.

## Methodology rules

- **Test environment ≈ production sized**, or state the scaling caveat in the report; results from an undersized env only bound the answer.
- **Model real behavior**: mixed scenarios (browse-heavy, few writes), think time, realistic data volume in the DB — an empty database benchmarks nothing.
- **Change one variable per run.** Load level, code version, or infra — never two at once.
- **Warm up before measuring** (caches, JIT, connections) and run the key test twice — unrepeatable results are noise.
- Never load-test production or third-party services without explicit authorization and coordination.

## Report format

```markdown
# Perf test: <target> — <date>
**Question:** Can /api/orders sustain 200 VU at p95<500ms?
**Verdict:** PASS/FAIL — <one sentence>
**Environment:** <sizing, build, data volume, caveats>

| Stage | VUs | RPS | p50 | p95 | p99 | err% |
|---|---|---|---|---|---|---|

**Knee point:** <where degradation began, if probed>
**Bottleneck hypothesis:** <what the evidence suggests — CPU, DB, N+1, ...>
**Recommendations:** <prioritized>
```

File regressions against previous baselines via the `bug-reporting` skill; wire recurring runs into the extended CI tier (see `regression-ci-strategy` skill).
