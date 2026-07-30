/*
 * steps/refdata/counterparties-list.js
 *
 * [Layer] Atomic step -- one API per file
 * [API]   refdata.counterparties.list  ·  GET /refdata/counterparties
 *
 * ⚠ When picking, fmId and name must be taken **as a pair** from the same
 *   record (pairing logic lives in the caller, see journeys/j01-create-trade.js).
 *   Two independent random picks will occasionally combine A's fmId with B's
 *   name -- if the server validates consistency, this shows up as "3% error
 *   rate, no pattern", one of the hardest script bugs to track down.
 *
 * Otherwise same as portfolios-list.js: extraction happens in the caller,
 * and the refdata address is still a placeholder.
 */

import http from 'k6/http';
import { cfg } from '../../lib/config.js';
import { classifyRead, ERR } from '../../lib/errors.js';

const URL = `${cfg.baseUrl('refdata')}/refdata/counterparties`;

/**
 * @param {Object} [opts]  {runPhase, userId, pageSize}
 * @returns {{res, errClass, detail, list}}  list is a non-empty array only when ok
 */
export function counterpartiesList(opts) {
  const o = opts || {};
  const tags = {
    name: 'refdata_counterparties_list',
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
