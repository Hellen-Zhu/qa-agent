/*
 * lib/case-pool.js —— 通用用例池：从 JSON 数据文件建池、取数
 *
 * 框架设施，**不认识任何具体被测路径**。每条路径的实例化（SharedArray
 * 名、覆盖项键名、默认数据文件，以及 .dat 预载这类路径特有机制）在
 * steps/<svc>/<domain>/<路径>-data.js 里做，与消费它的步骤同目录 ——
 * lib/ 只留对几十个 API 都一样的机制（与 errors.js 的引擎/契约分层同理）。
 *
 * ── 数据格式：仅 JSON ──
 * 契约见 lib/rows.js：顶层 rows 数组、_ 开头键是注释、值一律转字符串。
 * .csv 兼容路径已于 2026-07-29 移除（旧 CSV 列结构与内嵌归属字段的
 * 新 schema 不兼容）—— 池子大到需要 Excel 维护时，加离线 csv→json
 * 转换脚本，不要让 k6 回去读 CSV。
 *
 * ⚠ open() 是 init-only。它的相对路径语义正在变化：当前 k6 按"正在
 *   求值的模块"解析（本函数被路径模块调用时，就相对**那个模块**了），
 *   未来版本改按"代码书写处的模块"解析。import.meta.resolve() 在两版
 *   语义下都稳定锚定**本文件**，这是 k6 警告里给出的官方写法 ——
 *   所有跨模块的 open() 都必须走它，裸相对路径迟早断。
 */

import { SharedArray } from 'k6/data';
import { rowsFromJson } from './rows.js';

const ROOT = '../'; // lib/ → k6/（配合 import.meta.resolve 锚定本文件）

/** 覆盖项语义与 lib/config.js 的 pick() 一致：空串等同未设置 */
export function envOr(key, fallback) {
  const v = __ENV[key];
  return v === undefined || v === '' ? fallback : v;
}

/*
 * 路径归一化：数据文件里的相对路径一律用 /，但在 Windows 上编辑过的
 * 文件可能混进反斜杠（\）。k6 的 open() 两种都认，但 baseName 只按 /
 * 切就会把整条路径当文件名 —— 发出去的 multipart 变成
 * `filename="products\FX_TRF\x.dat"`，服务端多半照单全收，
 * **请求成功、文件名是错的**，报告里完全看不出来。
 */
export function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

/** 路径最后一段（multipart 的 filename 等场景用） */
export function baseName(relPath) {
  const p = normalizePath(relPath);
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * 建一个用例池。行数据走 SharedArray（全部 VU 共用一份，open() 在
 * 回调里只执行一次，官方推荐写法）。
 *
 * @param {Object} opts
 *   opts.name        SharedArray 名 —— 全局唯一，一条路径一个
 *   opts.envKey      数据文件覆盖项键名（如 CREATE_DATA_FILE）
 *   opts.defaultFile 默认数据文件（k6/ 为根）。默认值在实例化模块里
 *                    而不在 config/<env>.json —— "用哪个池"是计划维度
 *                    的事，不是环境维度的（理由见各实例化模块头注）
 * @returns {{file: string, rows: SharedArray, pick: (i: number) => Object}}
 *   pick 是全局游标 roundRobin：配合 exec.scenario.iterationInTest
 *   （跨全部 VU 的全局单调计数器），覆盖均匀且可复现
 */
export function makeCasePool(opts) {
  const file = envOr(opts.envKey, opts.defaultFile);
  if (!file.endsWith('.json')) {
    throw new Error(
      `数据文件只支持 .json：${file}（${opts.envKey}）。` +
      `契约见 lib/rows.js；.csv 已不支持，见本文件头注`
    );
  }
  const rows = new SharedArray(opts.name, () =>
    rowsFromJson(open(import.meta.resolve(ROOT + file)), file)
  );
  return {
    file,
    rows,
    pick(i) {
      if (rows.length === 0) throw new Error(`${file} 没有数据行`);
      return rows[i % rows.length];
    },
  };
}
