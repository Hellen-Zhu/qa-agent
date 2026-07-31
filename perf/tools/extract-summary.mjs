import { readFileSync, writeFileSync } from 'node:fs';
import { fromLogs } from '../src/lib/report.js';

const [logPath, outPath] = process.argv.slice(2);
if (!logPath || !outPath) {
  console.error('usage: node tools/extract-summary.mjs <run.log> <out.json>');
  process.exit(2);
}
const summary = fromLogs(readFileSync(logPath, 'utf8'));
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(outPath);
