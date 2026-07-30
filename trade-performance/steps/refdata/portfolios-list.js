/*
 * steps/refdata/portfolios-list.js
 *
 * [Layer] Atomic step -- one API per file
 * [API]   refdata.portfolios.list  ·  GET /refdata/portfolios
 *
 * ── Extraction (which row to pick) does NOT happen here ──
 * The same query has two uses: journeys pick one row at random as an input;
 * preflight takes the full list to build a pool. The atomic step only does
 * the request + returns the list; how to pick is up to the caller.
 *
 * ⚠ The refdata service address in config/dev.json is still a localhost
 *   placeholder (NFR pending confirmation #12). Until the address is
 *   confirmed this step will always get connection refused -- that is a
 *   deliberate explicit failure, not a bug. The E2E scenario provides the
 *   REFDATA_MODE=static fallback for exactly this reason
 *   (see scenarios/s01-create-trade-e2e.js).
 *
 * ⚠ Response shape assumes $.data[*].id, not verified against a real response.
 */

import http from 'k6/http';
import { cfg } from '../../lib/config.js';
import { classifyRead, ERR } from '../../lib/errors.js';

const URL = `${cfg.baseUrl('refdata')}/refdata/portfolios`;

/**
 * @param {Object} [opts]  {runPhase, userId, pageSize}
 * @returns {{res, errClass, detail, list}}  list is a non-empty array only when ok
 */
export function portfoliosList(opts) {
  const o = opts || {};
  const tags = {
    name: 'refdata_portfolios_list',
    runPhase: o.runPhase || 'main',
  };

  const res = http.get(`${URL}?status=ACTIVE&size=${o.pageSize || 200}`, {
    headers: {
      accept: '*/*',
      'X-User-Id': o.userId || cfg.makerUserId,
    },
    timeout: cfg.requestTimeout,
    tags: tags,
  });

  const out = classifyRead(res, tags, (body) =>
    Array.isArray(body && body.data) ? null : 'data is not an array (JSONPath assumes $.data[*], verify against a real response)'
  );

  return Object.assign({ res, tags, list: out.errClass === ERR.OK ? out.body.data : [] }, out);
}
