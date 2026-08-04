/*
 * Trade read-path client: independent of the create data graph (the case pool + dat preloading in -data.js).
 * Rationale for the split (final review #4): the contract file used to import the data file (create-only)
 * at module top level, so the trades-query scenario transitively loaded the whole create case pool and all
 * dat binaries via trades.js — any broken create data dragged down the query scenario's init, and every
 * query VU pointlessly carried an extra copy of the dat memory.
 * This file covers read-only endpoints only: queries have no assertable business-rejection shape, so the
 * contract is structure validation only.
 */
import * as client from '../../../lib/http.js';
import { classifyRead, ERR } from '../../../lib/errors.js';
import { Trend } from 'k6/metrics';

const SVC = 'worker-svc';
const MOD = 'trade';

// Empty-DB guard: each response's row count feeds a Trend, and the scenario attaches an avg>0 threshold —
// query numbers against an empty DB are meaningless, and a row count stuck at 0 also means the field name
// was guessed wrong; either way the round proves nothing
export const tradesRows = new Trend('perf_trades_rows');

export function queryTrades(cfg, filter, user) {
  const { res, tags } = client.get(cfg, SVC, '/api/v1/trades', {
    name: 'GET /api/v1/trades', module: MOD, user, params: filter,
  });
  const out = classifyRead(res, tags, (body) =>
    Array.isArray(body.trades) ? null : `response missing trades array — keys=${Object.keys(body || {}).slice(0, 8).join(',')}`
  );
  if (out.errClass === ERR.OK) tradesRows.add(out.body.trades.length, tags);
  return out;
}
