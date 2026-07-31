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

// ── dat 约定预载：productType → data/datfiles/products/<productType>/<productType>.dat ──
// 约定优于配置：行里只写 productType，dat 按同名约定定位——数据文件无路径字符串可打错，
// 加产品 = 放一个约定命名的文件 + 加一行数据。同一产品需要多个 dat 样本时，
// 再为行增加可选 datFile 覆盖列（当前 YAGNI）。只预加载数据文件实际引用的产品。
const DAT_ROOT = '../../../data/datfiles/products/';
// productType 会拼进文件路径：先过字符集闸（顺带在装载时就拦住拼写异常）
const PRODUCT_TYPE_RE = /^[A-Za-z0-9_-]+$/;
const datBinaries = {};
for (let i = 0; i < createCases.length; i++) {
  const pt = createCases[i].productType || '';
  if (!pt || datBinaries[pt] !== undefined) continue;
  if (!PRODUCT_TYPE_RE.test(pt)) {
    throw new Error(
      `${DATA_FILE} 第 ${createCases[i].__row} 行 productType='${pt}' 含非法字符（仅允许字母/数字/_/-）`
    );
  }
  datBinaries[pt] = open(import.meta.resolve(`${DAT_ROOT}${pt}/${pt}.dat`), 'b');
}

export function getDat(productType) {
  const b = datBinaries[productType];
  if (b === undefined) {
    throw new Error(
      `dat 未预载: ${productType}——确认 data/datfiles/products/${productType}/${productType}.dat 存在` +
      `且 ${DATA_FILE} 的 productType 拼写一致`
    );
  }
  return b;
}

/** multipart 上传文件名：按约定即 <productType>.dat */
export function datName(productType) {
  return `${productType}.dat`;
}
