/*
 * tests/csv.test.mjs —— lib/csv.js 的单元测试
 *
 * 跑法：node k6/tests/csv.test.mjs
 *
 * lib/csv.js 是**兼容路径**：主格式是 JSON（见 rows.test.mjs），
 * 但 CREATE_DATA_FILE=xxx.csv 依然能读 —— 供真值 CSV 尚未搬进 JSON 的机器过渡。
 * 只要这条路径还在，解析逻辑就要有测试。
 *
 * 这里用 node 直接 import，因为 lib/csv.js **不依赖任何 k6 模块**。
 * 这不是巧合：解析、判定、拼装这类纯逻辑都应该和 k6 API 隔离开，
 * 隔离开就能测。用到 http / metrics 的部分（errors.js、create-trade.js）
 * 需要 k6 运行时，测法见 README.zh.md「怎么测脚本本身」。
 */

import { parseCsv } from '../lib/csv.js';
import assert from 'node:assert';

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

t('引号包裹、内含逗号 ← 不处理引号的解析器会在这里错位', () => {
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

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
