// Cucumber 风格 tag 筛选的基础：从场景源码提取 `export const meta = {...};`。
// 场景文件 import 了 k6 模块，Node 无法直接执行，因此靠源码解析 + 字面量求值。
// 约束：meta 必须是静态对象字面量（不嵌套对象）。
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

export function extractMeta(source) {
  const m = source.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!m) return null;
  return new Function(`return (${m[1]});`)();
}

export function listScenarios(dir, requiredTags) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => ({
      name: basename(f, '.js'),
      meta: extractMeta(readFileSync(join(dir, f), 'utf8')),
    }))
    .filter((s) => s.meta && Array.isArray(s.meta.tags)
      && requiredTags.every((t) => s.meta.tags.includes(t)))
    .map((s) => s.name);
}

if (process.argv[1] && process.argv[1].endsWith('scenario-meta.mjs')) {
  const [dir, tags] = process.argv.slice(2);
  const names = listScenarios(dir || 'src/scenarios', (tags || '').split(',').filter(Boolean));
  for (const n of names) console.log(n);
}
