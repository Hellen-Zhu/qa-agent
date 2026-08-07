// Pure report logic (no dependency on k6 globals; Node can load it directly for offline verification).
// Output is assembled by bootstrap.stdHandleSummary into two channels (mechanism taken from trade-performance):
//   stdout                    human-readable text summary — once handleSummary is exported, k6 no
//                             longer prints its default summary; this file owns all terminal output
//   $RESULT_DIR/summary.txt   the same text written to disk
//   $RESULT_DIR/summary.json  machine-readable — the runner extracts verdict to set the exit code;
//                             also the input for later baseline comparison (P1)
// k6 writes the files itself (handleSummary returns a {path: content} map); the runner does zero post-processing.

function val(data, name, key, dflt) {
  const m = data.metrics[name];
  return m && m.values && m.values[key] !== undefined ? m.values[key] : dflt;
}

export function summarize(data, testid) {
  const requests = val(data, 'http_reqs', 'count', 0);
  const thresholdFailures = buildThresholdFailures(data, requests);
  return {
    testid,
    // The runner (run.sh) uses sed to extract this field from summary.json to decide PASS/FAIL — renaming it requires updating run.sh in sync
    verdict: thresholdFailures.length === 0 ? 'PASS' : 'FAIL',
    requests,
    rps: val(data, 'http_reqs', 'rate', 0),
    // Three-class: the report must present them separately — blended into a single error rate they cannot answer "is this a dev problem or a data problem"
    ok: val(data, 'perf_ok', 'count', 0),
    errTechnical: val(data, 'perf_err_technical', 'count', 0),
    errBusiness: val(data, 'perf_err_business', 'count', 0),
    errScript: val(data, 'perf_err_script', 'count', 0),
    businessSuccessRate: val(data, 'perf_business_success', 'rate', null),
    // All-request latency (failures included) side by side with business-success latency — the gap between the two is itself a signal
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

// thresholdFailures drives the runner's PASS/FAIL (whether its length is 0). With 0 requests
// (e.g. a preflight abort: handleSummary still runs after exec.test.abort) no metric crosses any
// threshold — the array is naturally empty, the run would be judged PASS, and a false green would
// wave through a round that should have failed. Synthesize a 'no-samples(0-requests)' marker so
// that "0 samples" is itself a kind of FAIL.
function buildThresholdFailures(data, requests) {
  const failures = Object.entries(data.metrics)
    .filter(([, m]) => m.thresholds && Object.values(m.thresholds).some((t) => !t.ok))
    .map(([name]) => name);
  if (requests === 0) failures.push('no-samples(0-requests)');
  return failures;
}

// ── Text summary (modeled on trade-performance lib/summary.js, rewritten for this framework's metric names) ────
// ⚠ Table labels use ASCII only: a CJK character has String.length=1 but occupies 2 terminal
//   columns, so padL alignment is guaranteed wrong (tp wrote a display-width-aware padD for
//   that — with no CJK in labels, none of that machinery is needed).

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

// Switch to seconds display above 10s: one 60000 would skew the whole line, and timeout samples are exactly the rows that most need to stay readable
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

export function buildTextSummary(data, meta, cmp) {
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

  // ── Three-class classification ────────────────────────────
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

  // ── Response time (full round trip, NOT TTFB — in JMeter parlance "Latency" means TTFB, do not conflate) ──
  L.push('── Response time (ms) ─────────────────────────────');
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

  // ── Per-API latency (SLA sub-metrics) ────────────────────
  // The percentile thresholds from config/slas/ hang off perf_success_duration{name:...}; k6
  // generates sub-metrics only for tag combinations with declared thresholds — wherever an SLA
  // is attached, a row appears automatically.
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
    L.push('── Per-API response time (ms, success samples) ────');
    L.push('    ' + padR('', w) + PCT_COLS.map((c) => padL(c, 8)).join('') + padL('n', 8));
    apiRows.forEach((r) => L.push(pctRow(r.label, w, r.vals) + padL(r.vals.count, 8)));
    L.push('');
  }

  // ── Throughput ────────────────────────────────────────────
  L.push('── Throughput ─────────────────────────────────────');
  L.push(`  duration          ${padL(num(durSec, 1), 8)} s`);
  L.push(`  business-ok TPS   ${padL(durSec > 0 ? (ok / durSec).toFixed(3) : '-', 8)}`);
  const vusMax = val(data, 'vus_max', 'max', null);
  if (vusMax !== null) L.push(`  peak VU           ${padL(vusMax, 8)}`);
  L.push('');

  // ── Sample-size discipline ────────────────────────────────
  // Rule of thumb: for percentile p to be trustworthy, ~10 samples must fall beyond it → n ≥ 10/(1-p)
  //     P95 → 200 samples    P99 → 1000 samples
  // Classic low-throughput trap: with too few samples the percentile is just a random number,
  // and the report shows no trace of it.
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

  // ── Threshold list and verdict ────────────────────────────
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

  // ── Baseline comparison (appears only when a baseline exists) ──
  if (cmp) {
    L.push('── Baseline comparison ────────────────────────────');
    L.push(`  vs ${cmp.baselineTestid}`);
    if (!cmp.comparable) {
      L.push(`  (not comparable: ${cmp.reason})`);
    } else {
      L.push('    ' + padR('', 12) + padL('base', 8) + padL('curr', 8) + padL('delta', 9));
      cmp.rows.forEach((r) => {
        L.push(
          '    ' + padR(r.key, 12) + padL(r.base, 8) + padL(r.cur, 8) +
          padL(r.delta === null ? '-' : r.delta, 9) + (r.bad ? '  ✗' : '')
        );
      });
      if (cmp.regressions.length > 0) {
        L.push(`  ✗ ${cmp.regressions.length} regression(s) beyond tolerance (response time +${cmp.tolPct}%, biz-success -1.0pp)`);
        L.push('    informational only — verdict comes from thresholds, not baseline');
      } else {
        L.push(`  ✓ all within tolerance (response time +${cmp.tolPct}%, biz-success -1.0pp)`);
      }
    }
    L.push('');
  }

  const verdict = buildThresholdFailures(data, requests).length === 0 ? 'PASS' : 'FAIL';
  L.push(`  VERDICT: ${verdict}`);
  L.push('══════════════════════════════════════════════════════════');
  L.push('');
  return L.join('\n');
}

// ── Baseline comparison pure logic ──────────────────────────
// current/baseline are both summarize() output — a baseline is not a new format, it is just the
// summary.json of some trusted run promoted (cp) into place. The comparison dimensions are
// deliberately narrow:
//   success-latency P50/P95/P99 increase (tolerance tolPct%, default 10)
//   business success-rate drop (tolerance 1pp)
//   technical going from none to some (baseline 0 while this run >0)
// rps is not compared: under the open model the rate is configured by the profile, so comparing
// it carries no information.
// The result only advises and never changes the verdict — the verdict authority is always the
// thresholds (spec §9).
function pct(v) {
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
}

export function compareBaseline(current, baseline, tolPct) {
  const tol = tolPct === undefined || tolPct === null || isNaN(tolPct) ? 10 : tolPct;
  const cmp = {
    baselineTestid: (baseline && baseline.testid) || 'unknown',
    tolPct: tol,
    comparable: true,
    rows: [],
    regressions: [],
  };
  if (!current.ok || current.ok === 0) {
    return Object.assign(cmp, { comparable: false, reason: 'no business-successful requests in current run' });
  }
  if (!baseline.ok || baseline.ok === 0) {
    return Object.assign(cmp, { comparable: false, reason: 'baseline has no business-successful samples (bad promotion?)' });
  }

  ['p50', 'p95', 'p99'].forEach((k) => {
    const b = (baseline.successLatencyMs || {})[k];
    const c = (current.successLatencyMs || {})[k];
    if (b === null || b === undefined || c === null || c === undefined || b === 0) {
      cmp.rows.push({ key: k.toUpperCase(), base: '-', cur: '-', delta: null, bad: false });
      return;
    }
    const d = ((c - b) / b) * 100;
    const bad = d > tol;
    cmp.rows.push({ key: k.toUpperCase(), base: b.toFixed(0), cur: c.toFixed(0), delta: pct(d), bad });
    if (bad) cmp.regressions.push(`${k.toUpperCase()} ${pct(d)} beyond +${tol}%`);
  });

  const bRate = baseline.businessSuccessRate;
  const cRate = current.businessSuccessRate;
  if (bRate !== null && bRate !== undefined && cRate !== null && cRate !== undefined) {
    const dPp = (cRate - bRate) * 100;
    const bad = dPp < -1.0;
    cmp.rows.push({
      key: 'biz-ok', base: (bRate * 100).toFixed(1) + '%', cur: (cRate * 100).toFixed(1) + '%',
      delta: (dPp >= 0 ? '+' : '') + dPp.toFixed(1) + 'pp', bad,
    });
    if (bad) cmp.regressions.push(`biz-success ${dPp.toFixed(1)}pp beyond -1.0pp`);
  }

  const techBad = (baseline.errTechnical || 0) === 0 && (current.errTechnical || 0) > 0;
  cmp.rows.push({ key: 'technical', base: baseline.errTechnical || 0, cur: current.errTechnical || 0, delta: null, bad: techBad });
  if (techBad) cmp.regressions.push(`technical errors appeared (baseline had 0, current ${current.errTechnical})`);

  // Show sample counts side by side: percentile trustworthiness tracks sample size, and the reader needs to see when the two sides' samples differ wildly
  cmp.rows.push({ key: 'ok-samples', base: baseline.ok, cur: current.ok, delta: null, bad: false });
  return cmp;
}
