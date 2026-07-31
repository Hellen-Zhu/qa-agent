// SLA 条目 → k6 thresholds。错误率阈值 abortOnFail：被测环境劣化到阈值即停止施压，
// 保护共享环境（延迟 30s 评估，避开启动抖动误杀）。
export function buildThresholds(s) {
  for (const k of ['name', 'p95', 'p99', 'errorRate']) {
    if (!(k in s)) throw new Error(`SLA missing ${k}`);
  }
  return {
    [`http_req_duration{name:${s.name}}`]: [`p(95)<${s.p95}`, `p(99)<${s.p99}`],
    http_req_failed: [{ threshold: `rate<${s.errorRate}`, abortOnFail: true, delayAbortEval: '30s' }],
    checks: ['rate>0.99'],
  };
}
