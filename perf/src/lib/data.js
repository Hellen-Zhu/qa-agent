// 参数池确定性选取：vu*31+iter 让不同 VU/迭代散布到不同参数，避免全场压同一条热点。
export function pick(pool, vu, iter) {
  if (!Array.isArray(pool) || pool.length === 0) throw new Error('empty param pool');
  return pool[(Math.abs(vu) * 31 + Math.abs(iter)) % pool.length];
}
