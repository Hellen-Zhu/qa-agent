/*
 * Trade update client — POST /api/v1/trades/{id}/update (maker identity, partial-field body).
 *
 * Contract calibrated against a real dev response (2026-08-05):
 *   → { code: 200, status: "PENDING APPROVAL",
 *       msg: "Submitted for checker approval. TaskId: CHK-...", data: { id, basic: {...} } }
 * The update re-enters the approval state machine (eventStatus=Amended), so every update
 * CONSUMES one LIVE trade id — the scenario feeds ids through the consumable pool's unique
 * cursor, never a reusable one (a second update on the same id is a state conflict, not load).
 *
 * Kept isolated from create's data graph (same init-graph discipline as query.js): this file
 * carries no case pool and no dat binaries.
 */
import * as client from '../../../lib/http.js';
import { classifyResponse, reasonFrom } from '../../../lib/errors.js';
import { extractTaskId } from '../checker-flow/tasks.js';

const SVC = 'worker-svc';
const MOD = 'trade';

// No known rejection-message patterns yet — attribution falls back to the server's code enum (code-N)
const REJECT_PATTERNS = [];

/**
 * payloadRow comes from data/worker-svc/trade/update-payload.json. Only whitelisted keys are
 * sent — the server rejects unknown fields, and the loader's bookkeeping key (__row) must
 * never leak into the request body.
 */
export function buildUpdatePayload(payloadRow) {
  return { basic: payloadRow.basic };
}

export function updateTrade(cfg, tradeId, payloadRow, user, runPhase) {
  const { res, tags } = client.postJson(cfg, SVC, `/api/v1/trades/${tradeId}/update`, buildUpdatePayload(payloadRow), {
    // Normalized name tag — unique tradeIds must never become tag values
    name: 'POST /api/v1/trades/{id}/update', module: MOD, user,
    tags: { runPhase: runPhase || 'main', row: String(payloadRow.__row || 0) },
  });
  const out = classifyResponse(res, tags, {
    business: (b) =>
      b.code !== 200 || b.status !== 'PENDING APPROVAL'
        ? {
            reason: reasonFrom(b, REJECT_PATTERNS),
            detail: `business: code=${b.code} status=${b.status} msg=${String(b.msg || '').slice(0, 160)}`,
          }
        : null,
    shape: (b) => {
      const id = b.data ? String(b.data.id || '') : '';
      return id === String(tradeId) ? null : `data.id echo mismatch — sent '${tradeId}', got '${id}'`;
    },
  });
  // The new approval task for this amendment — future consume-and-regenerate loops approve it
  // to bring the id back to LIVE (soak-scenario material, not used by the single-API measurement)
  out.taskId = out.body ? extractTaskId(out.body.msg) : null;
  return out;
}
