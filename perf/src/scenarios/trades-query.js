import exec from 'k6/execution';
import { cfg, loadData, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickAt } from '../lib/data.js';
import { queryTrades } from '../api/worker-svc/trade-management-read.js';

// P0 · worker-svc/trade-management · 读路径

const DATA = loadData('worker-svc/trade-management/trades-query');

// perf_trades_rows avg>0：空库守卫（空库上的查询数字无意义）
export const options = buildOptions('worker-svc/trade-management', 'query', {
  perf_trades_rows: ['avg>0'],
});

export default function () {
  const i = exec.scenario.iterationInTest;
  queryTrades(cfg, pickAt(DATA.filters, i), pickUser(cfg, 'maker', __VU));
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
