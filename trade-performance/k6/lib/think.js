/*
 * lib/think.js —— think time（用户停顿）
 *
 * ── 为什么 E2E 必须有 think time ──
 * E2E 测的是"N 个真实用户的行为对系统的压力"，用户填表、看结果的停顿
 * 决定了单用户的请求节奏。去掉 think time 的 E2E 等于换了一个负载模型——
 * 和单接口容量测试重复，却又不如后者可控。
 *
 * ── ⚠ 不要用 group() 计"含 think 的旅程耗时" ──
 * k6 的 group_duration **包含 sleep**。
 * 业务耗时看分步指标（summary 的"分步耗时"段）。
 *
 * ── THINK_SCALE ──
 * 调试脚本时干等 5 秒纯属浪费：-e THINK_SCALE=0 跳过全部停顿。
 * ⚠ 只用于调试。正式轮次改 scale 等于改负载模型；overrides 会被 run.sh
 *   原样写进 manifest，事后可查——但报告里必须声明。
 */

import { sleep } from 'k6';

const SCALE = (() => {
  const v = __ENV.THINK_SCALE;
  if (v === undefined || v === '') return 1;
  const n = parseFloat(v);
  if (isNaN(n) || n < 0) throw new Error(`-e THINK_SCALE=${v} 不是 >= 0 的数`);
  return n;
})();

/**
 * 均匀分布停顿 base ~ base+range 毫秒，与 UniformRandomTimer 语义一致。
 * 随机（而非固定值）是为了避免全部 VU 同步呼吸——固定停顿会让请求
 * 到达变成整齐的波峰波谷，那不是任何真实用户群的形态。
 */
export function think(baseMs, rangeMs) {
  if (SCALE <= 0) return;
  const ms = (baseMs + Math.random() * (rangeMs || 0)) * SCALE;
  sleep(ms / 1000);
}
