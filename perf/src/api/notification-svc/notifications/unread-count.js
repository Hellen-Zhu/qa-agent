import * as client from '../../../lib/http.js';
import { classifyRead } from '../../../lib/errors.js';

const SVC = 'notification-svc';
const MOD = 'notifications';

/*
 * GET /api/v1/notifications/unread-count——notification-svc 首个客户端（P0 清单，2026-08-03）。
 * 未读数按身份（X-User-Id）计，无请求参数、无数据池——身份轮换即数据轮换。
 * 契约假设宽松（响应含 data 键），真实结构内网首跑校准（env-checklist）。
 */
export function getUnreadCount(cfg, user) {
  const { res, tags } = client.get(cfg, SVC, '/api/v1/notifications/unread-count', {
    name: 'GET /api/v1/notifications/unread-count', module: MOD, user,
  });
  return classifyRead(res, tags, (body) =>
    body && body.data !== undefined
      ? null
      : `响应缺少 data — keys=${Object.keys(body || {}).slice(0, 8).join(',')}`
  );
}
