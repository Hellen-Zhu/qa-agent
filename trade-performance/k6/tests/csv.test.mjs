/*
 * k6/tests/csv.test.mjs —— lib/csv.js 的单元测试
 *
 * 跑法（在项目根目录）：
 *   node k6/tests/csv.test.mjs
 *
 * ══ 为什么这个文件存在 ═══════════════════════════════════════
 * 这是换 k6 的核心理由之一的**实证**：脚本逻辑可以脱离压测独立验证。
 *
 * JMeter 侧的对应逻辑散落在 groovy/*.groovy 里，挂在 JSR223 元件上，
 * **唯一的验证方式是跑一次真实压测** —— 最贵的验证方式，而且
 * 一次跑批同时在验证网络、环境、数据、服务端和脚本，出错时分不清是谁的问题。
 *
 * 这里用 node 直接 import，因为 lib/csv.js **不依赖任何 k6 模块**。
 * 这不是巧合：解析、判定、拼装这类纯逻辑都应该和 k6 API 隔离开，
 * 隔离开就能测。用到 http / metrics 的部分（errors.js、create-trade.js）
 * 需要 k6 运行时，测法见 README.zh.md「怎么测脚本本身」。
 * ═══════════════════════════════════════════════════════════
 */

import { parseCsv } from '../lib/csv.js';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import assert from 'node:assert';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
    pass++;
  } catch (e) {
    console.log('  ✗ ' + name + '\n      ' + e.message);
    fail++;
  }
}

console.log('\nlib/csv.js\n');

t('普通行', () => {
  const r = parseCsv('a,b,c\n1,2,3');
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual({ a: r[0].a, b: r[0].b, c: r[0].c }, { a: '1', b: '2', c: '3' });
});

t('末列为空（notionalCurrency 的真实形态）', () => {
  assert.strictEqual(parseCsv('a,b,c\n1,2,')[0].c, '');
});

t('引号包裹、内含逗号 ← JMeter 侧 quotedData=false 会在这里错位', () => {
  assert.strictEqual(parseCsv('id,name\nR1,"UNIVERSAL WEST, HK"')[0].name, 'UNIVERSAL WEST, HK');
});

t('转义引号 ""', () => {
  assert.strictEqual(parseCsv('id,name\nR1,"say ""hi"" now"')[0].name, 'say "hi" now');
});

t('名字含 *（PRINTINGINT10LTD*HKG 真实存在）', () => {
  assert.strictEqual(parseCsv('id,name\nR1,PRINTINGINT10LTD*HKG')[0].name, 'PRINTINGINT10LTD*HKG');
});

t('CRLF 行尾（Windows 上编辑过的文件）', () => {
  const r = parseCsv('a,b\r\n1,2\r\n');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].b, '2');
});

t('空行被跳过', () => {
  assert.strictEqual(parseCsv('a,b\n1,2\n\n\n3,4\n').length, 2);
});

t('# 注释行被跳过', () => {
  assert.strictEqual(parseCsv('a,b\n# 这是注释\n1,2').length, 1);
});

t('只有表头 → 空数组（不抛异常，由调用方处置）', () => {
  assert.deepStrictEqual(parseCsv('a,b,c'), []);
});

t('列数少于表头 → 缺的补空串，不是 undefined', () => {
  assert.strictEqual(parseCsv('a,b,c\n1,2')[0].c, '');
});

t('__line 指出真实行号（报错时要用）', () => {
  const r = parseCsv('a\n1\n2');
  assert.strictEqual(r[0].__line, 2);
  assert.strictEqual(r[1].__line, 3);
});

console.log('\n真实数据文件\n');

t('data/refdata/refdata-pairs.csv', () => {
  const r = parseCsv(fs.readFileSync(path.join(ROOT, 'data/refdata/refdata-pairs.csv'), 'utf8'));
  assert.ok(r.length > 0, '没有数据行');
  ['pairId', 'portfolioId', 'counterpartyFmId', 'counterpartyName'].forEach((k) =>
    assert.ok(k in r[0], `缺列 ${k} —— 表头与 k6/steps/.../create-trade.js 的期望不一致`)
  );
});

t('data/create-trade/create-trade-data.csv', () => {
  const r = parseCsv(fs.readFileSync(path.join(ROOT, 'data/create-trade/create-trade-data.csv'), 'utf8'));
  assert.ok(r.length > 0, '没有数据行');
  ['caseId', 'datFile', 'productType', 'notionalCurrency'].forEach((k) =>
    assert.ok(k in r[0], `缺列 ${k}`)
  );
});

t('两份 CSV 行数互质（否则组合被锁死）', () => {
  const a = parseCsv(fs.readFileSync(path.join(ROOT, 'data/refdata/refdata-pairs.csv'), 'utf8')).length;
  const b = parseCsv(fs.readFileSync(path.join(ROOT, 'data/create-trade/create-trade-data.csv'), 'utf8')).length;
  const gcd = (x, y) => (y === 0 ? x : gcd(y, x % y));
  // 任一为 1 时不存在耦合问题
  assert.ok(
    a === 1 || b === 1 || gcd(a, b) === 1,
    `refdata=${a} 行、case=${b} 行，最大公约数 ${gcd(a, b)} > 1 —— ` +
      `组合会被锁死，只跑到 ${(a * b) / gcd(a, b)} 种而不是 ${a * b} 种`
  );
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
