// SLA 条目 → API 级分位数阈值。挂在 perf_success_duration（只含业务成功请求的
// 耗时——快速拒绝会拉低分位数使容量虚高，SLA 对失败请求没有意义）。
// 错误率与熔断属于 profile 级（profiles/*.json），本模块不再生成。
export function buildThresholds(s) {
  for (const k of ['name', 'p95', 'p99']) {
    if (!(k in s)) throw new Error(`SLA missing ${k}`);
  }
  return {
    [`perf_success_duration{name:${s.name}}`]: [`p(95)<${s.p95}`, `p(99)<${s.p99}`],
  };
}
