/*
 * lib/think.js — think time (user pauses)
 *
 * ── Why E2E must have think time ──
 * E2E measures "the pressure N real users' behavior puts on the system";
 * the pauses while users fill forms and read results set each user's
 * request cadence. E2E without think time is a different load model — it
 * duplicates the single-endpoint capacity test while being less
 * controllable.
 *
 * ── ⚠ Do not use group() to measure "journey time including think" ──
 * k6's group_duration **includes sleep**.
 * For business latency, use the per-step metrics (the "Per-step latency"
 * section of the summary).
 *
 * ── THINK_SCALE ──
 * Waiting 5 seconds while debugging a script is pure waste: -e THINK_SCALE=0
 * skips all pauses.
 * ⚠ Debugging only. Changing scale in an official run means changing the
 *   load model; overrides are written verbatim into the manifest by run.sh,
 *   so it is auditable afterwards — but the report must declare it.
 */

import { sleep } from 'k6';

const SCALE = (() => {
  const v = __ENV.THINK_SCALE;
  if (v === undefined || v === '') return 1;
  const n = parseFloat(v);
  if (isNaN(n) || n < 0) throw new Error(`-e THINK_SCALE=${v} is not a number >= 0`);
  return n;
})();

/**
 * Uniformly distributed pause of base ~ base+range milliseconds, matching
 * UniformRandomTimer semantics. Random (rather than fixed) to keep all VUs
 * from breathing in sync — fixed pauses turn request arrivals into neat
 * peaks and troughs, which is not the shape of any real user population.
 */
export function think(baseMs, rangeMs) {
  if (SCALE <= 0) return;
  const ms = (baseMs + Math.random() * (rangeMs || 0)) * SCALE;
  sleep(ms / 1000);
}
