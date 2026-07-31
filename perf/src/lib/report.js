// 报告纯逻辑：k6 与 Node 双端可加载。
// 链路：场景 handleSummary 用 toMarkers 写 stdout → run.sh 从日志提取（fromLogs）
// → 存 reports/<testid>.json → render-report 生成 HTML。
// （Job Pod 结束后 kubectl cp 拿不到容器内文件，故走 stdout。）
const START = '==K6_SUMMARY_JSON_START==';
const END = '==K6_SUMMARY_JSON_END==';

function val(data, name, key, dflt) {
  const m = data.metrics[name];
  return m && m.values && m.values[key] !== undefined ? m.values[key] : dflt;
}

export function summarize(data, testid) {
  return {
    testid,
    requests: val(data, 'http_reqs', 'count', 0),
    rps: val(data, 'http_reqs', 'rate', 0),
    // 三分类：报告必须分开呈现——混成一个错误率无法回答"是开发问题还是数据问题"
    ok: val(data, 'perf_ok', 'count', 0),
    errTechnical: val(data, 'perf_err_technical', 'count', 0),
    errBusiness: val(data, 'perf_err_business', 'count', 0),
    errScript: val(data, 'perf_err_script', 'count', 0),
    businessSuccessRate: val(data, 'perf_business_success', 'rate', null),
    // 全请求延迟（含失败）与业务成功延迟并列——两者差距本身就是信号
    latencyMs: {
      p50: val(data, 'http_req_duration', 'med', null),
      p95: val(data, 'http_req_duration', 'p(95)', null),
      p99: val(data, 'http_req_duration', 'p(99)', null),
    },
    successLatencyMs: {
      p50: val(data, 'perf_success_duration', 'med', null),
      p95: val(data, 'perf_success_duration', 'p(95)', null),
      p99: val(data, 'perf_success_duration', 'p(99)', null),
    },
    errorRate: val(data, 'http_req_failed', 'rate', 0),
    thresholdFailures: buildThresholdFailures(data, val(data, 'http_reqs', 'count', 0)),
  };
}

// thresholdFailures 驱动 run.sh 的 PASS/FAIL（长度是否为 0）。0 请求（如 preflight
// abort：exec.test.abort 后仍会跑 handleSummary）时没有任何指标越过阈值——数组天然
// 为空，会被判 PASS，假绿放行本该失败的一轮。合成一条 'no-samples(0-requests)'
// 标记，让"0 样本"本身成为一种 FAIL。
function buildThresholdFailures(data, requests) {
  const failures = Object.entries(data.metrics)
    .filter(([, m]) => m.thresholds && Object.values(m.thresholds).some((t) => !t.ok))
    .map(([name]) => name);
  if (requests === 0) failures.push('no-samples(0-requests)');
  return failures;
}

export function toMarkers(summary) {
  return `\n${START}\n${JSON.stringify(summary)}\n${END}\n`;
}

export function fromLogs(text) {
  const i = text.lastIndexOf(START);
  const j = text.lastIndexOf(END);
  if (i === -1 || j === -1 || j < i) throw new Error('no summary markers in logs');
  return JSON.parse(text.slice(i + START.length, j).trim());
}

export function toHtml(s) {
  const verdict = s.thresholdFailures.length === 0 ? 'PASS' : 'FAIL';
  const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  const f = (x) => (x === null || x === undefined ? '-' : x);
  const lat = (o) => (o ? `p50=${f(o.p50)} / p95=${f(o.p95)} / p99=${f(o.p99)}` : '-');
  return `<!doctype html><meta charset="utf-8"><title>${s.testid}</title>
<h1>${s.testid} &mdash; ${verdict}</h1><table border="1" cellpadding="6">
${row('requests', s.requests)}${row('rps', Number(s.rps).toFixed(1))}
${row('ok / technical / business / script', `${s.ok} / ${s.errTechnical} / ${s.errBusiness} / ${s.errScript}`)}
${row('business success rate', s.businessSuccessRate === null ? '-' : s.businessSuccessRate)}
${row('latency all (ms)', lat(s.latencyMs))}
${row('latency success-only (ms)', lat(s.successLatencyMs))}
${row('http error rate', s.errorRate)}
${row('failed thresholds', s.thresholdFailures.join(', ') || 'none')}
</table>`;
}
