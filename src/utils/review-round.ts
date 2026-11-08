/**
 * @module review-round
 * 225 Phase 2 (T2/Q3-A→D3): the persistent review ROUND ledger.
 *
 * Layer-neutral (utils): only touches meta shapes and the audit logger.
 * Rules, in priority order (the fix path of the original incident — "round 2
 * still patched `_1.md`" — comes from losing the round number between
 * dispatches):
 *
 * 1. No state / foreign pipeline → allocate round 1 for the CURRENT visit.
 * 2. `reviewRound.stageStartTime === meta.stageStartTime` → reuse the round
 *    verbatim. This covers retries AND the decision-menu / strategy-unfreeze
 *    resume: that path does NOT rebase `stageStartTime` (verified fact table),
 *    so an identical clock means the same visit.
 * 3. `meta.periodResumedAt` present AND the recorded round predates it → the
 *    `/pipeline-start` resume rebased `stageStartTime` to "now" — this is the
 *    SAME round continuing: keep `index` and `enteredAt` (freshness baseline),
 *    only re-point `stageStartTime` to the current visit clock.
 * 4. Anything else (a genuinely new review visit) → advance to `index + 1`
 *    with a fresh `enteredAt`.
 *
 * 227 review fix (issue 1): an EXPLICIT re-entry (`stage_advance({reenter:true})`)
 * is always a new visit: it forces rule 4 regardless of rules 2/3. Otherwise a
 * `/pipeline-start` resumed period (`periodResumedAt` + re-pointed clock, rule 3)
 * would keep both `index` and `enteredAt`, letting a PASS report written BEFORE
 * the re-entry still satisfy the freshness baseline (`mtime >= enteredAt`) and
 * pass completion-gate evidence ①.
 */

import type { ReviewRoundState, SessionMeta } from "../types";
import { safeWriteAuditLog } from "./auditLog";

/**
 * Why a round is being allocated:
 * - `dispatch` (default): a normal review dispatch — the resume/retry continuity
 *   rules 2/3 apply, so the same visit keeps its round and freshness baseline.
 * - `reenter`: an explicit same-stage re-entry — ALWAYS a new round, so every
 *   artifact written before the re-entry is stale by construction.
 */
export type ReviewRoundAllocationReason = "dispatch" | "reenter";

/**
 * Pure round allocation against the CURRENT meta. Never mutates anything.
 */
export function allocateReviewRound(
  meta: SessionMeta,
  now: number,
  reason: ReviewRoundAllocationReason = "dispatch",
): ReviewRoundState {
  const previous = meta.reviewRound;
  if (!previous || previous.pipelineId !== meta.pipelineId) {
    return { index: 1, stageStartTime: meta.stageStartTime, enteredAt: now, pipelineId: meta.pipelineId };
  }
  if (reason === "reenter") {
    // Explicit re-entry: skip the continuity rules (2/3) on purpose. The new
    // `enteredAt` is the re-entry clock, so any report written before it fails
    // the freshness check, and the advanced `index` points at a new file name.
    return {
      index: previous.index + 1,
      stageStartTime: meta.stageStartTime,
      enteredAt: now,
      pipelineId: meta.pipelineId,
    };
  }
  if (previous.stageStartTime === meta.stageStartTime) {
    return previous; // same visit identity: retry / non-rebase resume
  }
  if (
    meta.periodResumedAt !== undefined &&
    previous.stageStartTime <= meta.periodResumedAt
  ) {
    // /pipeline-start resume rebased stageStartTime AND stamped the marker:
    // same round continues, freshness baseline (enteredAt) preserved.
    return { ...previous, stageStartTime: meta.stageStartTime };
  }
  return {
    index: previous.index + 1,
    stageStartTime: meta.stageStartTime,
    enteredAt: now,
    pipelineId: meta.pipelineId,
  };
}

/**
 * Allocates (or reuses) the round and persists it ONLY when it changed
 * (`review_round_allocated` audit with index / isNew / stageStartTime).
 * `isNew` = "this allocation born a NEW round index" — true for the first
 * allocation AND for every index advance (rule 4); false for same-index
 * continuations (resume re-pointing, rule 3). Retries audit nothing.
 * Safe to call on every review dispatch.
 */
export function ensureReviewRound(
  meta: SessionMeta,
  session: { updateMeta(patch: Partial<SessionMeta>): unknown } | undefined,
  now: number,
  reason: ReviewRoundAllocationReason = "dispatch",
): ReviewRoundState {
  const next = allocateReviewRound(meta, now, reason);
  const previous = meta.reviewRound;
  const changed =
    !previous ||
    previous.index !== next.index ||
    previous.stageStartTime !== next.stageStartTime ||
    previous.enteredAt !== next.enteredAt ||
    previous.pipelineId !== next.pipelineId;
  if (changed) {
    if (session) {
      session.updateMeta({ reviewRound: next });
    }
    void safeWriteAuditLog("review_round_allocated", {
      pipelineId: meta.pipelineId,
      stage: "review",
      index: String(next.index),
      isNew: String(!previous || previous.index !== next.index),
      stageStartTime: String(next.stageStartTime),
    });
  }
  return next;
}
