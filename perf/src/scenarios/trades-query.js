import { cfg, loadData, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { pick } from '../lib/data.js';
import { queryTrades } from '../api/trade-svc/trades.js';

export const meta = { tags: ['P0', 'trade-svc', 'read'] };

const DATA = loadData('trade-svc/trades-query');

export const options = buildOptions('trade-svc/trades', 'query');

export default function () {
  const user = pickUser(cfg, 'maker', __VU);
  const filter = pick(DATA.filters, __VU, __ITER);
  queryTrades(cfg, filter, user);
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
