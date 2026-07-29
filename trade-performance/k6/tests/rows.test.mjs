/*
 * k6/tests/rows.test.mjs —— lib/rows.js 的单元测试
 *
 * 跑法（在项目根目录）：
 *   node k6/tests/rows.test.mjs
 *
 * 与 csv.test.mjs 同理：lib/rows.js 不依赖任何 k6 模块，node 直接 import。
 * 最后两条用**真实数据文件**做冒烟 —— 解析器对，不代表文件本身对。
 */

import { rowsFromJson } from '../lib/rows.js';
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

console.log('\nlib/rows.js\n');

t('裸数组', () => {
  const r = rowsFromJson('[{"a":"1"},{"a":"2"}]', 't');
  assert.equal(r.length, 2);
  assert.equal(r[0].a, '1');
});

t('rows 包装 + 顶层 _ 键忽略', () => {
  const r = rowsFromJson('{"_comment":"x","rows":[{"a":"1"}]}', 't');
  assert.equal(r.length, 1);
  assert.equal(r[0].a, '1');
});

t('行内 _ 开头键剥掉，note 不带下划线则保留', () => {
  const r = rowsFromJson('[{"a":"1","_why":"注释","note":"数据列"}]', 't');
  assert.equal(r[0]._why, undefined);
  assert.equal(r[0].note, '数据列');
});

t('数字与布尔转字符串（CSV 语义对齐）', () => {
  const r = rowsFromJson('[{"id":10052235,"flag":true}]', 't');
  assert.strictEqual(r[0].id, '10052235');
  assert.strictEqual(r[0].flag, 'true');
});

t('null → 空串', () => {
  const r = rowsFromJson('[{"a":null}]', 't');
  assert.strictEqual(r[0].a, '');
});

t('值去首尾空白', () => {
  const r = rowsFromJson('[{"a":"  x  "}]', 't');
  assert.strictEqual(r[0].a, 'x');
});

t('__row 从 1 起编号', () => {
  const r = rowsFromJson('[{"a":"1"},{"a":"2"}]', 't');
  assert.equal(r[0].__row, 1);
  assert.equal(r[1].__row, 2);
});

t('非法 JSON：报错含来源与注释提示', () => {
  assert.throws(
    () => rowsFromJson('{"rows":[{"a":1},]}', 'data/x.json'),
    (e) => e.message.includes('data/x.json') && e.message.includes('注释')
  );
});

t('顶层结构不对：报错', () => {
  assert.throws(
    () => rowsFromJson('{"cases":[]}', 't'),
    (e) => e.message.includes('rows')
  );
});

t('某条不是对象：报错含条号', () => {
  assert.throws(
    () => rowsFromJson('[{"a":"1"},"oops"]', 't'),
    (e) => e.message.includes('第 2 条')
  );
});

// ── 真实文件冒烟 ──────────────────────────────────────────────
t('真实文件：refdata-pairs.json 字段齐全', () => {
  const text = fs.readFileSync(path.join(ROOT, 'data/refdata/refdata-pairs.json'), 'utf8');
  const rows = rowsFromJson(text, 'refdata-pairs.json');
  assert.ok(rows.length >= 1);
  ['pairId', 'portfolioId', 'counterpartyFmId', 'counterpartyName'].forEach((k) =>
    assert.ok(k in rows[0], `缺字段 ${k}`)
  );
});

t('真实文件：create-trade-data.json 字段齐全', () => {
  const text = fs.readFileSync(path.join(ROOT, 'data/create-trade/create-trade-data.json'), 'utf8');
  const rows = rowsFromJson(text, 'create-trade-data.json');
  assert.ok(rows.length >= 1);
  ['caseId', 'datFile', 'productType'].forEach((k) =>
    assert.ok(k in rows[0], `缺字段 ${k}`)
  );
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
