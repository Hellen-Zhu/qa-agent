import { pick } from '../lib/data.js';

// 产品类型 → dat 模板文件。扩产品 = data/datfiles/ 加文件 + 此处注册。
const DAT_BY_PRODUCT = { TRF: 'FX_TRF.dat' };

export function datFileFor(product) {
  const f = DAT_BY_PRODUCT[product];
  if (!f) throw new Error(`no dat template for product: ${product}`);
  return f;
}

export function uniqueRef(vu, iter, runId) {
  return `PERF-${runId}-${vu}-${iter}`;
}

// trade JSON part。字段集合对齐真实 create 接口；
// portfolioId=PERF_TEST 是压测数据标记（spec 遗留问题 #3，字段可换）；
// clientRef 承载唯一标记（真实字段名待确认，spec 遗留问题 #3/#4）。
export function buildTradePart(counterparties, vu, iter, runId) {
  const cp = pick(counterparties, vu, iter);
  return {
    basic: {
      portfolioId: 'PERF_TEST',
      counterpartyFmId: cp.counterpartyFmId,
      counterpartyName: cp.counterpartyName,
      notionalCurrency: '',
      clientRef: uniqueRef(vu, iter, runId),
    },
  };
}
