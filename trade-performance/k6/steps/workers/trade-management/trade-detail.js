/*
 * steps/workers/trade-management/trade-detail.js
 *
 * [Layer] Atomic step -- one API per file
 * [API]   workers.trade-management.detail  ·  GET /trades/{id}
 *
 * ⚠ This endpoint goes through **UC gRPC** (the #1 dependency blast radius:
 *   shared by 9 endpoints) -- E2E puts it in the journey precisely to cover
 *   this downstream leg that create itself never touches.
 *
 * ⚠ tradeId is a high-cardinality value: **URL only, never a tag**
 *   (see the header comment in lib/errors.js).
 */

import http from 'k6/http';
import { cfg } from '../../../lib/config.js';
import { classifyRead } from '../../../lib/errors.js';

/**
 * @param {Object} opts  {tradeId, runPhase, userId}
 * @returns {{res, errClass, detail, body}}
 */
export function tradeDetail(opts) {
  const { tradeId, runPhase } = opts;
  const userId = opts.userId || cfg.makerUserId;

  const tags = {
    name: 'workers_trademgmt_detail',
    runPhase: runPhase,
  };

  const res = http.get(`${cfg.workersUrl}/trades/${tradeId}`, {
    headers: {
      accept: '*/*',
      'X-User-ID': userId,
      'X-User-Id': userId,
      'X-Dyn-Run': cfg.dynRun,
    },
    timeout: cfg.requestTimeout,
    tags: tags,
  });

  return Object.assign({ res, tags }, classifyRead(res, tags));
}
