/*
 * lib/data.js —— 数据装载
 *
 * 对应 JMeter 的两个 CSV Data Set + ${datDir}/${effectiveDatFile}。
 *
 * ── 数据格式：JSON 为主，CSV 兼容 ──
 * k6 侧主格式是 JSON（契约见 lib/rows.js：顶层 rows 数组、_ 开头键是注释、
 * 值一律转字符串保持 CSV 语义）。按**文件扩展名**分发解析器，
 * `.csv` 路径依然能读 —— 两个用途：
 *   1. 手上已有真值 CSV 的机器可先 REFDATA_FILE=xxx.csv 顶住，
 *      再用 scripts/data-sync.py --from-csv --write 迁进 JSON；
 *   2. 快速复用 JMeter 侧/DevTools 导出的现成文件做对照实验。
 * JMeter 侧读的 .csv 由 scripts/data-sync.py 从 JSON 生成 —— JSON 是唯一源。
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
import { parseCsv } from './csv.js';
import { rowsFromJson } from './rows.js';
import { cfg } from './config.js';

// 相对 k6/lib/ → 上两级到 trade-performance/
const ROOT = '../../';

/** 按扩展名分发：.json 走 rows.js（主格式），其余按 CSV 解析（兼容） */
function loadRows(relPath) {
  const text = open(ROOT + relPath);
  return relPath.endsWith('.json') ? rowsFromJson(text, relPath) : parseCsv(text);
}

// ── 行数据：走 SharedArray，全部 VU 共用一份 ─────────────────
// open() 在 SharedArray 的回调里调用是官方推荐写法：回调只在 init 执行一次，
// 结果存在 Go 侧，JS 侧按需取 —— 这才是"共享"的意思。
export const refdataPairs = new SharedArray('refdata-pairs', () =>
  loadRows(cfg.data.refdataFile)
);

export const createCases = new SharedArray('create-cases', () =>
  loadRows(cfg.data.createDataFile)
);

// ── .dat：按 VU 复制，无法避免 ───────────────────────────────
// 只加载 CSV 里真正引用到的文件，不扫整个目录 —— 目录里可能躺着
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
      `.dat 未加载：${relPath}。init 阶段只加载 CSV 引用到的文件，` +
      `请检查 ${cfg.data.createDataFile} 的 datFile 列与 data/dat/ 是否一致` +
      `（跑 ./scripts/index-dat.py 对账）`
    );
  }
  return b;
}

/*
 * 路径归一化：CSV 里的 datFile 列一律用 /，但在 Windows 上编辑过的 CSV
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
 * ── 取数：模拟 JMeter 的 shareMode.all（全局游标）─────────────
 *
 * iterationInTest 是**跨全部 VU 的全局单调计数器**，语义与 shareMode.all 一致。
 *
 * ⚠ 与 JMeter 相同的耦合陷阱依然存在：
 *   两个数组用同一个 i 取模，**行数相同时组合会被锁死**
 *   （N 行 × N 行只跑到 N 种，而不是 N²）。
 *   行数取互质即可打散。这条约束是数学的，跟工具无关。
 *
 * ✅ 与 JMeter 的一处**改进**：
 *   JMeter 的 setUp 线程会消耗掉 CSV 第一行，主循环从第二行开始。
 *   k6 的 setup() 不占用 scenario 迭代，**没有这个偏移**。
 */
export function pickCase(i) {
  if (createCases.length === 0) throw new Error(`${cfg.data.createDataFile} 没有数据行`);
  return createCases[i % createCases.length];
}

export function pickRefdata(i) {
  if (refdataPairs.length === 0) throw new Error(`${cfg.data.refdataFile} 没有数据行`);
  return refdataPairs[i % refdataPairs.length];
}
