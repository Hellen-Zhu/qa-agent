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

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function padL(s, w) {
  s = String(s);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
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
  L.push(`  ${pad('ok', 12)}${padL(ok, 8)}   业务成功`);
  L.push(`  ${pad('technical', 12)}${padL(tech, 8)}   连接失败/超时/5xx ← 这才是性能结论`);
  L.push(`  ${pad('business', 12)}${padL(biz, 8)}   HTTP 200 但业务拒绝 ← 多半是数据失效`);
  L.push(`  ${pad('script', 12)}${padL(scr, 8)}   脚本 bug ← 结果作废`);
  L.push(`  ${pad('总计', 10)}${padL(total, 8)}`);
  L.push('');

  if (tech > 0) L.push('  ⚠ 存在 technical 错误 —— 这是性能结论的一部分，不要当噪音过滤掉');
  if (scr > 0) L.push('  ✗ 存在 script 错误 —— 本轮结果不可用，先修脚本');
  if (biz > 0 && tech === 0) L.push('  ⚠ 只有 business 错误 —— 先查数据是否失效，不要当成性能问题上报');
  if (tech > 0 || scr > 0 || biz > 0) L.push('');

  // ── 耗时 ─────────────────────────────────────────────────
  L.push('── 耗时（仅业务成功的请求）────────────────────────');
  if (succ && succ.count > 0) {
    L.push(`  样本数        ${padL(succ.count, 8)}`);
    L.push(`  P50 (med)     ${padL(num(succ.med), 8)} ms`);
    L.push(`  P90           ${padL(num(succ['p(90)']), 8)} ms`);
    L.push(`  P95           ${padL(num(succ['p(95)']), 8)} ms`);
    L.push(`  max           ${padL(num(succ.max), 8)} ms`);
    if (succ.med > 0) {
      const ratio = succ['p(95)'] / succ.med;
      L.push(`  P95 / P50     ${padL(ratio.toFixed(2), 8)}     ${ratio > 3 ? '← 比值大，存在慢路径（.dat 解析？定价？）' : ''}`);
    }
  } else {
    L.push('  （没有业务成功的请求）');
  }
  if (all && all.count > 0 && succ && succ.count !== all.count) {
    L.push(`  —— 全部请求（含失败）P95 = ${num(all['p(95)'])} ms，共 ${all.count} 笔`);
    L.push('     失败请求通常更快，混在一起会让 P95 偏乐观');
  }
  L.push('');

  // ── 吞吐 ─────────────────────────────────────────────────
  L.push('── 吞吐 ───────────────────────────────────────────');
  L.push(`  运行时长      ${padL(num(durSec, 1), 8)} s`);
  L.push(`  业务成功 TPS  ${padL(durSec > 0 ? (ok / durSec).toFixed(3) : '-', 8)}`);
  const vus = m(data, 'vus_max');
  if (vus) L.push(`  峰值 VU       ${padL(vus.max, 8)}`);
  L.push('');

  // ── 样本量纪律 ────────────────────────────────────────────
  // 低吞吐系统最容易踩的坑：样本不够时 P95 是个随机数。
  const n = succ ? succ.count : 0;
  if (n > 0 && n < 100) {
    L.push('  ✗ 样本数 < 100 —— **P95 不可信，不要写进报告**');
    L.push(`     样本数 = VU 数 × 时长 ÷ 单笔耗时。当前单笔约 ${num(succ.med)}ms，`);
    L.push(`     要凑够 300 个样本需要约 ${num((succ.med * 300) / 1000 / Math.max(1, vus ? vus.max : 1), 0)} 秒（按当前 VU 数）`);
    L.push('');
  } else if (n >= 100 && n < 300) {
    L.push('  ⚠ 样本数 100~300 —— P95 勉强可用，正式基线建议跑到 300 以上');
    L.push('');
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
    .reduce((a, b) => a.concat(b), []);

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
