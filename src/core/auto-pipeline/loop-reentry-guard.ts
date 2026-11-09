/**
 * @module auto-pipeline/loop-reentry-guard
 * the exhausted-loop re-entry BAN.
 *
 * Once a loop reason has been recorded in `meta.exhaustedLoops`, re-entering
 * that loop (design-review dispatch, review entry) is frozen with
 * `loop_reentry_blocked` until an explicit `reset_loop_budget` clears the
 * entry — without it, an exhausted loop would re-open silently by simply
 * re-running the budgeted"/counted" dispatcher.
 */

import type { PipelineConfig, SessionMeta } from "../../types";
import { freezeAndPrompt, type FlowStateCtx } from "../flow-state";
import { safeWriteAuditLog } from "../../utils/auditLog";

/** Which loop a stage belongs to (for the re-entry ban). */
export function loopBinding(config: PipelineConfig, meta: SessionMeta, stage: string): "reviewFix" | "designReview" | null {
  void config;
  if (meta.reviewLedger?.loop === "reviewFix" && (stage === "review" || stage === "fix")) {
    return "reviewFix";
  }
  if (meta.designReview !== undefined && stage === "design-review") {
    return "designReview";
  }
  return null;
}

/**
 * TRUE when the loop's exhausted record still bans re-entry. Callers MUST
 * freeze (the helper does it) and stop.
 */
export function isLoopReentryBlocked(meta: SessionMeta, loop: string): boolean {
  return (meta.exhaustedLoops ?? []).some((e) => e.loop === loop);
}

/**
 * Freeze-on-re-entry (audits `loop_reentry_blocked`). Returns true when the
 * freeze was performed (the caller then aborts its own flow immediately).
 */
export async function guardLoopReentry(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  config: PipelineConfig,
  loop: string,
): Promise<boolean> {
  if (!isLoopReentryBlocked(meta, loop)) return false;
  await safeWriteAuditLog("loop_reentry_blocked", {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    loop,
  }, "warn");
  if (meta.flowState !== "blocked") {
    await freezeAndPrompt(ctx, meta, `loop_reentry_blocked(${loop})`, config);
  }
  return true;
}
