/*
 * steps/refdata/portfolios-list.js
 *
 * 【层级】原子步骤 —— 一个 API 一个文件
 * 【API】  refdata.portfolios.list  ·  GET /refdata/portfolios
 * 【对应】jmx/fragments/steps/refdata/portfolios-list.jmx
 *
 * ── 提取（挑哪一条）不在这里做 ──
 * 同一个查询有两种用法：journey 随机挑一条当入参；preflight 取全部建池。
 * 原子步骤只管请求 + 返回列表，怎么挑由调用方决定 ——
 * 与 JMeter 侧"提取器挂在调用方"的设计一致（refdata-pick-*.groovy 的注释）。
 *
 * ⚠ refdata 服务地址在 config/dev.json 里仍是 localhost 占位（NFR 待确认 #12）。
 *   地址没确认前本步骤必然连接拒绝 —— 这是刻意的显式失败，不是 bug。
 *   E2E 场景据此提供 REFDATA_MODE=csv 降级（见 scenarios/s01-create-trade-e2e.js）。
 *
 * ⚠ JSONPath 假设 $.data[*].id，未经真实响应验证（继承 JMeter 侧同一假设）。
 */

import http from 'k6/http';
import { cfg } from '../../lib/config.js';
import { classifyRead, ERR } from '../../lib/errors.js';

const URL = `${cfg.baseUrl('refdata')}/refdata/portfolios`;

/**
 * @param {Object} [opts]  {runPhase, userId, pageSize}
 * @returns {{res, errClass, detail, list}}  list 仅在 ok 时非空数组
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
      'X-User-ID': o.userId || cfg.makerUserId,
      'X-User-Id': o.userId || cfg.makerUserId,
      'X-Dyn-Run': cfg.dynRun,
    },
    timeout: cfg.requestTimeout,
    tags: tags,
  });

  const out = classifyRead(res, tags, (body) =>
    Array.isArray(body && body.data) ? null : 'data 不是数组（JSONPath 假设 $.data[*]，需对真实响应核实）'
  );

  return Object.assign({ res, tags, list: out.errClass === ERR.OK ? out.body.data : [] }, out);
}
