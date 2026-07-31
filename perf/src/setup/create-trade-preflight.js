/*
 * create 路径的本地数据闸：setup() 中运行，整轮开始前一次。
 * 只回答一个问题且不发任何请求："数据文件填好了吗"——占位符、缺字段、空池。
 * 这些问题会让每一次迭代以同样方式失败，在这里拦截零成本且能报出精确行号。
 * "数据今天是否仍有效"由 smoke 会话纪律 + 长跑熔断线回答（见 data/trade-svc/README.md）。
 */
import exec from 'k6/execution';
import { createCases, pickCase, DATA_FILE } from '../api/trade-svc/trades-data.js';
import { validateInputs } from '../api/trade-svc/trades.js';

export function createTradePreflight() {
  console.log('── preflight: create 用例池本地校验 ──');
  console.log(`data=${DATA_FILE} rows=${createCases.length}`);

  if (createCases.length === 0) {
    exec.test.abort(`PREFLIGHT FAILED — 数据文件无数据行: ${DATA_FILE}`);
  }

  const all = [];
  for (let i = 0; i < createCases.length && i < 50; i++) {
    validateInputs(pickCase(i)).forEach((p) => all.push(`[row ${pickCase(i).__row}] ${p}`));
  }
  if (all.length > 0) {
    console.error('PREFLIGHT FAILED — 静态数据不可用:');
    all.slice(0, 10).forEach((p) => console.error('  ' + p));
    exec.test.abort(`静态数据不可用（${all.length} 处问题，见上方日志）`);
  }
  console.log('✓ 本地数据校验通过：字段完整、无占位符');

  // 返回值须 JSON 可序列化（k6 会复制给每个 VU）
  return { startedAt: new Date().toISOString(), dataFile: DATA_FILE };
}
