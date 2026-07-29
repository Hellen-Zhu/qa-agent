/*
 * lib/data.js —— 数据装载
 *
 * ── 数据格式：仅 JSON ──
 * 契约见 lib/rows.js：顶层 rows 数组、_ 开头键是注释、值一律转字符串。
 * 曾有 .csv 兼容路径（lib/csv.js），2026-07-29 移除：归属字段内嵌进用例行后，
 * 旧真值 CSV 的列结构与新 schema 不再兼容，"直读旧 CSV 过渡"这个场景已不存在 ——
 * 旧 CSV 里的真值请手工填进 JSON。
 *
 * ══ 三个必须理解的 k6 约束 ═══════════════════════════════════
 *
 * 1. open() 只能在 **init 上下文** 调用。
 *    → 所有 .dat 必须在模块加载时**一次性全部读进内存**，
 *      不能像 JMeter 那样"每次迭代按 CSV 的 datFile 列去读盘"。
 *
 * 2. SharedArray 只能存 **JSON 可序列化** 的数据。
 *    → CSV 行可以放（省内存），**二进制 .dat 放不进去**。
 *
 * 3. 因此 .dat 是 **按 VU 复制** 的：
 *
 *        内存 ≈ VU 数 × 所有 .dat 的总字节数
 *
 *    20 VU × 3 个 5MB 的文件 = 300MB。可接受。
 *    20 VU × 3 个 50MB 的文件 = 3GB。**不可接受**。
 *
 *    这是 k6 相对 JMeter 的**真实劣势**，不要粉饰。
 *    真撞上了有两条路：
 *      a) 用 k6/experimental/fs 做惰性读取（较新版本）
 *      b) 拆成多个 scenario，每个只加载自己那一个 productType
 *    先量再优化 —— 跑起来看 `k6 run` 输出的内存，别提前设计。
 * ═══════════════════════════════════════════════════════════
 */

import { SharedArray } from 'k6/data';
import { rowsFromJson } from './rows.js';
import { cfg } from './config.js';

// 相对 lib/ → 上一级到 k6/（数据路径都以 k6/ 为根）
const ROOT = '../';

function loadRows(relPath) {
  if (!relPath.endsWith('.json')) {
    throw new Error(
      `数据文件只支持 .json：${relPath}。` +
      `.csv 兼容路径已于 2026-07-29 移除（旧 CSV 列结构与内嵌归属字段的新 schema 不兼容），` +
      `请把值填进 JSON（契约见 lib/rows.js，采集方式见 data/create-trade/README.md）`
    );
  }
  return rowsFromJson(open(ROOT + relPath), relPath);
}

// ── 行数据：走 SharedArray，全部 VU 共用一份 ─────────────────
// open() 在 SharedArray 的回调里调用是官方推荐写法：回调只在 init 执行一次，
// 结果存在 Go 侧，JS 侧按需取 —— 这才是"共享"的意思。
// 一条 = 一个完整用例：.dat 引用 + 内嵌归属字段（portfolioId /
// counterpartyFmId / counterpartyName），不再有独立的 refdata 池。
export const createCases = new SharedArray('create-cases', () =>
  loadRows(cfg.data.createDataFile)
);

// ── .dat：按 VU 复制，无法避免 ───────────────────────────────
// 只加载数据文件里真正引用到的文件，不扫整个目录 —— 目录里可能躺着
// synthetic/ 和 invalid/ 的大文件，全读进来纯属浪费。
const datBinaries = {};
for (let i = 0; i < createCases.length; i++) {
  const rel = normalizePath(createCases[i].datFile);
  if (!rel || datBinaries[rel] !== undefined) continue;
  datBinaries[rel] = open(ROOT + cfg.data.datDir + '/' + rel, 'b');
}

export function getDat(relPath) {
  const b = datBinaries[normalizePath(relPath)];
  if (b === undefined) {
    // 只会在 CSV 与磁盘不一致时发生，且此时已过了 init —— 只能报错，不能补读
    throw new Error(
      `.dat 未加载：${relPath}。init 阶段只加载数据文件引用到的文件，` +
      `请检查 ${cfg.data.createDataFile} 的 datFile 字段与 data/dat/ 是否一致` +
      `（跑 ./scripts/index-dat.py 对账）`
    );
  }
  return b;
}

/*
 * 路径归一化：datFile 字段一律用 /，但在 Windows 上编辑过的数据文件
 * 可能混进反斜杠（\）。k6 的 open() 在 Windows 上两种都认，
 * 但 baseName 只按 / 切就会把整条路径当成文件名塞进 multipart 的 filename，
 * 发出去变成 `filename="products\FX_TRF\fx_trf_01.dat"` —— 服务端多半照单全收，
 * 于是**请求成功、文件名是错的**，报告里完全看不出来。
 */
export function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

/** multipart 的 filename 部分，取路径最后一段 */
export function baseName(relPath) {
  const p = normalizePath(relPath);
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/*
 * ── 取数：全局游标 roundRobin ────────────────────────────────
 *
 * iterationInTest 是**跨全部 VU 的全局单调计数器**：
 * 全部 VU 按同一个游标轮换用例，覆盖均匀且可复现。
 * setup() 不占用 scenario 迭代 —— 主循环从第一条数据开始，没有偏移。
 */
export function pickCase(i) {
  if (createCases.length === 0) throw new Error(`${cfg.data.createDataFile} 没有数据行`);
  return createCases[i % createCases.length];
}
