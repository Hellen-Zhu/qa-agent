/*
 * Trade read-path client: independent of the create data graph (the case pool + dat preloading in -data.js).
 * Rationale for the split (final review #4): the contract file used to import the data file (create-only)
 * at module top level, so the trades-query scenario transitively loaded the whole create case pool and all
 * dat binaries via trades.js — any broken create data dragged down the query scenario's init, and every
 * query VU pointlessly carried an extra copy of the dat memory.
 *
 * Contract calibrated against a real dev response (2026-08-05):
 *   { code: 200, status: "SUCCESS", msg: "", data: { data: [ { trade: { id, basic: {...} } }, ... ] } }
 * — standard envelope + a nested data.data row array. The envelope makes business rejection assertable
 * (code/status), so this client uses the full classifier, not the structure-only classifyRead.
 */
import * as client from '../../../lib/http.js';
import { classifyResponse, reasonFrom, ERR } from '../../../lib/errors.js';
import { Trend } from 'k6/metrics';

const SVC = 'worker-svc';
const MOD = 'trade';

// Empty-DB guard: each response's row count feeds a Trend, and the scenario attaches an avg>0 threshold —
// query numbers against an empty DB are meaningless, and a row count stuck at 0 also means the field name
// was guessed wrong; either way the round proves nothing
export const tradesRows = new Trend('perf_trades_rows');

// No known rejection-message patterns yet — attribution falls back to the server's code enum (code-N)
const REJECT_PATTERNS = [];

export function queryTrades(cfg, filter, user) {
  const { res, tags } = client.get(cfg, SVC, '/api/v1/trades', {
    name: 'GET /api/v1/trades', module: MOD, user, params: filter,
  });
  const out = classifyResponse(res, tags, {
    business: (b) =>
      b.code !== 200 || b.status !== 'SUCCESS'
        ? {
            reason: reasonFrom(b, REJECT_PATTERNS),
            detail: `business: code=${b.code} status=${b.status} msg=${String(b.msg || '').slice(0, 160)}`,
          }
        : null,
    shape: (b) =>
      b.data && Array.isArray(b.data.data)
        ? null
        : `rows array missing at data.data — keys=${Object.keys(b || {}).slice(0, 8).join(',')} data.keys=${Object.keys((b && b.data) || {}).slice(0, 8).join(',')}`,
  });
  if (out.errClass === ERR.OK) tradesRows.add(out.body.data.data.length, tags);
  return out;
}
