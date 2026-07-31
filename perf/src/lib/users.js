// 身份池：系统无 token 认证，统一 X-User-Id 头。按 VU 轮询保证多身份分布且同 VU 稳定。
export function pickUser(cfg, role, vu) {
  const pool = (cfg.users || {})[role];
  if (!pool || pool.length === 0) throw new Error(`no users for role: ${role}`);
  return pool[Math.abs(vu) % pool.length];
}
