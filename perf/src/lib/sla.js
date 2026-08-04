// SLA entry → API-level percentile thresholds. Attached to perf_success_duration (durations of
// business-successful requests only — fast rejections would drag percentiles down and inflate
// apparent capacity, and an SLA is meaningless for failed requests).
// Error rate and the abort threshold (breaker) belong to the profile level (profiles/*.json);
// this module no longer generates them.
export function buildThresholds(s) {
  for (const k of ['name', 'p95', 'p99']) {
    if (!(k in s)) throw new Error(`SLA missing ${k}`);
  }
  return {
    [`perf_success_duration{name:${s.name}}`]: [`p(95)<${s.p95}`, `p(99)<${s.p99}`],
  };
}
