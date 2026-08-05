/*
 * Consumable ID pools — for write scenarios where each request USES UP one id
 * (update consumes a LIVE tradeId, approve consumes a pending CHK taskId).
 *
 * Differs from ids-data.js (reusable rotation) in three deliberate ways:
 *  1. takeUnique() never wraps: exec.scenario.iterationInTest indexes the pool exactly once
 *     per id, across all VUs with zero coordination — two VUs can never consume the same id,
 *     so the run cannot self-inflict 409 state conflicts.
 *  2. Pool exhaustion returns null; the scenario records it and skips the request instead of
 *     recycling ids (a second write to the same id measures the state machine, not the system).
 *  3. Preflight checks VOLUME, not just placeholders: pool >= planned iterations × 1.2 —
 *     an undersized pool would turn the tail of the round into a data-exhaustion measurement.
 *
 * Pools are produced by the seed pipeline (src/seed/, see data README) and are single-use:
 * after a measurement round the pool is dirty — re-seed before re-running.
 */
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

const PLACEHOLDER = /tbc|todo|placeholder|xxx/i;

/** name: pool file basename under data/worker-svc/trade/, e.g. 'update-ids' or 'approve-tasks' */
export function loadPool(name) {
  return new SharedArray(`consumable-${name}`, () => {
    const doc = JSON.parse(open(import.meta.resolve(`../../../../data/worker-svc/trade/${name}.json`)));
    return (doc.ids || []).map(String);
  });
}

/**
 * Setup-phase gate (the PREFLIGHT FAILED keyword is wired to the hint in run.sh).
 * planned: expected iteration count for this round — the caller derives it from the profile
 * (constant-arrival-rate: rate × duration; shared-iterations: iterations).
 */
export function consumablePreflight(pool, planned, name) {
  if (pool.length === 0 || pool.every((v) => PLACEHOLDER.test(v))) {
    console.error(
      `PREFLIGHT FAILED — ${name}.json is empty or placeholders only. ` +
      `Produce it with the seed pipeline first (./run.sh seed-... , then cp the extracted pool; see data/worker-svc/trade/README.md)`
    );
    exec.test.abort(`${name} pool failed local validation`);
  }
  const needed = Math.ceil(planned * 1.2);
  if (planned > 0 && pool.length < needed) {
    console.error(
      `PREFLIGHT FAILED — ${name}.json holds ${pool.length} ids but this round plans ~${planned} iterations ` +
      `(needs >= ${needed} with 20% headroom). Seed a bigger pool or lower RATE/DURATION/ITERATIONS.`
    );
    exec.test.abort(`${name} pool too small for the planned load`);
  }
}

/** Exactly-once consumption. Returns null when the pool is exhausted — skip, never recycle. */
export function takeUnique(pool) {
  const i = exec.scenario.iterationInTest;
  return i < pool.length ? pool[i] : null;
}
