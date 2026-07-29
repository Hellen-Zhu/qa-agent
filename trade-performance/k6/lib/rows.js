/*
 * lib/rows.js —— JSON 数据文件解析（k6 主格式）
 *
 * ══ 为什么从 CSV 换 JSON ═══════════════════════════════════════
 * 1. JSON 是 k6 的原生路径：open() + JSON.parse 进 SharedArray 是官方
 *    文档的标准写法，不需要自带解析器（CSV 时代曾手写过一个 30 行的）。
 * 2. 真实 counterparty 名字里已出现 `*`，出现逗号只是时间问题 ——
 *    CSV 里那意味着引号与列错位问题，JSON 里这个问题类别不存在。
 * 3. 注释：数据为什么是这个值、什么时候采的，可以写在 `_comment` 键里
 *    （沿用 config/profiles 的约定：下划线开头的键是注释，加载时剥掉）。
 *
 * ══ 文件契约 ═══════════════════════════════════════════════════
 * 顶层是数组，或含 `rows` 数组的对象（顶层其余 `_` 开头键为注释）：
 *
 *   { "_comment": "为什么是这些值……",
 *     "rows": [ { "caseId": "C001", "portfolioId": "...", "_note": "行内注释也行" } ] }
 *
 * 行内以 `_` 开头的键同样剥掉。**注意 `note` 不带下划线** —— 那是真实数据列
 * （采集时间与来源），会进 CSV 生成物，别写成 `_note`。
 *
 * ══ 与 CSV 语义的刻意对齐 ══════════════════════════════════════
 * 所有标量值转成**去首尾空白的字符串**（null/undefined → ''）。
 * CSV 里一切都是字符串，下游（payload 拼装、占位值检测）按字符串写的；
 * 换格式不换语义 —— 想在 payload 里发数字类型，是 buildTradePayload 的
 * 决策，不是数据文件的。
 *
 * 本文件**不依赖任何 k6 模块**，node 可直接测：node k6/tests/rows.test.mjs
 */

/**
 * @param {string} text        JSON 全文
 * @param {string} sourceName  报错时标明来源（文件路径）
 * @returns {Array<Object>} 每条一个对象，附 __row（第几条，1 起）
 */
export function rowsFromJson(text, sourceName) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `${sourceName} 不是合法 JSON — ${e.message}。` +
      `常见原因：JSON 不支持注释和尾逗号 —— 注释写成以 _ 开头的键`
    );
  }

  let rows;
  if (Array.isArray(doc)) rows = doc;
  else if (doc && Array.isArray(doc.rows)) rows = doc.rows;
  else {
    throw new Error(
      `${sourceName} 结构不对：顶层应为数组，或含 rows 数组的对象` +
      `（其余 _ 开头的键是注释）`
    );
  }

  return rows.map((r, idx) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error(
        `${sourceName} 第 ${idx + 1} 条不是对象 — 每条应为 {"字段": "值"} 形式`
      );
    }
    const out = { __row: idx + 1 };
    Object.keys(r).forEach((k) => {
      if (k.startsWith('_')) return; // 行内注释键
      const v = r[k];
      out[k] = v === null || v === undefined ? '' : String(v).trim();
    });
    return out;
  });
}
