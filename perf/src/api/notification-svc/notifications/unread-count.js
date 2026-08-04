import * as client from '../../../lib/http.js';
import { classifyRead } from '../../../lib/errors.js';

const SVC = 'notification-svc';
const MOD = 'notifications';

/*
 * GET /api/v1/notifications/unread-count — first client for notification-svc (P0 list, 2026-08-03).
 * The unread count is per identity (X-User-Id); no request parameters, no data pool — identity
 * rotation is the data rotation.
 * Contract assumption is loose (response contains a data key); calibrate the real structure on
 * the first intranet run (env-checklist).
 */
export function getUnreadCount(cfg, user) {
  const { res, tags } = client.get(cfg, SVC, '/api/v1/notifications/unread-count', {
    name: 'GET /api/v1/notifications/unread-count', module: MOD, user,
  });
  return classifyRead(res, tags, (body) =>
    body && body.data !== undefined
      ? null
      : `response missing data — keys=${Object.keys(body || {}).slice(0, 8).join(',')}`
  );
}
