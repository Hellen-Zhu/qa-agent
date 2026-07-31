/*
 * create 路径的数据供给：用例池实例化 + dat 预载。
 * 通用解析机制在 lib/rows.js；本文件只做路径专属的两件事。
 * k6 约束：open() 仅 init 阶段可用 → 全部 dat 必须装载时一次读入；
 * SharedArray 只能存 JSON 可序列化数据 → 行数据进 SharedArray（全 VU 一份），
 * 二进制 dat 进不了 → 每 VU 复制一份，内存 ≈ VU 数 × dat 总字节，大文件警惕。
 */
import { SharedArray } from 'k6/data';
import { rowsFromJson } from '../../lib/rows.js';

function envOr(key, fallback) {
  const v = __ENV[key];
  return v === undefined || v === '' ? fallback : v;
}

// 变体池切换（对照实验）不改脚本：CREATE_DATA_FILE=data/trade-svc/<变体>.json
export const DATA_FILE = envOr('CREATE_DATA_FILE', 'data/trade-svc/trades-create.json');
if (!DATA_FILE.endsWith('.json')) {
  throw new Error(`数据文件必须是 .json: ${DATA_FILE}（契约见 lib/rows.js）`);
}

export const createCases = new SharedArray('create-cases', () =>
  rowsFromJson(open(import.meta.resolve(`../../../${DATA_FILE}`)), DATA_FILE)
);

/** 全局游标轮换：i 用 exec.scenario.iterationInTest——均匀覆盖且可复现 */
export function pickCase(i) {
  if (createCases.length === 0) throw new Error(`${DATA_FILE} 没有数据行`);
  return createCases[Math.abs(i) % createCases.length];
}

// ── dat 按行引用预载：只加载数据文件实际引用的文件 ──
const DAT_ROOT = '../../../data/datfiles/';
const datBinaries = {};
for (let i = 0; i < createCases.length; i++) {
  const rel = String(createCases[i].datFile || '').replace(/\\/g, '/');
  if (!rel || datBinaries[rel] !== undefined) continue;
  datBinaries[rel] = open(import.meta.resolve(DAT_ROOT + rel), 'b');
}

export function getDat(relPath) {
  const b = datBinaries[String(relPath || '').replace(/\\/g, '/')];
  if (b === undefined) {
    throw new Error(`dat 未预载: ${relPath}——检查 ${DATA_FILE} 的 datFile 字段与 data/datfiles/ 是否一致`);
  }
  return b;
}

/** multipart 上传文件名取路径末段（路径分隔符统一 /，防 Windows 反斜杠混入文件名） */
export function datBaseName(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}
