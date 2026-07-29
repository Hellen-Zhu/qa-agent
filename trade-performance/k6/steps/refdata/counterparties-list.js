/*
 * steps/refdata/counterparties-list.js
 *
 * 【层级】原子步骤 —— 一个 API 一个文件
 * 【API】  refdata.counterparties.list  ·  GET /refdata/counterparties
 *
 * ⚠ 挑选时 fmId 与 name 必须**成对**取自同一条记录（配对逻辑在调用方，
 *   见 journeys/j01-create-trade.js）。两处独立随机会偶发拼出
 *   A 的 fmId 配 B 的 name —— 服务端若校验一致性，表现为"错误率 3%，
 *   无规律"，是最难定位的一类脚本 bug。
 *
 * 其余同 portfolios-list.js：提取在调用方、refdata 地址仍是占位值。
 */

import http from 'k6/http';
import { cfg } from '../../lib/config.js';
import { classifyRead, ERR } from '../../lib/errors.js';

const URL = `${cfg.baseUrl('refdata')}/refdata/counterparties`;

/**
 * @param {Object} [opts]  {runPhase, userId, pageSize}
 * @returns {{res, errClass, detail, list}}  list 仅在 ok 时非空数组
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
