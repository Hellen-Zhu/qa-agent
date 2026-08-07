/*
 * Ratio splitter shared by all mixed entries (src/mixed/): ONE profile template scenario is
 * sliced into N parallel k6 scenarios, each pinned to its own exec function.
 * Splittable profiles: a scalar rate (constant-arrival-rate — mix/mix-ref), open-model stages
 * (ramping-arrival-rate — mix-ladder: startRate and every stage target scale by ratio, so the
 * whole mix steps up proportionally), or a scalar iterations count (shared-iterations — smoke's
 * one-shot-per-flow link check). Closed vus-only executors (baseline/ladder) are rejected:
 * their iteration volume is unknowable up front, so consumable-pool preflights cannot budget
 * and the mix ratio would silently drift once a pool runs dry.
 * Rounding may make the effective total drift from the nominal template — irrelevant at
 * capacity caliber; the floor of 1 keeps every flow present even at tiny trial volumes
 * (a template target of 0, e.g. a cool-down stage, stays 0).
 */
export function splitByRatio(template, table) {
  if (template.rate === undefined && template.stages === undefined && template.iterations === undefined) {
    throw new Error(
      'mixed entries require a profile with a scalar rate (mix/mix-ref), open-model stages (mix-ladder) ' +
      'or iterations (smoke); closed vus-only profiles cannot preflight consumable pools'
    );
  }
  if (template.stages !== undefined && template.executor !== 'ramping-arrival-rate') {
    throw new Error(
      `mixed entries only split OPEN-model stages (ramping-arrival-rate), got executor '${template.executor}'`
    );
  }
  const out = {};
  for (const row of table) {
    const s = Object.assign({}, template);
    if (template.rate !== undefined) {
      s.rate = Math.max(1, Math.round(template.rate * row.ratio));
    } else if (template.stages !== undefined) {
      if (template.startRate !== undefined) s.startRate = Math.round(template.startRate * row.ratio);
      s.stages = template.stages.map((st) =>
        Object.assign({}, st, { target: st.target > 0 ? Math.max(1, Math.round(st.target * row.ratio)) : 0 })
      );
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

/*
 * Flow-table expansion (business-mix): flows are ACCOUNTING units, not execution units.
 * Each flow row declares its 1x business rate (flows per second at production projection) and
 * the endpoint calls one flow induces (the multiplication table, captured from DevTools counts).
 * Endpoint 1x rate = Σ flow.rate × multiplicity; the profile's rate/stage targets act as a
 * MULTIPLIER (1 = 1x business volume, RATE=10 → 10x). Execution stays unordered API-level —
 * no sequencing, no data hand-off between endpoints.
 * Rates are emitted on a 60s timeUnit so fractional per-second endpoint rates stay precise at
 * 1x (0.083/s → 5 per 60s); k6 spaces starts evenly inside the timeUnit, so the stream is
 * smooth, not bursty. Smoke (iterations template) degrades to one call per endpoint.
 */
const FLOW_TU_SEC = 60;

export function expandFlows(template, flows, execMap) {
  if (template.rate === undefined && template.stages === undefined && template.iterations === undefined) {
    throw new Error(
      'flow expansion requires a profile with a scalar rate (multiplier), open-model stages ' +
      '(multiplier ladder) or iterations (smoke); closed vus-only profiles cannot preflight consumable pools'
    );
  }
  if (template.stages !== undefined && template.executor !== 'ramping-arrival-rate') {
    throw new Error(`flow expansion only accepts OPEN-model stages (ramping-arrival-rate), got '${template.executor}'`);
  }
  const perSec = {};
  for (const f of Object.values(flows)) {
    for (const ep of Object.keys(f.calls)) perSec[ep] = (perSec[ep] || 0) + f.rate * f.calls[ep];
  }
  const totalPerSec = Object.values(perSec).reduce((a, b) => a + b, 0);
  const out = {};
  for (const ep of Object.keys(perSec)) {
    const execName = execMap[ep];
    if (!execName) throw new Error(`flow table references endpoint '${ep}' but no exec function is mapped`);
    const r = perSec[ep];
    const frac = r / totalPerSec;
    const s = { executor: template.executor, exec: execName };
    if (template.iterations !== undefined) {
      s.iterations = 1;
      s.vus = 1;
      if (template.maxDuration) s.maxDuration = template.maxDuration;
    } else {
      s.timeUnit = `${FLOW_TU_SEC}s`;
      if (template.preAllocatedVUs !== undefined) s.preAllocatedVUs = Math.max(2, Math.round(template.preAllocatedVUs * frac));
      if (template.maxVUs !== undefined) s.maxVUs = Math.max(5, Math.round(template.maxVUs * frac));
      if (template.rate !== undefined) {
        s.rate = Math.max(1, Math.round(template.rate * r * FLOW_TU_SEC));
        s.duration = template.duration;
      } else {
        s.startRate = Math.round((template.startRate || 0) * r * FLOW_TU_SEC);
        s.stages = template.stages.map((st) =>
          Object.assign({}, st, { target: st.target > 0 ? Math.max(1, Math.round(st.target * r * FLOW_TU_SEC)) : 0 })
        );
      }
    }
    out[ep] = s;
  }
  return out;
}
