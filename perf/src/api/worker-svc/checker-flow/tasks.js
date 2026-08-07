/*
 * Checker-flow client — single-task approve / reject. Both are P0 measurement targets, and
 * approve doubles as the seed pipeline's second stage (create → approve → LIVE pool).
 *
 * Contract calibrated against a real dev response (2026-08-05):
 *   POST /api/v1/checker/tasks/{taskId}/approve — checker identity, EMPTY JSON body (-d '')
 *   → { code: 200, status: "SUCCESS", msg: "", data: { id: "TRD-...", basic: {...} } }
 * reject is implemented symmetrically but NOT yet calibrated (env-checklist item — it may
 * require a reason payload).
 *
 * Error semantics measured 2026-08-06 (both bodies are error/message/timestamp, NOT the standard
 * envelope — they classify as technical with the reason carrying the status code):
 *   http-403 = permission ("does not have CHECKER permission for product=... event=...") — an
 *     identity-pool configuration problem, not a performance signal; note permission is
 *     PER-PRODUCT, so checker accounts must cover every productType in the case pool.
 *   http-400 = state conflict ("Task ... is not PENDING (current: APPROVED)") — the write-path
 *     analog of the read pools' http-404: a consumed/stale pool, re-seed first. The consumable
 *     pool's exactly-once cursor exists precisely so a run never self-inflicts these.
 * (The earlier 409-for-permission assumption is dead; 409 has not been observed on this system.)
 */
import * as client from '../../../lib/http.js';
import { classifyResponse, reasonFrom } from '../../../lib/errors.js';

const SVC = 'worker-svc';
const MOD = 'checker-flow';

/*
 * TaskId travels in the trade-write responses' msg field
 * ("Submitted for checker approval. TaskId: CHK-F87F2124") — approving by this id directly
 * removes the pending-list tradeId→taskId mapping step entirely (2026-08-05 discovery, spec §11).
 */
export function extractTaskId(msg) {
  const m = String(msg || '').match(/TaskId:\s*(CHK-[A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// No known rejection-message patterns yet — attribution falls back to the server's code enum (code-N)
const REJECT_PATTERNS = [];

function taskAction(cfg, action, taskId, user, runPhase) {
  const { res, tags } = client.postEmpty(cfg, SVC, `/api/v1/checker/tasks/${taskId}/${action}`, {
    // Normalized name tag — the raw URL carries a unique taskId and must never become a tag value
    name: `POST /api/v1/checker/tasks/{taskId}/${action}`, module: MOD, user,
    tags: { runPhase: runPhase || 'main' },
  });
  return classifyResponse(res, tags, {
    business: (b) =>
      b.code !== 200 || b.status !== 'SUCCESS'
        ? {
            reason: reasonFrom(b, REJECT_PATTERNS),
            detail: `business: code=${b.code} status=${b.status} msg=${String(b.msg || '').slice(0, 160)}`,
          }
        : null,
    shape: (b) => {
      const id = b.data ? String(b.data.id || '') : '';
      return /^TRD-[A-Za-z0-9]+$/.test(id) ? null : `data.id echo missing/unexpected — '${id}'`;
    },
  });
}

export function approveTask(cfg, taskId, user, runPhase) {
  return taskAction(cfg, 'approve', taskId, user, runPhase);
}

export function rejectTask(cfg, taskId, user, runPhase) {
  return taskAction(cfg, 'reject', taskId, user, runPhase);
}
