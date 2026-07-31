import http from 'k6/http';
import * as client from '../../lib/http.js';
import { bookingDuration, bookingErrors } from '../../lib/metrics.js';

const SVC = 'trade-svc';
const MOD = 'trades';

export function queryTrades(cfg, filter, user) {
  return client.get(cfg, SVC, '/api/v1/trades', {
    name: 'GET /api/v1/trades', module: MOD, user, params: filter,
    bizCheck: (r) => r.json('trades') !== undefined,
  });
}

export function createTrade(cfg, tradePart, datBin, datName, user) {
  const form = {
    trade: JSON.stringify(tradePart),
    datFile: http.file(datBin, datName, 'application/octet-stream'),
  };
  const res = client.postMultipart(cfg, SVC, '/api/v1/trades/create', form, {
    name: 'POST /api/v1/trades/create', module: MOD, user,
    bizCheck: (r) => r.json('tradeId') !== undefined,
  });
  bookingDuration.add(res.timings.duration);
  if (res.status < 200 || res.status >= 300) bookingErrors.add(1);
  return res;
}
