/*
 * lib/summary.js —— 自定义收尾报告
 *
 * 为什么不用官方的 textSummary：
 * 它在 https://jslib.k6.io/k6-summary/... 上，需要跑测试时联外网 ——
 * 银行环境多半被墙，而且引入一条无人审计的供应链。自己写反而能打印
 * **本项目真正关心的东西**，而不是一堆通用指标。
 *
 * ⚠ 导出 handleSummary 后 k6 就不再打印默认摘要 —— 本文件负责全部输出。
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
 * 超过 10 秒改用秒显示：
 * 否则一个 60000 会把整行挤歪，而超时样本恰恰是最该看清的那一行。
 */
function fmtMs(v) {
  if (v === undefined || v === null || isNaN(v)) return padL('-', 8);
  return v < 10000 ? padL(v.toFixed(0), 8) : padL((v / 1000).toFixed(1) + 's', 8);
}

/*
 * ⚠ 中文字符的 String.length 是 1，但终端里占 2 列。
 *   用 pad() 对齐含中文的表格，表头和数据行必然错位 —— 而且只在有中文的那几行错，
 *   看上去像"某几行数据不对"。这里按**显示宽度**补齐。
 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch)
      ? 2 : 1;
  }
  return w;
}

function padD(s, w) {
  const d = dispWidth(s);
  return d >= w ? String(s) : String(s) + ' '.repeat(w - d);
}

// 列定义只写一次，表头由它生成 —— 改列时不可能忘了同步表头
const PCT_COLS = ['P50', 'P90', 'P95', 'P99', 'max', 'avg'];
const PCT_INDENT = 14;

function pctHeader() {
  return ' '.repeat(PCT_INDENT) + PCT_COLS.map((c) => padL(c, 8)).join('');
}

/** 一行分位数 */
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

  // ── 三类错误分离 ──────────────────────────────────────────
  L.push('── 结果分类 ────────────────────────────────────────');
  L.push(`  ${padD('ok', 12)}${padL(ok, 8)}   业务成功`);
  L.push(`  ${padD('technical', 12)}${padL(tech, 8)}   连接失败/超时/5xx ← 这才是性能结论`);
  L.push(`  ${padD('business', 12)}${padL(biz, 8)}   HTTP 200 但业务拒绝 ← 多半是数据失效`);
  L.push(`  ${padD('script', 12)}${padL(scr, 8)}   脚本 bug ← 结果作废`);
  L.push(`  ${padD('总计', 12)}${padL(total, 8)}`);
  L.push('');

  if (tech > 0) L.push('  ⚠ 存在 technical 错误 —— 这是性能结论的一部分，不要当噪音过滤掉');
  if (scr > 0) L.push('  ✗ 存在 script 错误 —— 本轮结果不可用，先修脚本');
  if (biz > 0 && tech === 0) L.push('  ⚠ 只有 business 错误 —— 先查数据是否失效，不要当成性能问题上报');
  if (tech > 0 || scr > 0 || biz > 0) L.push('');

  // ── 耗时 ─────────────────────────────────────────────────
  L.push('── 耗时 (ms) ──────────────────────────────────────');
  if (succ && succ.count > 0) {
    L.push(pctHeader());
    L.push(pctRow('成功样本', succ));
    if (all && all.count > 0 && succ.count !== all.count) {
      L.push(pctRow('全部样本', all));
      L.push('    （失败请求通常返回更快，混在一起会让分位数偏乐观）');
    }
    L.push('');
    L.push(`    样本数    ${padL(succ.count, 8)}`);
    if (succ.med > 0) {
      const ratio = succ['p(95)'] / succ.med;
      L.push(
        `    P95/P50   ${padL(ratio.toFixed(2) + '×', 8)}     ` +
        (ratio > 3 ? '← 比值大，存在慢路径（.dat 解析？定价？）' : '（分布集中）')
      );
    }
  } else {
    L.push('  （没有业务成功的请求）');
  }
  L.push('');

  // ── 分步耗时（E2E 场景）─────────────────────────────────
  // 上面的"成功样本"在 E2E 里是**多个 API 混在一起**的分布，单看会误导。
  // 分步数据靠 k6 的子指标机制取得：scenario 在 thresholds 里声明
  //   'oreo_success_duration{name:X}': ['max>=0']
  // 哨兵阈值恒真，存在的唯一意义是让该子指标出现在 summary 数据里
  // （k6 只为声明过阈值的 tag 组合生成子指标）。单接口场景没有这些声明，
  // 本段自动不出现。
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
    L.push('── 分步耗时 (ms，成功样本) ────────────────────────');
    L.push('    ' + ' '.repeat(w) + PCT_COLS.map((c) => padL(c, 8)).join('') + padL('n', 8));
    stepRows.forEach((r) => {
      L.push(
        '    ' + padD(r.label, w) +
        fmtMs(r.vals.med) + fmtMs(r.vals['p(90)']) + fmtMs(r.vals['p(95)']) +
        fmtMs(r.vals['p(99)']) + fmtMs(r.vals.max) + fmtMs(r.vals.avg) +
        padL(r.vals.count, 8)
      );
    });
    L.push('    ⚠ 各步相加不等于"旅程耗时"—— think time 不在其中，且失败的步骤会缺样本');
    L.push('');
  }

  // ── 吞吐 ─────────────────────────────────────────────────
  L.push('── 吞吐 ───────────────────────────────────────────');
  L.push(`  运行时长      ${padL(num(durSec, 1), 8)} s`);
  L.push(`  业务成功 TPS  ${padL(durSec > 0 ? (ok / durSec).toFixed(3) : '-', 8)}`);
  const vus = m(data, 'vus_max');
  if (vus) L.push(`  峰值 VU       ${padL(vus.max, 8)}`);
  L.push('');

  // ── 样本量纪律 ────────────────────────────────────────────
  // 经验规则：一个分位数 p 要可信，至少要有 ~10 个样本落在它之外 → n ≥ 10/(1-p)
  //     P95 → 200 个     P99 → 1000 个
  // 低吞吐系统最容易踩的坑：样本不够时分位数就是个随机数，而报告上完全看不出来。
  // P99 现在参与验收判据（PERF-07 要求 P99 ≤ 8,000ms），所以必须显式提示。
  const n = succ ? succ.count : 0;
  if (n > 0 && succ.med > 0) {
    const vuMax = Math.max(1, vus ? vus.max : 1);
    const secFor = (target) => (succ.med * target) / 1000 / vuMax;
    const notes = [];
    if (n < 200) {
      notes.push(`✗ P95 不可信 —— 需 ≥200 个样本，当前 ${n}。当前 VU 数下需跑约 ${num(secFor(200), 0)} 秒`);
    }
    if (n < 1000) {
      notes.push(`⚠ P99 不可信 —— 需 ≥1000 个样本，当前 ${n}。当前 VU 数下需跑约 ${num(secFor(1000), 0)} 秒`);
    }
    if (notes.length > 0) {
      L.push('── 样本量 ─────────────────────────────────────────');
      notes.forEach((x) => L.push('  ' + x));
      L.push('  精度要求应与余量挂钩：实测值与阈值相差一个数量级时，');
      L.push('  分位数不精确不影响判定 —— 但报告里必须写明样本量。');
      L.push('');
    }
  }

  // ── 阈值 ─────────────────────────────────────────────────
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
    // 'max>=0' 是分步耗时的哨兵阈值（见上），恒真无信息量，不进判定清单
    .filter((t) => t.expr !== 'max>=0');

  if (thr.length > 0) {
    L.push('── 阈值 ───────────────────────────────────────────');
    thr.forEach((t) => {
      L.push(`  ${t.ok ? '✓' : '✗'} ${t.metric} ${t.expr}`);
    });
    L.push('');
  }

  L.push('══════════════════════════════════════════════════════════');
  L.push('');
  return L.join('\n');
}
