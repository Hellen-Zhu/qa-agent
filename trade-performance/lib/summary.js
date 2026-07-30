/*
 * lib/summary.js — custom end-of-run report
 *
 * Why not the official textSummary:
 * it lives on https://jslib.k6.io/k6-summary/..., so running a test needs
 * outbound internet — usually walled off in a bank environment — and it
 * pulls in an unaudited supply chain. Writing our own also means printing
 * **what this project actually cares about** instead of a pile of generic
 * metrics.
 *
 * ⚠ Once handleSummary is exported, k6 stops printing its default summary —
 *   this file is responsible for ALL output.
 */

function m(data, name) {
  const metric = data.metrics[name];
  return metric ? metric.values : null;
}

function num(v, digits) {
  if (v === undefined || v === null || isNaN(v)) return '-';
  return v.toFixed(digits === undefined ? 0 : digits);
}

function padL(s, w) {
  s = String(s);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

/**
 * Switch to seconds above 10 seconds:
 * otherwise a 60000 skews the whole row, and timeout samples are exactly
 * the rows that most need to be readable.
 */
function fmtMs(v) {
  if (v === undefined || v === null || isNaN(v)) return padL('-', 8);
  return v < 10000 ? padL(v.toFixed(0), 8) : padL((v / 1000).toFixed(1) + 's', 8);
}

/*
 * ⚠ A CJK character has String.length 1 but occupies 2 terminal columns.
 *   Aligning a table that contains CJK with pad() guarantees the header and
 *   data rows drift apart — and only on the rows that contain CJK, which
 *   looks like "some rows have bad data". Pad by **display width** instead
 *   (values/labels may still contain CJK).
 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch)
      ? 2 : 1;
  }
  return w;
}

function padD(s, w) {
  const d = dispWidth(s);
  return d >= w ? String(s) : String(s) + ' '.repeat(w - d);
}

// Column definitions written once; the header is generated from them — a
// column change cannot forget to update the header
const PCT_COLS = ['P50', 'P90', 'P95', 'P99', 'max', 'avg'];
const PCT_INDENT = 14;

function pctHeader() {
  return ' '.repeat(PCT_INDENT) + PCT_COLS.map((c) => padL(c, 8)).join('');
}

/** One row of percentiles */
function pctRow(label, vals) {
  return (
    '    ' + padD(label, PCT_INDENT - 4) +
    fmtMs(vals.med) + fmtMs(vals['p(90)']) + fmtMs(vals['p(95)']) +
    fmtMs(vals['p(99)']) + fmtMs(vals.max) + fmtMs(vals.avg)
  );
}

export function buildTextSummary(data, meta) {
  const L = [];
  const durSec = (data.state.testRunDurationMs || 0) / 1000;

  const ok = (m(data, 'oreo_ok') || {}).count || 0;
  const tech = (m(data, 'oreo_err_technical') || {}).count || 0;
  const biz = (m(data, 'oreo_err_business') || {}).count || 0;
  const scr = (m(data, 'oreo_err_script') || {}).count || 0;
  const total = ok + tech + biz + scr;

  const succ = m(data, 'oreo_success_duration');
  const all = m(data, 'http_req_duration');

  L.push('');
  L.push('══════════════════════════════════════════════════════════');
  L.push(`  ${meta.plan}   env=${meta.env}  profile=${meta.profile}`);
  L.push(`  ${meta.target}`);
  L.push('══════════════════════════════════════════════════════════');
  L.push('');

  // ── Three-way error separation ────────────────────────────
  L.push('── Result classification ──────────────────────────');
  L.push(`  ${padD('ok', 12)}${padL(ok, 8)}   business success`);
  L.push(`  ${padD('technical', 12)}${padL(tech, 8)}   connect fail/timeout/5xx ← THE performance conclusion`);
  L.push(`  ${padD('business', 12)}${padL(biz, 8)}   HTTP 200 but business rejection ← triage by reason`);
  L.push(`  ${padD('script', 12)}${padL(scr, 8)}   script bug ← run is void`);
  L.push(`  ${padD('total', 12)}${padL(total, 8)}`);
  L.push('');

  if (tech > 0) L.push('  ⚠ technical errors present — they are part of the performance conclusion, do not filter them out as noise');
  if (scr > 0) L.push('  ✗ script errors present — this run is unusable, fix the script first');
  if (biz > 0 && tech === 0) L.push('  ⚠ business errors only — triage by reason first: stale data? known server defect (dat race)?');
  if (tech > 0 || scr > 0 || biz > 0) {
    L.push('  Reason breakdown: raw samples in k6.log (capped at 3 per reason per VU),');
    L.push('  per-request detail in the reason tag column of result.csv (see lib/errors.js)');
    L.push('');
  }

  // ── Latency ──────────────────────────────────────────────
  L.push('── Latency (ms) ───────────────────────────────────');
  if (succ && succ.count > 0) {
    L.push(pctHeader());
    L.push(pctRow('success', succ));
    if (all && all.count > 0 && succ.count !== all.count) {
      L.push(pctRow('all', all));
      L.push('    (failed requests usually return faster; mixing them in makes percentiles look optimistic)');
    }
    L.push('');
    L.push(`    samples   ${padL(succ.count, 8)}`);
    if (succ.med > 0) {
      const ratio = succ['p(95)'] / succ.med;
      L.push(
        `    P95/P50   ${padL(ratio.toFixed(2) + '×', 8)}     ` +
        (ratio > 3 ? '← large ratio; a slow path exists (.dat parsing? pricing?)' : '(tight distribution)')
      );
    }
  } else {
    L.push('  (no business-successful requests)');
  }
  L.push('');

  // ── Per-step latency (E2E scenarios) ─────────────────────
  // The "success" row above is, in E2E, a distribution of **multiple APIs
  // mixed together** — misleading on its own. Per-step data comes from k6's
  // sub-metric mechanism: the scenario declares in thresholds
  //   'oreo_success_duration{name:X}': ['max>=0']
  // The sentinel threshold is always true; its sole purpose is to make that
  // sub-metric appear in the summary data (k6 only generates sub-metrics
  // for tag combinations with a declared threshold). Single-endpoint
  // scenarios have no such declarations, so this section auto-hides.
  const stepRows = Object.keys(data.metrics)
    .filter((k) => k.startsWith('oreo_success_duration{'))
    .map((k) => {
      const nm = /\{name:([^,}]+)/.exec(k);
      return {
        label: (nm ? nm[1] : k).replace(/^workers_trademgmt_/, ''),
        vals: data.metrics[k].values,
      };
    })
    .filter((r) => r.vals && r.vals.count > 0)
    .sort((a, b) => (a.label < b.label ? -1 : 1));

  if (stepRows.length > 0) {
    const w = Math.max.apply(null, stepRows.map((r) => dispWidth(r.label)).concat([8])) + 2;
    L.push('── Per-step latency (ms, success samples) ─────────');
    L.push('    ' + ' '.repeat(w) + PCT_COLS.map((c) => padL(c, 8)).join('') + padL('n', 8));
    stepRows.forEach((r) => {
      L.push(
        '    ' + padD(r.label, w) +
        fmtMs(r.vals.med) + fmtMs(r.vals['p(90)']) + fmtMs(r.vals['p(95)']) +
        fmtMs(r.vals['p(99)']) + fmtMs(r.vals.max) + fmtMs(r.vals.avg) +
        padL(r.vals.count, 8)
      );
    });
    L.push('    ⚠ steps do not sum to "journey time" — think time is excluded, and failed steps are missing samples');
    L.push('');
  }

  // ── Throughput ───────────────────────────────────────────
  L.push('── Throughput ─────────────────────────────────────');
  L.push(`  duration          ${padL(num(durSec, 1), 8)} s`);
  L.push(`  business-ok TPS   ${padL(durSec > 0 ? (ok / durSec).toFixed(3) : '-', 8)}`);
  const vus = m(data, 'vus_max');
  if (vus) L.push(`  peak VU           ${padL(vus.max, 8)}`);
  L.push('');

  // ── Sample-size discipline ────────────────────────────────
  // Rule of thumb: for percentile p to be trustworthy, ~10 samples must fall
  // beyond it → n ≥ 10/(1-p)
  //     P95 → 200 samples    P99 → 1000 samples
  // The classic low-throughput trap: with too few samples a percentile is a
  // random number, and the report shows no sign of it.
  // P99 now feeds the acceptance criteria (PERF-07 requires P99 ≤ 8,000ms),
  // so this must be flagged explicitly.
  const n = succ ? succ.count : 0;
  if (n > 0 && succ.med > 0) {
    const vuMax = Math.max(1, vus ? vus.max : 1);
    const secFor = (target) => (succ.med * target) / 1000 / vuMax;
    const notes = [];
    if (n < 200) {
      notes.push(`✗ P95 not trustworthy — needs ≥200 samples, have ${n}. At current VU count run ~${num(secFor(200), 0)} s`);
    }
    if (n < 1000) {
      notes.push(`⚠ P99 not trustworthy — needs ≥1000 samples, have ${n}. At current VU count run ~${num(secFor(1000), 0)} s`);
    }
    if (notes.length > 0) {
      L.push('── Sample size ────────────────────────────────────');
      notes.forEach((x) => L.push('  ' + x));
      L.push('  Precision requirements should track the margin: when measured value and');
      L.push('  threshold differ by an order of magnitude, imprecise percentiles do not');
      L.push('  change the verdict — but the report must state the sample size.');
      L.push('');
    }
  }

  // ── Thresholds ───────────────────────────────────────────
  const thr = Object.keys(data.metrics)
    .filter((k) => data.metrics[k].thresholds)
    .map((k) => {
      const t = data.metrics[k].thresholds;
      return Object.keys(t).map((expr) => ({
        metric: k,
        expr,
        ok: t[expr].ok === true,
      }));
    })
    .reduce((a, b) => a.concat(b), [])
    // 'max>=0' is the per-step latency sentinel threshold (see above) —
    // always true, zero information, excluded from the verdict list
    .filter((t) => t.expr !== 'max>=0');

  if (thr.length > 0) {
    L.push('── Thresholds ─────────────────────────────────────');
    thr.forEach((t) => {
      L.push(`  ${t.ok ? '✓' : '✗'} ${t.metric} ${t.expr}`);
    });
    L.push('');
  }

  L.push('══════════════════════════════════════════════════════════');
  L.push('');
  return L.join('\n');
}

/*
 * ── Standard wrap-up: three outputs in one package ────────────
 * The scenario side only declares meta (who it is, what target it hits);
 * the output boilerplate is collected here:
 *   stdout                     human-readable summary
 *   $RESULT_DIR/summary.txt    same summary on disk (run.sh / run.ps1 pass RESULT_DIR)
 *   $RESULT_DIR/summary.json   full raw data (machine-readable, for later processing)
 *
 * Usage (scenario file):
 *   export const handleSummary = makeHandleSummary(() => ({
 *     plan: PLAN, env: cfg.envName, profile: cfg.profileName,
 *     target: `${cfg.workersUrl}/trades/create`,
 *   }));
 *
 * meta is a callback, not an object: it is uniformly evaluated at test end —
 * all three scenarios are written identically, leaving no gap for "some
 * pass a value, some pass a function".
 * ⚠ This function references the k6 global __ENV but only evaluates it at
 *   run time — the file remains importable directly under node
 *   (buildTextSummary's offline verification depends on this).
 */
export function makeHandleSummary(metaFn) {
  return function handleSummary(data) {
    const text = buildTextSummary(data, metaFn());
    const out = { stdout: text };

    // the runner passes RESULT_DIR; a bare k6 run prints to screen only
    const dir = __ENV.RESULT_DIR;
    if (dir) {
      out[`${dir}/summary.txt`] = text;
      out[`${dir}/summary.json`] = JSON.stringify(data, null, 2);
    }
    return out;
  };
}
