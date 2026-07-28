/*
 * steps/workers/trade-management/create-trade.js
 *
 * 【层级】原子步骤 —— 一个 API 一个文件
 * 【API】  workers.trade-management.create  ·  POST /trades/create
 * 【对应】jmx/fragments/steps/workers/trade-management/create-trade.jmx
 *
 * ══ 唯一真相来源 ═══════════════════════════════════════════════
 * create 的请求构造、响应判定、结果提取只在这里定义一次。
 * **setUp 的前置校验也调用本函数** —— 两个调用方共用同一份契约。
 *
 * 在 JMeter 里这需要 Test Fragment + Include Controller + 一条校验规则（R2）
 * 来保证没人复制第二份；在 k6 里这是 `import` 的天然属性，不需要额外机制。
 *
 * 调用方的差异**不在请求上**，只在于：
 *   - 传入的 runPhase 标签（setup / main）
 *   - 拿到返回值后各自套用什么策略（preflight 会中止测试，主循环只记录）
 * 这与 JMeter 里"策略挂在 Include 外层的 GenericController 上"是同一个设计。
 * ═══════════════════════════════════════════════════════════════
 *
 * ── multipart 要点（与 JMeter 侧同源，勿改）──
 * 只要请求体里有 http.file()，k6 就自动按 multipart/form-data 编码，
 * 并**自己生成 boundary**。
 *
 * ⚠ 绝不能在 headers 里手写 Content-Type —— 手写值不带 boundary，
 *   且会覆盖生成值，服务端无法分段。这条约束 JMeter 和 k6 完全一样。
 *
 * `trade` 是**普通表单字段**（真实 curl 用 -F 'trade={...}'，不是 -F 'trade=@file'），
 * 所以直接传字符串即可，不需要写临时文件。
 */

import http from 'k6/http';
import { cfg } from '../../../lib/config.js';
import { getDat, baseName } from '../../../lib/data.js';
import { classifyCreate } from '../../../lib/errors.js';

const URL = `${cfg.workersUrl}/trades/create`;

/**
 * 拼 multipart 里 `trade` 字段的值。
 * 对应 groovy/build-trade-payload.groovy。
 *
 * 用 JSON.stringify 而非字符串拼接：真实 counterparty 名字里有 `*`
 * （PRINTINGINT10LTD*HKG），还可能出现引号、反斜杠、非 ASCII。
 * 手拼字符串迟早拼出非法 JSON，而那种失败表现为"某些行偶发 400"，极难定位。
 */
export function buildTradePayload(refdata, caseRow) {
  return JSON.stringify({
    basic: {
      portfolioId: refdata.portfolioId,
      counterpartyFmId: refdata.counterpartyFmId,
      counterpartyName: refdata.counterpartyName,
      notionalCurrency: caseRow.notionalCurrency || '',
    },
  });
}

/**
 * 校验入参是否真的取到了值。
 * 对应 groovy/select-refdata.groovy 的 csv 分支 + resolve-dat-file.groovy 的 ${ 检查。
 *
 * 静态数据模式下这一步不能省：CSV 路径写错或列名对不上时，字段会是
 * undefined / 空串 / 占位符，请求照发，服务端返回业务拒绝 ——
 * 报告里表现为"错误率升高"而不是"脚本错了"，是最难定位的一类失败。
 */
const PLACEHOLDER = /^\s*(tbc|todo|xxx+|n\/a|待定|placeholder)\s*$/i;

export function validateInputs(refdata, caseRow) {
  const problems = [];

  ['portfolioId', 'counterpartyFmId', 'counterpartyName'].forEach((k) => {
    const v = refdata[k];
    if (!v || !String(v).trim()) problems.push(`refdata.${k} 未取到（检查 refdataFile 路径与表头）`);
    else if (PLACEHOLDER.test(v)) problems.push(`refdata.${k}='${v}' 仍是占位值（见 data/refdata/README.md）`);
  });

  if (!caseRow.datFile || !String(caseRow.datFile).trim()) {
    problems.push('caseRow.datFile 未取到（检查 createDataFile 路径与表头）');
  }

  return problems;
}

/**
 * 发一笔 create。**唯一的请求出口。**
 *
 * @param {Object}  opts
 * @param {Object}  opts.refdata   一行 refdata-pairs.csv
 * @param {Object}  opts.caseRow   一行 create-trade-data.csv
 * @param {string}  opts.runPhase  'setup' | 'main'
 * @param {string}  [opts.userId]  身份，默认 maker
 * @returns {{res, errClass, detail, tradeId, taskId, tags, tradeReference}}
 */
export function createTrade(opts) {
  const { refdata, caseRow, runPhase } = opts;
  const userId = opts.userId || cfg.makerUserId;

  // ── 低基数标签：会成为指标的维度，用来切分结果 ──
  // ⚠ 不要往这里加 tradeId / tradeReference 之类每次都不同的值（见 lib/errors.js）
  const tags = {
    name: 'workers_trademgmt_create',   // k6 用 name 标签聚合，等价于 JMeter 的采样器名
    runPhase: runPhase,
    caseId: caseRow.caseId || 'PREFLIGHT',
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
      // 真实 curl 里同时存在 X-User-ID 和 X-User-Id，仅大小写不同。
      // 按 RFC 7230 §3.2 header 名大小写不敏感 —— 两者是同一个 header。
      // ⚠ JS 对象的键**区分**大小写，写两个会产生两个条目；
      //   两个都取同一个值，无论服务端读哪个都是对的。
      //   确认服务端只认 X-User-Id 后，删掉上面那行。
      'X-User-ID': userId,
      'X-User-Id': userId,
      'X-Dyn-Run': cfg.dynRun,
    },
    timeout: cfg.requestTimeout,
    tags: tags,
  });

  const outcome = classifyCreate(res, tags);

  return Object.assign({ res, tags }, outcome, {
    // 业务唯一标识：仅存在于结果文件，未写入被测系统
    // （payload 目前不接受额外字段 —— 这正是清理策略只能靠
    //   "专用 PERF Portfolio + 状态 + 时间窗口" 兜底的原因）
    tradeReference: `PERF-${caseRow.caseId || 'PREFLIGHT'}-${runPhase}`,
  });
}
