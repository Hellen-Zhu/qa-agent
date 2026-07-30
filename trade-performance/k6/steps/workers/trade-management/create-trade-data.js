/*
 * steps/workers/trade-management/create-trade-data.js
 * —— **create-trade 这条被测路径**的供数（用例池实例化 + .dat 预载）
 *
 * 【层级】路径供数 —— 通用机制在 lib/case-pool.js，这里只做两件路径特有的事：
 *   1. 实例化 create 的用例池（SharedArray 名、覆盖项键、默认数据文件）
 *   2. .dat 二进制预载与上传命名（只有上传类路径才有这一段）
 * 与消费它的步骤（create-trade / calc-risk-for-new）同目录 ——
 * 数据文件（.json）纯放 data/，代码不混进去。
 *
 * ── 为什么默认数据文件路径在这里，不在 config/<env>.json ──
 * 三维正交里 config 是"打哪个环境"（地址、身份、超时、preflight 策略），
 * "用哪个用例池"是**计划维度**的事：p05 压列表接口根本不需要 create 用例，
 * 放在 env config 里等于让每个环境都声明一份与自己无关的配置。
 * 需要临时换池（锁竞争对照等变体池）用 CREATE_DATA_FILE 覆盖。
 *
 * ⚠ 数据**内容**是环境相关的（id 不跨环境通用，见 data/workers/trade-management/README.md），
 *   但**路径**不是 —— 换环境时重新采集填进同一个文件，而不是换一个路径。
 *
 * ══ 三个必须理解的 k6 约束 ═══════════════════════════════════
 *
 * 1. open() 只能在 **init 上下文** 调用，相对路径以**本文件**为基准。
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

import { makeCasePool, envOr, normalizePath, baseName } from '../../../lib/case-pool.js';

// import.meta.resolve 锚定本文件（open() 相对路径语义新旧版本都稳定，
// 见 lib/case-pool.js 头注）
const ROOT = '../../../'; // steps/workers/trade-management/ → k6/

// .dat 样本根目录。目前只有 create 路径上传 .dat（create / calc-risk-for-new），
// 将来若有别的路径也传文件，再把这一段抽成 lib/ 的通用二进制池。
const DAT_DIR = 'data/dat';

// ── 用例池：一条 = 一个完整用例 ──────────────────────────────
// .dat 引用 + 内嵌归属字段（portfolioId / counterpartyFmId /
// counterpartyName），没有独立的 refdata 池。行的标识是加载时
// 自动注入的 __row（第几行，1 起），数据文件不维护 id 列。
// 换池不改脚本：
//   ./k6/run.sh p02-trade-create dev baseline CREATE_DATA_FILE=data/workers/trade-management/create-trade-lock-variant.json
const pool = makeCasePool({
  name: 'create-cases',
  envKey: 'CREATE_DATA_FILE',
  defaultFile: 'data/workers/trade-management/create-trade.json',
});

export const DATA_FILE = pool.file;
export const createCases = pool.rows;

/** 全局游标 roundRobin：i 用 exec.scenario.iterationInTest，覆盖均匀且可复现 */
export function pickCase(i) {
  return pool.pick(i);
}

// ── .dat：按 VU 复制，无法避免 ───────────────────────────────
// 只加载数据文件里真正引用到的文件，不扫整个目录 —— 目录里可能躺着
// synthetic/ 的大文件，全读进来纯属浪费。
const datBinaries = {};
for (let i = 0; i < createCases.length; i++) {
  const rel = normalizePath(createCases[i].datFile);
  if (!rel || datBinaries[rel] !== undefined) continue;
  datBinaries[rel] = open(import.meta.resolve(ROOT + DAT_DIR + '/' + rel), 'b');
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
