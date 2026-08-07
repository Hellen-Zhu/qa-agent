/*
 * Trade ID pool: shared by the detail and risk-metrics read scenarios (both hammer the same batch of
 * real trades). IDs go stale with the environment (they do not carry across environments); after an
 * environment switch, re-capture them per the data README.
 * The placeholder gate sits in the setup phase (tradeIdsPreflight) rather than init — k6 inspect must
 * pass on placeholder data (placeholders-only in the repo is the discipline), so init does structure
 * validation only.
 * ⚠ When an ID in the pool has gone stale the server returns 404, which the engine rules classify as
 *   technical (http-404) — this is the shape "expired data" takes for read scenarios: on seeing
 *   http-404, re-capture the IDs first; do not treat it as a performance problem.
 */
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

const PLACEHOLDER = /tbc|todo|placeholder|xxx/i;

export const tradeIds = new SharedArray('trade-ids', () => {
  const doc = JSON.parse(open(import.meta.resolve('../../../../data/worker-svc/trade/trade-ids.json')));
  const ids = (doc.ids || []).map(String);
  if (ids.length === 0) {
    throw new Error('data/worker-svc/trade/trade-ids.json has no ids (capture procedure: see the README in that directory)');
  }
  return ids;
});

/** Setup-phase data gate: abort on placeholders (the PREFLIGHT FAILED keyword is wired to the hint in run.sh) */
export function tradeIdsPreflight() {
  const bad = [];
  for (let i = 0; i < tradeIds.length; i++) {
    if (PLACEHOLDER.test(tradeIds[i])) bad.push(`#${i + 1} '${tradeIds[i]}'`);
  }
  if (bad.length > 0) {
    console.error(
      `PREFLIGHT FAILED — trade-ids.json still contains placeholders: ${bad.slice(0, 5).join(', ')}` +
      ` (${bad.length} total; capture procedure: see data/worker-svc/trade/README.md)`
    );
    exec.test.abort('trade ID pool failed local validation');
  }
}

/** Global cursor rotation (i = exec.scenario.iterationInTest) */
export function pickTradeId(i) {
  return tradeIds[Math.abs(i) % tradeIds.length];
}
