import { cfg, buildOptions } from '../lib/bootstrap.js';
import { pickUser } from '../lib/users.js';
import { getUnreadCount } from '../api/notification-svc/notifications/unread-count.js';

// P0 · notification-svc/notifications · 读路径（未读数；无参数无数据池，身份轮换即数据轮换）

export const options = buildOptions('notification-svc/notifications', 'unreadCount');

export default function () {
  getUnreadCount(cfg, pickUser(cfg, 'maker', __VU));
}

export { stdHandleSummary as handleSummary } from '../lib/bootstrap.js';
