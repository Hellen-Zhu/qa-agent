/*
 * steps/workers/trade-management/calc-risk-for-new.js
 *
 * 【层级】原子步骤 —— 一个 API 一个文件
 * 【API】  workers.trade-management.calc-risk-for-new  ·  POST /trades/calculate-risk-for-new
 * 【对应】jmx/fragments/steps/workers/trade-management/calc-risk-for-new.jmx
 *
 * ── 建议性风控（软依赖，v2 §2.3）──
 * 前端在用户填完表单后调用它预览风险，**失败不阻断继续创建** ——
 * journey 里它的返回值只记录、不中止。但它与 create 共用 .dat 上传，
 * 对 DAT 解析 CPU 的占用是真实的：E2E 里省掉这一步会让 create 的
 * 资源画像偏乐观（NFR PERF-11 是它专属的阈值）。
 *
 * ── 判定口径 ──
 * 只判 HTTP 200（对应 JMeter 侧只挂 tag-risk-outcome、无业务断言的现状）：
 * 该接口的业务响应形态未确认，先不猜。非 200 记 technical ——
 * 默认**不屏蔽**软依赖失败：503 是意料之外的，必须在报告里刺眼地显示。
 * （softDependencyMasking 的降级实验模式暂未移植，做 S-11 时再加。）
 *
 * payload 与 create 完全同源（import 同一个 buildTradePayload）——
 * 对应 JMeter 侧两个 fragment 共用 build-trade-payload.groovy。
 */

import http from 'k6/http';
import { Rate } from 'k6/metrics';
import { cfg } from '../../../lib/config.js';
import { getDat, baseName } from '../../../lib/data.js';
import { buildTradePayload } from './create-trade.js';
import { recordOutcome, ERR } from '../../../lib/errors.js';

const URL = `${cfg.workersUrl}/trades/calculate-risk-for-new`;

// 软依赖健康度单列一个 Rate：错误率里看得到它，按维度切分时也不跟 create 混
export const rRiskPreview = new Rate('oreo_risk_preview_ok');

/**
 * @param {Object} opts  {refdata, caseRow, runPhase, userId}
 * @returns {{res, ok, errClass, riskFailCode, tags}}
 */
export function calcRiskForNew(opts) {
  const { refdata, caseRow, runPhase } = opts;
  const userId = opts.userId || cfg.makerUserId;

  const tags = {
    name: 'workers_trademgmt_calcriskfornew',
    runPhase: runPhase,
    caseId: caseRow.caseId || 'NA',
    pairId: refdata.pairId || 'NA',
    productType: caseRow.productType || 'NA',
  };

  const body = {
    trade: buildTradePayload(refdata, caseRow),
    datFile: http.file(
      getDat(caseRow.datFile),
      baseName(caseRow.datFile),
      'application/octet-stream'
    ),
  };

  const res = http.post(URL, body, {
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
  rRiskPreview.add(ok, tags);

  return {
    res,
    tags,
    ok,
    errClass: ok ? ERR.OK : ERR.TECHNICAL,
    // 保留原始状态码：503（下游挂了）与 504（超时）的处置完全不同
    riskFailCode: ok ? '' : String(res.status),
  };
}
