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

// trade JSON part。字段集合对齐真实 create 接口，业务取值全部来自该 API 的
// 专属数据文件 data/trade-svc/trades-create.json（portfolioId/notionalCurrencies/
// counterparties），工厂只负责组装与唯一性：
// - portfolioId=PERF_TEST 为压测数据标记默认值（spec 遗留问题 #3，字段可换）；
// - notionalCurrencies 为币种池（扩多币种前需确认与 dat 产品定义一致，遗留问题 #4）；
// - clientRef 承载唯一标记（真实字段名待确认，spec 遗留问题 #3/#4）。
export function buildTradePart(data, vu, iter, runId) {
  const cp = pick(data.counterparties, vu, iter);
  return {
    basic: {
      portfolioId: data.portfolioId,
      counterpartyFmId: cp.counterpartyFmId,
      counterpartyName: cp.counterpartyName,
      notionalCurrency: pick(data.notionalCurrencies, vu, iter),
      clientRef: uniqueRef(vu, iter, runId),
    },
  };
}
