import exec from 'k6/execution';
import { cfg, loadData, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pickAt } from '../lib/data.js';
import { queryTrades } from '../api/worker-svc/trade/query.js';

// P0 · worker-svc/trade · read path

const DATA = loadData('worker-svc/trade/trades-query');

// perf_trades_rows avg>0: empty-DB guard (query numbers against an empty DB are meaningless)
export const options = buildOptions('worker-svc/trade', 'query', {
  perf_trades_rows: ['avg>0'],
});

export default function () {
  const i = exec.scenario.iterationInTest;
  queryTrades(cfg, pickAt(DATA.filters, i), pickUser(cfg, 'maker', __VU));
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
