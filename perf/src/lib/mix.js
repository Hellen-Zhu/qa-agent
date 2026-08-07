/*
 * Ratio splitter shared by all mixed entries (src/mixed/): ONE profile template scenario is
 * sliced into N parallel k6 scenarios, each pinned to its own exec function.
 * Splittable profiles: a scalar rate (open model — mix/mix-ref) or a scalar iterations count
 * (shared-iterations — smoke's one-shot-per-flow link check). Closed vus-only executors
 * (baseline/ladder) are rejected: their iteration volume is unknowable up front, so consumable
 * -pool preflights cannot budget and the mix ratio would silently drift once a pool runs dry.
 * Rounding may make the effective total drift from the nominal template — irrelevant at
 * capacity caliber; the floor of 1 keeps every flow present even at tiny trial volumes.
 */
export function splitByRatio(template, table) {
  if (template.rate === undefined && template.iterations === undefined) {
    throw new Error(
      'mixed entries require a profile with a scalar rate (mix/mix-ref) or iterations (smoke); ' +
      'closed vus-only profiles cannot preflight consumable pools'
    );
  }
  const out = {};
  for (const row of table) {
    const s = Object.assign({}, template);
    if (template.rate !== undefined) {
      s.rate = Math.max(1, Math.round(template.rate * row.ratio));
    } else {
      s.iterations = Math.max(1, Math.round(template.iterations * row.ratio));
      if (s.vus !== undefined) s.vus = Math.max(1, Math.min(Math.round(template.vus * row.ratio), s.iterations));
    }
    if (s.preAllocatedVUs !== undefined) s.preAllocatedVUs = Math.max(2, Math.round(template.preAllocatedVUs * row.ratio));
    if (s.maxVUs !== undefined) s.maxVUs = Math.max(5, Math.round(template.maxVUs * row.ratio));
    s.exec = row.exec;
    out[row.name] = s;
  }
  return out;
}
