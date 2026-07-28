/*
 * lib/csv.js —— 极小 CSV 解析器
 *
 * 为什么不用 papaparse：
 * k6 可以远程 import `https://jslib.k6.io/papaparse/...`，但那意味着
 *   1. 跑测试时依赖外网 —— 银行环境多半直接被墙
 *   2. 引入一条无人审计的供应链
 * 我们的 CSV 只有"表头 + 逗号分隔 + 可能带引号"三种情况，30 行代码就够。
 *
 * ⚠ 与 JMeter 的一处**故意差异**：
 *   JMeter 的 CSV Data Set 设了 quotedData=false（不处理引号）。
 *   这里**处理引号**。原因见 data/refdata/README.md：真实 counterparty 名字
 *   里出现过 `*`，出现逗号只是时间问题，而那种失败表现为"某一行的字段整体错位"，
 *   排查成本极高。JMeter 侧应该同步把 quotedData 改成 true。
 */

/** 拆一行，处理 "" 转义 */
function splitLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }   // "" → 字面量引号
        else inQuote = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * @param {string} text  CSV 全文
 * @returns {Array<Object>} 每行一个对象，键取自表头
 */
export function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0 && !l.trim().startsWith('#'));

  if (lines.length < 2) {
    // 只有表头（或空文件）—— 让调用方决定怎么处置，这里只如实返回
    return [];
  }

  const header = splitLine(lines[0]).map((h) => h.trim());

  return lines.slice(1).map((line, idx) => {
    const cells = splitLine(line);
    const row = { __line: idx + 2 };            // 供报错时指出是第几行
    header.forEach((h, i) => {
      row[h] = (cells[i] === undefined ? '' : cells[i]).trim();
    });
    return row;
  });
}
