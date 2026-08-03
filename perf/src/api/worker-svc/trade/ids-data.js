/*
 * trade ID 池：detail 与 risk-metrics 两个读场景共享（压的是同一批真实 trade）。
 * ID 随环境失效（不跨环境），换环境按 data README 重新采集。
 * 占位符闸放在 setup 阶段（tradeIdsPreflight）而非 init——k6 inspect 要能在
 * 占位数据上通过（仓库内只有占位符是纪律），init 只做结构校验。
 * ⚠ 池中 ID 失效时服务端返回 404，按引擎规则落 technical 类（http-404）——
 *   读场景的"数据过期"以这个形态出现：见到 http-404 先重采 ID，别当性能问题。
 */
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

const PLACEHOLDER = /tbc|todo|placeholder|xxx/i;

export const tradeIds = new SharedArray('trade-ids', () => {
  const doc = JSON.parse(open(import.meta.resolve('../../../../data/worker-svc/trade/trade-ids.json')));
  const ids = (doc.ids || []).map(String);
  if (ids.length === 0) {
    throw new Error('data/worker-svc/trade/trade-ids.json 没有 ids（采集方式见该目录 README）');
  }
  return ids;
});

/** setup 阶段数据闸：占位符即中止（PREFLIGHT FAILED 关键字与 run.sh 的提示联动） */
export function tradeIdsPreflight() {
  const bad = [];
  for (let i = 0; i < tradeIds.length; i++) {
    if (PLACEHOLDER.test(tradeIds[i])) bad.push(`#${i + 1} '${tradeIds[i]}'`);
  }
  if (bad.length > 0) {
    console.error(
      `PREFLIGHT FAILED — trade-ids.json 仍是占位符: ${bad.slice(0, 5).join(', ')}` +
      `（共 ${bad.length} 处，采集方式见 data/worker-svc/trade/README.md）`
    );
    exec.test.abort('trade ID 池未通过本地校验');
  }
}

/** 全局游标轮换（i = exec.scenario.iterationInTest） */
export function pickTradeId(i) {
  return tradeIds[Math.abs(i) % tradeIds.length];
}
