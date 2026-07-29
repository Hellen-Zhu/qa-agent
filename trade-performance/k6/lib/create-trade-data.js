/*
 * lib/create-trade-data.js —— **create-trade 这条被测路径**的输入数据
 *
 * ── 为什么数据文件路径不在 config/<env>.json 里 ──
 * 三维正交里 config 是"打哪个环境"（地址、身份、超时、preflight 策略），
 * "用哪个用例池"是**计划维度**的事：p05 压列表接口根本不需要 create 用例，
 * 放在 env config 里等于让每个环境都声明一份与自己无关的配置。
 * 默认路径因此内置在本模块 —— 谁用这条路径，谁带着自己的数据。
 * 需要临时换池（坏 .dat 实验、锁竞争对照）用 CREATE_DATA_FILE 覆盖。
 *
 * ⚠ 数据**内容**是环境相关的（id 不跨环境通用，见 data/create-trade/README.md），
 *   但**路径**不是 —— 换环境时重新采集填进同一个文件，而不是换一个路径。
 *   真需要按环境分文件时，用 CREATE_DATA_FILE 指过去，别加回 env config。
 *
 * ── 命名约定 ──
 *   lib/<被测路径>-data.js        该路径的数据装载与取数（本文件）
 *   setup/<被测路径>-preflight.js 该路径的开跑前守卫
 * 两者成对出现：数据怎么来、怎么证明它今天还能用，属于同一件事。
 *
 * ── 数据格式：仅 JSON ──
 * 契约见 lib/rows.js：顶层 rows 数组、_ 开头键是注释、值一律转字符串。
 *
 * ══ 三个必须理解的 k6 约束 ═══════════════════════════════════
 *
 * 1. open() 只能在 **init 上下文** 调用。
 *    → 所有 .dat 必须在模块加载时**一次性全部读进内存**，
 *      不能"每次迭代按数据行的 datFile 字段去读盘"。
 *
 * 2. SharedArray 只能存 **JSON 可序列化** 的数据。
 *    → 行数据可以放（省内存），**二进制 .dat 放不进去**。
 *
 * 3. 因此 .dat 是 **按 VU 复制** 的：
 *
 *        内存 ≈ VU 数 × 所有 .dat 的总字节数
 *
 *    20 VU × 3 个 5MB 的文件 = 300MB。可接受。
 *    20 VU × 3 个 50MB 的文件 = 3GB。**不可接受**。
 *
 *    这是 k6 的**真实劣势**，不要粉饰。真撞上了有两条路：
 *      a) 用 k6/experimental/fs 做惰性读取（较新版本）
 *      b) 拆成多个 scenario，每个只加载自己那一个 productType
 *    先量再优化 —— 跑起来看 `k6 run` 输出的内存，别提前设计。
 * ═══════════════════════════════════════════════════════════
 */

import { SharedArray } from 'k6/data';
import { rowsFromJson } from './rows.js';

// 相对 lib/ → 上一级到 k6/（数据路径都以 k6/ 为根）
const ROOT = '../';

/** 覆盖项语义与 lib/config.js 的 pick() 一致：空串等同未设置 */
function envOr(key, fallback) {
  const v = __ENV[key];
  return v === undefined || v === '' ? fallback : v;
}

/**
 * 用例池路径。默认值就在这里 —— 换池不改脚本：
 *   ./k6/run.sh p02-trade-create dev baseline CREATE_DATA_FILE=data/create-trade/create-trade-invalid.json
 */
export const DATA_FILE = envOr('CREATE_DATA_FILE', 'data/create-trade/create-trade-data.json');

// .dat 样本根目录。目前只有 create 路径上传 .dat（create / calc-risk-for-new），
// 将来若有别的路径也传文件，再抽成共享常量。
const DAT_DIR = 'data/dat';

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
 * ── DAT_NAME_MODE：上传文件名唯一化（绕服务端缺陷的偏差开关）──
 *
 * 服务端收到上传后按**时间戳**生成临时文件名，处理完删除。并发同刻到达
 * 时两笔请求落到同一个临时文件：先完成的一笔把文件删了，后一笔报
 * "找不到 dat"。缺陷论证与验证协议见 data/dat/README.md「服务端临时文件竞态」。
 *
 * unique 模式给 multipart 的 filename 加唯一后缀，**字节内容不变**，
 * 不需要复制物理文件（复制 N 份 = 内存放大 N 倍，见文件头约束 3）。
 * 有效性取决于服务端临时名是否包含客户端文件名：
 *   包含 → 名字唯一则临时路径唯一，碰撞消失；
 *   只有时间戳 → 改名无效，碰撞照旧 —— 跑一轮对照就能判定是哪种。
 *
 * ⚠ 默认 original：生产用户不会改名上传，unique 跑出的错误率会低估
 *   生产，报告必须标注偏差；缺陷修复后关掉本开关做并发复测，
 *   就是该缺陷的回归验证。
 */
export const DAT_NAME_MODE = envOr('DAT_NAME_MODE', 'original');
if (DAT_NAME_MODE !== 'original' && DAT_NAME_MODE !== 'unique') {
  throw new Error(`DAT_NAME_MODE=${DAT_NAME_MODE} 无效，只接受 original | unique`);
}

// 每个 VU 有独立的 JS VM，模块级计数器天然按 VU 隔离 —— 与 __VU 组合
// 即本次运行内全局唯一；rand4 防两个 runner 同时在跑（手动 + CI）时跨进程重名
let uploadSeq = 0;

/** 上传用的 filename：original 用原名；unique 在扩展名前插唯一段 */
export function uploadName(relPath) {
  const base = baseName(relPath);
  if (DAT_NAME_MODE === 'original') return base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';   // 扩展名保留 —— 服务端可能校验 .dat
  uploadSeq += 1;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stem}__u${__VU}-${uploadSeq}-${rand}${ext}`;
}

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
// counterpartyFmId / counterpartyName），没有独立的 refdata 池。
export const createCases = new SharedArray('create-cases', () => loadRows(DATA_FILE));

// ── .dat：按 VU 复制，无法避免 ───────────────────────────────
// 只加载数据文件里真正引用到的文件，不扫整个目录 —— 目录里可能躺着
// synthetic/ 和 invalid/ 的大文件，全读进来纯属浪费。
const datBinaries = {};
for (let i = 0; i < createCases.length; i++) {
  const rel = normalizePath(createCases[i].datFile);
  if (!rel || datBinaries[rel] !== undefined) continue;
  datBinaries[rel] = open(ROOT + DAT_DIR + '/' + rel, 'b');
}

export function getDat(relPath) {
  const b = datBinaries[normalizePath(relPath)];
  if (b === undefined) {
    // 只会在数据与磁盘不一致时发生，且此时已过了 init —— 只能报错，不能补读
    throw new Error(
      `.dat 未加载：${relPath}。init 阶段只加载数据文件引用到的文件，` +
      `请检查 ${DATA_FILE} 的 datFile 字段与 ${DAT_DIR}/ 是否一致` +
      `（跑 ./scripts/index-dat.py 对账）`
    );
  }
  return b;
}

/*
 * ── 取数：全局游标 roundRobin ────────────────────────────────
 *
 * iterationInTest 是**跨全部 VU 的全局单调计数器**：
 * 全部 VU 按同一个游标轮换用例，覆盖均匀且可复现。
 * setup() 不占用 scenario 迭代 —— 主循环从第一条数据开始，没有偏移。
 */
export function pickCase(i) {
  if (createCases.length === 0) throw new Error(`${DATA_FILE} 没有数据行`);
  return createCases[i % createCases.length];
}
