import exec from 'k6/execution';
import { cfg, loadData, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickAt } from '../lib/data.js';
import { queryTrades } from '../api/trade-svc/trades-read.js';

export const meta = { tags: ['P0', 'trade-svc', 'read'] };

const DATA = loadData('trade-svc/trades-query');

// perf_trades_rows avg>0：空库守卫（空库上的查询数字无意义）
export const options = buildOptions('trade-svc/trades', 'query', {
  perf_trades_rows: ['avg>0'],
});

export default function () {
  const i = exec.scenario.iterationInTest;
  queryTrades(cfg, pickAt(DATA.filters, i), pickUser(cfg, 'maker', __VU));
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
