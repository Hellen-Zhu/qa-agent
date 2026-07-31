import { readFileSync, writeFileSync } from 'node:fs';
import { toHtml } from '../src/lib/report.js';

const jsonPath = process.argv[2];
if (!jsonPath) {
  console.error('usage: node tools/render-report.mjs reports/<testid>.json');
  process.exit(2);
}
const summary = JSON.parse(readFileSync(jsonPath, 'utf8'));
const out = jsonPath.replace(/\.json$/, '.html');
writeFileSync(out, toHtml(summary));
console.log(out);
