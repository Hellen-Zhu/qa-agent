import { cfg, TESTID, loadParams, loadDat, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { buildTradePart, datFileFor } from '../payloads/factory.js';
import { createTrade } from '../api/trade-svc/trades.js';

export const meta = { tags: ['P0', 'trade-svc', 'write'] };

const PRODUCT = __ENV.PRODUCT || 'TRF';
const CPS = loadParams('counterparties');
const DAT_NAME = datFileFor(PRODUCT);
const DAT_BIN = loadDat(DAT_NAME);

export const options = buildOptions('trade-svc/trades', 'create');

export default function () {
  const user = pickUser(cfg, 'maker', __VU);
  const trade = buildTradePart(CPS, __VU, __ITER, TESTID);
  createTrade(cfg, trade, DAT_BIN, DAT_NAME, user);
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
