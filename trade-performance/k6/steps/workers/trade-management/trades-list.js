/*
 * steps/workers/trade-management/trades-list.js
 *
 * [Layer] Atomic step -- one API per file
 * [API]   workers.trade-management.list  ·  GET /trades
 *
 * ══ This is the highest-volume path in the whole system ═══════════════
 * A single Trade Portal page holds multiple blotters, each an independent
 * list query with auto-refresh:
 *   steady-state TPS = concurrent users × blotters per page (A10) ÷ refresh interval (A11)
 *            = 31 × 4 ÷ 30 ≈ 4.13 constant; design capacity 33 TPS (Workload §6).
 *
 * ⚠ This endpoint uses UC gRPC enrichment (the #1 dependency blast radius).
 *   If enrichment is per-row N+1, a 33 TPS list = 6,600 QPS of gRPC --
 *   the subject of the S-09 fan-out audit.
 * ═══════════════════════════════════════════════════════════════
 *
 * ── Blotter listing and locate-by-ref share this file ──
 * Same endpoint, same contract; the only difference is query params:
 *   opts.search set → search locate; unset → full blotter page (size/page).
 *
 * ⚠ Param names size / page / search / status are **inferred** (carried over
 *   from the original script's assumptions, unconfirmed by the server).
 *   If guessed wrong, the server ignores unknown params and returns the
 *   default page -- it **fails silently**. Therefore:
 *   1) The first smoke run must manually verify returned rows == requested size;
 *   2) This step records oreo_trades_rows_mismatch and warns on a mismatch.
 */

import http from 'k6/http';
import { Trend, Counter } from 'k6/metrics';
import { cfg } from '../../../lib/config.js';
import { classifyRead, ERR } from '../../../lib/errors.js';

const URL = `${cfg.workersUrl}/trades`;

// Returned row count: the mandatory footnote for list latency numbers (KPI §5.8).
// "P95=1.2s" means completely different things at 50 rows vs 500 rows.
// Maps to the jtl tradesRowCount column -- in k6 the row count goes into a
// Trend, and the requested size into a low-cardinality tag.
export const tRows = new Trend('oreo_trades_rows');
export const cRowsMismatch = new Counter('oreo_trades_rows_mismatch');

/** Query-string builder: two branches, search locate vs full blotter page. */
export function buildTradesQuery(opts) {
  const parts = [];
  const search = (opts.search || '').trim();
  if (search) {
    parts.push('search=' + encodeURIComponent(search));
  } else {
    parts.push('size=' + (opts.pageSize || 200));
    parts.push('page=' + (opts.page || 0));
  }
  if (opts.status) parts.push('status=' + encodeURIComponent(opts.status));
  return parts.join('&');
}

/**
 * Extract the returned row count from the response body. Handles three
 * response shapes:
 *   data is directly an array / Spring Page's data.content / data.items
 * If none match, return -1 (unknown shape ≠ error -- could be a pagination
 * wrapper we haven't seen).
 */
export function extractRowCount(body) {
  const d = body ? body.data : null;
  if (Array.isArray(d)) return d.length;
  if (d && Array.isArray(d.content)) return d.content.length;
  if (d && Array.isArray(d.items)) return d.items.length;
  return -1;
}

/** Total count in the database (if the pagination metadata has it). Used for entry criterion #3's "data volume declaration". */
export function extractTotal(body) {
  const d = body ? body.data : null;
  if (d && typeof d.totalElements === 'number') return d.totalElements; // Spring Page
  if (d && typeof d.total === 'number') return d.total;
  return -1;
}

let warnedMismatch = false; // warn once per VU to avoid log spam

/**
 * Send one list query. **The only request exit point.**
 *
 * @param {Object} [opts]
 * @param {string} [opts.runPhase]  'setup' | 'main', default 'main'
 * @param {number} [opts.pageSize]  full blotter page size, default 200 (A17)
 * @param {number} [opts.page]      page number, default 0
 * @param {string} [opts.search]    if set, uses search-locate mode
 * @param {string} [opts.status]    optional status filter
 * @param {string} [opts.userId]    defaults to maker
 * @returns {{res, errClass, detail, rowCount, total, tags}}
 */
export function tradesList(opts) {
  const o = opts || {};
  const pageSize = o.pageSize || 200;
  const searchMode = !!(o.search && String(o.search).trim());

  const tags = {
    name: 'workers_trademgmt_list',
    runPhase: o.runPhase || 'main',
    // Low cardinality: values come from the sweep tiers (50/200/500), not free-form
    pageSize: searchMode ? 'search' : String(pageSize),
  };

  const res = http.get(`${URL}?${buildTradesQuery(o)}`, {
    headers: {
      accept: '*/*',
      'X-User-ID': o.userId || cfg.makerUserId,
      'X-User-Id': o.userId || cfg.makerUserId,
      'X-Dyn-Run': cfg.dynRun,
    },
    timeout: cfg.requestTimeout,
    tags: tags,
  });

  const out = classifyRead(res, tags);

  let rowCount = -1;
  let total = -1;
  if (out.errClass === ERR.OK) {
    rowCount = extractRowCount(out.body);
    total = extractTotal(out.body);
    if (rowCount >= 0) tRows.add(rowCount, tags);

    // Row count differs from requested size: leave a clue but don't fail --
    // the database may simply not have that many rows.
    // If the DB volume is far larger than size and it still mismatches, the
    // pagination param names are almost certainly guessed wrong.
    if (!searchMode && rowCount >= 0 && rowCount !== pageSize) {
      cRowsMismatch.add(1, tags);
      if (!warnedMismatch) {
        warnedMismatch = true;
        console.warn(
          `GET /trades returned ${rowCount} rows for requested size=${pageSize}` +
          (total >= 0 ? ` (DB total ${total})` : '') +
          ' — if the gap cannot be explained by data volume, check the pagination param names (see the header comment in this file)'
        );
      }
    }
  }

  return Object.assign({ res, tags, rowCount, total }, out);
}
