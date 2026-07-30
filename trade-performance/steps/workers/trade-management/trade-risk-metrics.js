/*
 * steps/workers/trade-management/trade-risk-metrics.js
 *
 * [Layer] Atomic step -- one API per file
 * [API]   workers.trade-management.risk-metrics  ·  GET /trades/{id}/risk-metrics
 *
 * ── Soft dependency (risk-engine gRPC) ──
 * Failure does **not abort** the iteration, only gets recorded -- this is an
 * inherent property of the API (frontend behavior: when the risk block fails
 * to load, the trade body still renders), not a special need of the scenario.
 * Not masked by default: failures still count as technical. Port the masking
 * mode when doing the S-11 degradation experiment.
 */

import http from 'k6/http';
import { Rate } from 'k6/metrics';
import { cfg } from '../../../lib/config.js';
import { recordOutcome, ERR } from '../../../lib/errors.js';

// Counted separately from calc-risk: one is the pre-submit preview (inside
// workers), the other is the detail page's risk block
export const rRiskMetrics = new Rate('oreo_risk_metrics_ok');

/**
 * @param {Object} opts  {tradeId, runPhase, userId}
 * @returns {{res, ok, errClass, riskFailCode, tags}}
 */
export function tradeRiskMetrics(opts) {
  const { tradeId, runPhase } = opts;
  const userId = opts.userId || cfg.makerUserId;

  const tags = {
    name: 'workers_trademgmt_riskmetrics',
    runPhase: runPhase,
  };

  const res = http.get(`${cfg.workersUrl}/trades/${tradeId}/risk-metrics`, {
    headers: {
      accept: '*/*',
      'X-User-Id': userId,
    },
    timeout: cfg.requestTimeout,
    tags: tags,
  });

  const ok = res.status === 200;
  recordOutcome(ok ? ERR.OK : ERR.TECHNICAL, tags, res);
  rRiskMetrics.add(ok, tags);

  return {
    res,
    tags,
    ok,
    errClass: ok ? ERR.OK : ERR.TECHNICAL,
    riskFailCode: ok ? '' : String(res.status),
  };
}
