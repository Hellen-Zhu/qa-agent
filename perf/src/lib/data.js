// Deterministic pick from the parameter pool: i is the global monotonic cursor
// (exec.scenario.iterationInTest), giving uniform coverage and reproducibility — replaces the
// old vu*31+iter hash (skewed, and not reproducible under arrival models).
export function pickAt(pool, i) {
  if (!Array.isArray(pool) || pool.length === 0) throw new Error('empty param pool');
  return pool[Math.abs(i) % pool.length];
}
