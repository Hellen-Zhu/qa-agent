// 参数池确定性取数：i 为全局单调游标（exec.scenario.iterationInTest），
// 均匀覆盖且可复现——取代旧的 vu*31+iter 哈希（有偏斜、arrival 模型下不可复现）。
export function pickAt(pool, i) {
  if (!Array.isArray(pool) || pool.length === 0) throw new Error('empty param pool');
  return pool[Math.abs(i) % pool.length];
}
