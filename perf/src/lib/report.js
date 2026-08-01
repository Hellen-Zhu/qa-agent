// 报告纯逻辑（不依赖 k6 全局量，Node 亦可直接加载做离线验证）。
// 输出由 bootstrap.stdHandleSummary 组装成两路（机制取自 trade-performance）：
//   stdout                    人读文本摘要——导出 handleSummary 后 k6 不再打印
//                             默认摘要，本文件负责全部终端输出
//   $RESULT_DIR/summary.txt   同一份文本落盘
//   $RESULT_DIR/summary.json  机器可读——runner 提取 verdict 定退出码，
//                             也是后续基线对比（P1）的输入
// 文件由 k6 自己写盘（handleSummary 返回 {路径: 内容} 映射），runner 零后处理。

function val(data, name, key, dflt) {
  const m = data.metrics[name];
  return m && m.values && m.values[key] !== undefined ? m.values[key] : dflt;
}

export function summarize(data, testid) {
  const requests = val(data, 'http_reqs', 'count', 0);
  const thresholdFailures = buildThresholdFailures(data, requests);
  return {
    testid,
    // runner（run.sh）用 sed 从 summary.json 提取本字段定 PASS/FAIL——改名须同步 run.sh
    verdict: thresholdFailures.length === 0 ? 'PASS' : 'FAIL',
    requests,
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
    thresholdFailures,
  };
}

// thresholdFailures 驱动 runner 的 PASS/FAIL（长度是否为 0）。0 请求（如 preflight
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

// ── 文本摘要（参考 trade-performance lib/summary.js，按本框架指标名改写）────
// ⚠ 表格标签只用 ASCII：CJK 字符 String.length=1 但占 2 终端列，padL 对齐必错
//   （tp 为此写了按显示宽度补齐的 padD——标签不含 CJK 就用不上那套）。

function num(v, digits) {
  if (v === undefined || v === null || isNaN(v)) return '-';
  return v.toFixed(digits === undefined ? 0 : digits);
}

function padL(s, w) {
  s = String(s);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function padR(s, w) {
  s = String(s);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

// 超过 10 秒切换为秒显示：一个 60000 会把整行挤歪，而超时样本恰是最需要可读的行
function fmtMs(v) {
  if (v === undefined || v === null || isNaN(v)) return padL('-', 8);
  return v < 10000 ? padL(v.toFixed(0), 8) : padL((v / 1000).toFixed(1) + 's', 8);
}

const PCT_COLS = ['P50', 'P90', 'P95', 'P99', 'max', 'avg'];

function pctRow(label, w, vals) {
  return (
    '    ' + padR(label, w) +
    fmtMs(vals.med) + fmtMs(vals['p(90)']) + fmtMs(vals['p(95)']) +
    fmtMs(vals['p(99)']) + fmtMs(vals.max) + fmtMs(vals.avg)
  );
}

export function buildTextSummary(data, meta) {
  const L = [];
  const durSec = (data.state.testRunDurationMs || 0) / 1000;

  const ok = val(data, 'perf_ok', 'count', 0);
  const tech = val(data, 'perf_err_technical', 'count', 0);
  const biz = val(data, 'perf_err_business', 'count', 0);
  const scr = val(data, 'perf_err_script', 'count', 0);
  const total = ok + tech + biz + scr;
  const requests = val(data, 'http_reqs', 'count', 0);

  const succ = (data.metrics['perf_success_duration'] || {}).values;
  const all = (data.metrics['http_req_duration'] || {}).values;

  L.push('');
  L.push('══════════════════════════════════════════════════════════');
  L.push(`  ${meta.testid}`);
  L.push(`  env=${meta.env}  profile=${meta.profile}`);
  L.push('══════════════════════════════════════════════════════════');
  L.push('');

  // ── 三分类 ────────────────────────────────────────────────
  L.push('── Result classification ──────────────────────────');
  L.push(`  ${padR('ok', 12)}${padL(ok, 8)}   business success`);
  L.push(`  ${padR('technical', 12)}${padL(tech, 8)}   connect fail/timeout/5xx <- THE performance conclusion`);
  L.push(`  ${padR('business', 12)}${padL(biz, 8)}   HTTP 200 but business rejection <- usually a data problem`);
  L.push(`  ${padR('script', 12)}${padL(scr, 8)}   script bug <- run is void`);
  L.push(`  ${padR('total', 12)}${padL(total, 8)}`);
  L.push('');
  if (scr > 0) L.push('  ✗ script errors present — this run is unusable, fix the script first');
  if (tech > 0) L.push('  ⚠ technical errors present — they ARE the performance conclusion, not noise');
  if (biz > 0 && tech === 0) L.push('  ⚠ business errors only — triage by reason first (stale data?)');
  if (tech > 0 || scr > 0 || biz > 0) {
    L.push('  Reason samples in k6.log (capped 3 per reason per VU); per-request detail in result.csv');
    L.push('');
  }

  // ── 延迟 ──────────────────────────────────────────────────
  L.push('── Latency (ms) ───────────────────────────────────');
  if (succ && succ.count > 0) {
    L.push('    ' + padR('', 10) + PCT_COLS.map((c) => padL(c, 8)).join(''));
    L.push(pctRow('success', 10, succ));
    if (all && all.count > 0 && succ.count !== all.count) {
      L.push(pctRow('all', 10, all));
      L.push('    (failed requests usually return faster; mixing them in flatters the percentiles)');
    }
    L.push('');
    L.push(`    samples   ${padL(succ.count, 8)}`);
    if (succ.med > 0) {
      const ratio = succ['p(95)'] / succ.med;
      L.push(
        `    P95/P50   ${padL(ratio.toFixed(2) + 'x', 8)}     ` +
        (ratio > 3 ? '<- large ratio: a slow path exists' : '(tight distribution)')
      );
    }
  } else {
    L.push('  (no business-successful requests)');
  }
  L.push('');

  // ── 按 API 延迟（SLA 子指标）─────────────────────────────
  // config/slas/ 的分位数阈值挂在 perf_success_duration{name:...} 上，k6 只为
  // 声明了阈值的 tag 组合生成子指标——SLA 挂在哪，哪里就自动出现一行。
  const apiRows = Object.keys(data.metrics)
    .filter((k) => k.startsWith('perf_success_duration{'))
    .map((k) => {
      const nm = /\{name:([^,}]+)/.exec(k);
      return { label: nm ? nm[1] : k, vals: data.metrics[k].values };
    })
    .filter((r) => r.vals && r.vals.count > 0)
    .sort((a, b) => (a.label < b.label ? -1 : 1));
  if (apiRows.length > 0) {
    const w = Math.max.apply(null, apiRows.map((r) => r.label.length).concat([8])) + 2;
    L.push('── Per-API latency (ms, success samples) ──────────');
    L.push('    ' + padR('', w) + PCT_COLS.map((c) => padL(c, 8)).join('') + padL('n', 8));
    apiRows.forEach((r) => L.push(pctRow(r.label, w, r.vals) + padL(r.vals.count, 8)));
    L.push('');
  }

  // ── 吞吐 ──────────────────────────────────────────────────
  L.push('── Throughput ─────────────────────────────────────');
  L.push(`  duration          ${padL(num(durSec, 1), 8)} s`);
  L.push(`  business-ok TPS   ${padL(durSec > 0 ? (ok / durSec).toFixed(3) : '-', 8)}`);
  const vusMax = val(data, 'vus_max', 'max', null);
  if (vusMax !== null) L.push(`  peak VU           ${padL(vusMax, 8)}`);
  L.push('');

  // ── 样本量纪律 ────────────────────────────────────────────
  // 经验法则：分位数 p 可信需 ~10 个样本落在其外 → n ≥ 10/(1-p)
  //     P95 → 200 样本    P99 → 1000 样本
  // 低吞吐经典陷阱：样本不足时分位数就是随机数，且报告上毫无迹象。
  const n = succ ? succ.count : 0;
  if (n > 0 && succ.med > 0) {
    const vuBase = Math.max(1, vusMax || 1);
    const secFor = (target) => (succ.med * target) / 1000 / vuBase;
    const notes = [];
    if (n < 200) notes.push(`✗ P95 not trustworthy — needs >=200 samples, have ${n}; run ~${num(secFor(200), 0)}s more at this VU count`);
    else if (n < 1000) notes.push(`⚠ P99 not trustworthy — needs >=1000 samples, have ${n}; run ~${num(secFor(1000), 0)}s more at this VU count`);
    if (notes.length > 0) {
      L.push('── Sample size ────────────────────────────────────');
      notes.forEach((x) => L.push('  ' + x));
      L.push('');
    }
  }

  // ── 阈值清单与判定 ────────────────────────────────────────
  const thr = Object.keys(data.metrics)
    .filter((k) => data.metrics[k].thresholds)
    .flatMap((k) =>
      Object.keys(data.metrics[k].thresholds).map((expr) => ({
        metric: k,
        expr,
        ok: data.metrics[k].thresholds[expr].ok === true,
      }))
    );
  if (thr.length > 0) {
    L.push('── Thresholds ─────────────────────────────────────');
    thr.forEach((t) => L.push(`  ${t.ok ? '✓' : '✗'} ${t.metric} ${t.expr}`));
    L.push('');
  }
  if (requests === 0) {
    L.push('  ✗ 0 requests sent — verdict is FAIL regardless of thresholds (preflight abort / init error?)');
    L.push('');
  }

  const verdict = buildThresholdFailures(data, requests).length === 0 ? 'PASS' : 'FAIL';
  L.push(`  VERDICT: ${verdict}`);
  L.push('══════════════════════════════════════════════════════════');
  L.push('');
  return L.join('\n');
}
