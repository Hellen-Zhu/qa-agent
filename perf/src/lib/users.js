// Identity pool: the system has no token auth; a uniform X-User-Id header is used. Round-robin by VU guarantees multi-identity distribution while staying stable within a VU.
export function pickUser(cfg, role, vu) {
  const pool = (cfg.users || {})[role];
  if (!pool || pool.length === 0) throw new Error(`no users for role: ${role}`);
  return pool[Math.abs(vu) % pool.length];
}
