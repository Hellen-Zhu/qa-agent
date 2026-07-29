/*
 * steps/workers/trade-management/trade-detail.js
 *
 * 【层级】原子步骤 —— 一个 API 一个文件
 * 【API】  workers.trade-management.detail  ·  GET /trades/{id}
 * 【对应】jmx/fragments/steps/workers/trade-management/trade-detail.jmx
 *
 * ⚠ 本接口走 **UC gRPC**（依赖影响面第一：9 个接口共用）——
 *   E2E 把它放进 journey，正是为了覆盖 create 本身碰不到的这条下游。
 *
 * ⚠ tradeId 是高基数值，**只进 URL，绝不进 tag**（见 lib/errors.js 头注）。
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
