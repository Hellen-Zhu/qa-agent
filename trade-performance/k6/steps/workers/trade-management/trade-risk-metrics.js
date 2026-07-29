/*
 * steps/workers/trade-management/trade-risk-metrics.js
 *
 * 【层级】原子步骤 —— 一个 API 一个文件
 * 【API】  workers.trade-management.risk-metrics  ·  GET /trades/{id}/risk-metrics
 * 【对应】jmx/fragments/steps/workers/trade-management/trade-risk-metrics.jmx
 *        + groovy/tag-risk-outcome.groovy
 *
 * ── 软依赖（risk-engine gRPC）──
 * 失败**不中止**本次迭代，只记录 —— 这是该 API 的固有性质（前端行为：
 * 风险块加载失败时 trade 主体仍展示），不是场景的特殊需求。
 * 默认不屏蔽：失败照常进 technical。masking 模式做 S-11 降级实验时再移植。
 */

import http from 'k6/http';
import { Rate } from 'k6/metrics';
import { cfg } from '../../../lib/config.js';
import { recordOutcome, ERR } from '../../../lib/errors.js';

// 与 calc-risk 分开计：一个是提交前预览（workers 内），一个是详情页风险块
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
      'X-User-ID': userId,
      'X-User-Id': userId,
      'X-Dyn-Run': cfg.dynRun,
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
