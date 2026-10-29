/**
 * @module owner-wake-dedupe
 * 218 Phase 1 (T1.3, F.3-4 / D3): the single owner-wake entry shared by the
 * dispatch/freeze paths (enqueue wake, blocked-escalation wake, queue-block
 * wake, self-heal wake).
 *
 * The 20261028 incident woke the owner once PER HOOK on the same turn: three
 * independent wake callers each re-delivered the same "you need to dispatch"
 * summary. The dedupe key is `${pipelineId}:${stage}:${ownerTurnSeq}` — ONE
 * wake per owner turn per stage (D3). No time-window approximation: a window
 * would drop legitimate wakes between two quick turns AND re-wake inside one
 * long turn, both wrong. The turn counter (`SessionMeta.ownerTurnSeq`) is
 * incremented by the composition root after every owner `agent_settled`.
 *
 * Delivery order follows the 217 F2 contract (`owner-wake.ts:196-221`):
 * deliver FIRST, stamp `ownerWakeStamp` only AFTER success. A failed delivery
 * audits `owner_wake_undeliverable` (existing event name) and stays retryable
 * by the next hook.
 */

import type { SessionMeta } from "../types";
import { safeWriteAuditLog } from "../utils/auditLog";
import { shouldEmitWithinWindow } from "../utils/audit-throttle";
import { AUDIT_THROTTLE_WINDOW_MS } from "../constants";
import { deliverOwnerWake, type DeliveryOutcome } from "./owner-delivery";

export interface WakeOnceResult {
  outcome: DeliveryOutcome;
  /** True when an identical key was already stamped successfully this turn. */
  deduped: boolean;
}

/** Reason label travels into the dedupe audit so reviewers see WHO tried. */
export type OwnerWakeOnceReason =
  | "enqueue"
  | "blocked_escalation"
  | "queued_block"
  | "selfheal";

/** Minimal session surface needed for stamp read/write (mock-friendly). */
export interface WakeOnceSession {
  getMeta: () => SessionMeta | undefined;
  updateMeta: (patch: Partial<SessionMeta>) => unknown;
}

/**
 * 218 F.3-4: the single owner-wake entry for the three dispatch/freeze paths.
 * Dedupe key = `${pipelineId}:${stage}:${ownerTurnSeq}` — ONE wake per owner
 * turn per stage. A FAILED delivery does not stamp, so the next hook retries.
 *
 * @param session - Session handle owning the shared meta (owner or child —
 *   `updateMeta` writes the SHARED pipeline meta, so the stamp applies to
 *   every session bound to this pipeline).
 * @param meta - Meta snapshot used for the key; re-read fresh before stamping.
 * @param summary - Wake text delivered to the owner.
 * @param reason - Which wake path is calling (audit-visible).
 * @param fallback - Last-resort raw sender of the CALLING session (index.ts owns it).
 */
export function deliverOwnerWakeOnce(
  session: WakeOnceSession,
  meta: SessionMeta,
  summary: string,
  reason: OwnerWakeOnceReason,
  fallback?: () => boolean,
): WakeOnceResult {
  const key = `${meta.pipelineId ?? ""}:${meta.currentStage}:${meta.ownerTurnSeq ?? 0}`;

  // Read the stamp FRESH: another bound session may have delivered this turn
  // already (child route and owner hooks share the same meta).
  const fresh = session.getMeta() ?? meta;
  const stamp = fresh.ownerWakeStamp;
  if (stamp && stamp.key === key) {
    void safeWriteAuditLog("owner_wake_deduped", {
      pipelineId: fresh.pipelineId ?? "",
      stage: fresh.currentStage,
      reason,
      key,
    });
    return {
      outcome: { delivered: false, via: "none", reason: "deduped" },
      deduped: true,
    };
  }

  const outcome = deliverOwnerWake(summary, fresh, fallback ?? (() => false));

  if (!outcome.delivered) {
    // 217 F2: failed delivery leaves NO stamp — the next hook may retry.
    // Throttle mirrors the existing owner-wake writer so persistent
    // undeliverability cannot flood the audit.
    const throttleKey = `owner_wake_undeliverable:${fresh.pipelineId ?? ""}:${fresh.currentStage}`;
    if (shouldEmitWithinWindow(throttleKey, AUDIT_THROTTLE_WINDOW_MS)) {
      void safeWriteAuditLog("owner_wake_undeliverable", {
        pipelineId: fresh.pipelineId ?? "",
        stage: fresh.currentStage,
        reason: outcome.reason ?? "delivery_failed",
        via: outcome.via,
        wakePath: reason,
      });
    }
    return { outcome, deduped: false };
  }

  // Stamp AFTER the successful delivery (217 F2 contract).
  session.updateMeta({ ownerWakeStamp: { key, at: Date.now() } });
  return { outcome, deduped: false };
}
