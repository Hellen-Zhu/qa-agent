/*
 * steps/workers/trade-management/create-trade.js
 *
 * 【层级】原子步骤 —— 一个 API 一个文件
 * 【API】  workers.trade-management.create  ·  POST /trades/create
 *
 * ══ 唯一真相来源 ═══════════════════════════════════════════════
 * create 的请求构造、响应判定、结果提取只在这里定义一次。
 * **setUp 的前置校验也调用本函数** —— 两个调用方共用同一份契约，
 * `import` 天然保证没有第二份。
 *
 * 调用方的差异**不在请求上**，只在于：
 *   - 传入的 runPhase 标签（setup / main）
 *   - 拿到返回值后各自套用什么策略（preflight 会中止测试，主循环只记录）
 * ═══════════════════════════════════════════════════════════════
 *
 * ── multipart 要点（依据真实 curl 校准，勿改）──
 * 只要请求体里有 http.file()，k6 就自动按 multipart/form-data 编码，
 * 并**自己生成 boundary**。
 *
 * ⚠ 绝不能在 headers 里手写 Content-Type —— 手写值不带 boundary，
 *   且会覆盖生成值，服务端无法分段。
 *
 * `trade` 是**普通表单字段**（真实 curl 用 -F 'trade={...}'，不是 -F 'trade=@file'），
 * 所以直接传字符串即可，不需要写临时文件。
 */

import http from 'k6/http';
import { cfg } from '../../../lib/config.js';
import { getDat, uploadName } from './create-trade-data.js';
import { classifyResponse, reasonFrom, ERR } from '../../../lib/errors.js';

const URL = `${cfg.workersUrl}/trades/create`;

/*
 * ── create 的响应契约（业务判定属于本文件，公共 errors.js 只有引擎）──
 * 成功形态：HTTP 200 + code=200 + status='PENDING APPROVAL'
 *          + data.trade.id 形如 TRD-\d+
 * taskId 只存在于 msg 的自然语言里：
 *   "Submitted for checker approval. TaskId: CHK-98C0DF19"
 * 只能正则捞，文案一改就断（已作为 improvement 提给开发）。
 */

// 业务拒绝的归因模式表：按真实观测的 msg 校准、逐条补充。
// 现场原文靠 errors.js 限流日志采集 → 回填到这里收紧正则。
const REJECT_PATTERNS = [
  // 服务端临时文件竞态：并发同刻上传、时间戳撞名后文件被先完成方删除
  // （缺陷论证与绕行开关 DAT_NAME_MODE 见 data/dat/README.md）
  { reason: 'dat-missing', re: /(dat|file).*(not\s*found|missing|不存在)|找不到/i },
];

function classifyCreate(res, tags) {
  const out = classifyResponse(res, tags, {
    business: (body) =>
      body.code !== 200 || body.status !== 'PENDING APPROVAL'
        ? {
            reason: reasonFrom(body, REJECT_PATTERNS),
            // msg 截断：响应文案可能整段堆栈，定位只要开头
            detail: `business: code=${body.code} status=${body.status} msg=${String(body.msg || '').slice(0, 160)}`,
          }
        : null,
    // 校验格式而不只是非空：提取失败的兜底值也是非空字符串，弱断言放得过去
    shape: (body) => {
      const id = body.data && body.data.trade ? String(body.data.trade.id || '') : '';
      return /^TRD-\d+$/.test(id) ? null : `unexpected tradeId format — '${id}'`;
    },
  });

  if (out.errClass !== ERR.OK) {
    return { errClass: out.errClass, detail: out.detail, tradeId: 'NOT_FOUND', taskId: 'NOT_FOUND' };
  }

  const m = /TaskId:\s*(CHK-[A-Za-z0-9]+)/.exec(String(out.body.msg || ''));
  return {
    errClass: ERR.OK,
    detail: 'ok',
    tradeId: String(out.body.data.trade.id),
    taskId: m ? m[1] : 'NOT_FOUND',
  };
}

/**
 * 拼 multipart 里 `trade` 字段的值。
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
 *
 * 静态数据模式下这一步不能省：数据文件路径写错或字段名对不上时，字段会是
 * undefined / 空串 / 占位符，请求照发，服务端返回业务拒绝 ——
 * 报告里表现为"错误率升高"而不是"脚本错了"，是最难定位的一类失败。
 */
const PLACEHOLDER = /^\s*(tbc|todo|xxx+|n\/a|待定|placeholder)\s*$/i;

export function validateInputs(caseRow) {
  const problems = [];

  ['portfolioId', 'counterpartyFmId', 'counterpartyName'].forEach((k) => {
    const v = caseRow[k];
    if (!v || !String(v).trim()) problems.push(`${k} 未取到（检查数据文件路径与字段名，见 ./create-trade-data.js）`);
    else if (PLACEHOLDER.test(v)) problems.push(`${k}='${v}' 仍是占位值（见 data/workers/trade-management/README.md）`);
  });

  if (!caseRow.datFile || !String(caseRow.datFile).trim()) {
    problems.push('datFile 未取到（检查数据文件路径与字段名，见 ./create-trade-data.js）');
  }

  return problems;
}

/**
 * 发一笔 create。**唯一的请求出口。**
 *
 * @param {Object}  opts
 * @param {Object}  opts.caseRow    一条 create-trade.json 数据（含内嵌归属字段）
 * @param {Object}  [opts.refdata]  覆盖归属字段（E2E live 模式现场绑定时传入）；
 *                                  不传则取用例内嵌的 portfolioId / counterpartyFmId / counterpartyName
 * @param {string}  opts.runPhase   'setup' | 'main'
 * @param {string}  [opts.userId]   身份，默认 maker
 * @returns {{res, errClass, detail, tradeId, taskId, tags, tradeReference}}
 */
export function createTrade(opts) {
  const { caseRow, runPhase } = opts;
  const refdata = opts.refdata || caseRow;
  const userId = opts.userId || cfg.makerUserId;

  // ── 低基数标签：会成为指标的维度，用来切分结果 ──
  // ⚠ 不要往这里加 tradeId / tradeReference 之类每次都不同的值（见 lib/errors.js）
  const tags = {
    name: 'workers_trademgmt_create',   // k6 按 name 标签聚合各步骤的指标
    runPhase: runPhase,
    // row = 数据文件行号（rows.js 自动注入的 __row）—— "哪行数据坏了"
    // 从指标就能切出来。不是测试用例 id：一行只是一个数据变体
    row: String(caseRow.__row || 0),
    productType: caseRow.productType || 'NA',
  };

  const body = {
    trade: buildTradePayload(refdata, caseRow),
    // filename 由 uploadName 决定：默认原名；DAT_NAME_MODE=unique 时加唯一
    // 后缀绕服务端临时文件竞态（偏差开关，见 ./create-trade-data.js）
    datFile: http.file(
      getDat(caseRow.datFile),
      uploadName(caseRow.datFile),
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
    tradeReference: `PERF-r${caseRow.__row || 0}-${runPhase}`,
  });
}
