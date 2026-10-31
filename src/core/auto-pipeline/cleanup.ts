/**
 * @module auto-pipeline/cleanup
 * 219 Phase 5: the shared session-resource release.
 *
 * Extracted VERBATIM in behaviour from `/pipeline-quit`'s cleanup block so the
 * human quit path and every auto-journal termination share ONE implementation
 * (219_Feat.md 6.5 decision 8: a failed job must clean up exactly like a quit).
 *
 * Facts:
 * - Never writes `flowState` / `terminateReason` — the terminal attribution
 *   belongs to the caller (quit → aborted, auto → completed/failed).
 * - Critical steps (design-review authorisation invalidation, executor binding
 *   invalidation) report `criticalFailed: true`; the caller decides whether
 *   that changes the outcome.
 * - Non-critical steps only warn + land in `failedSteps` (release never throws).
 */

import type { PipelineConfig } from "../../types";
import type { RuntimeCtx } from "../runtime-ctx";
import { invalidateDesignReviewAuthorization } from "../flow-state";
import { invalidateExecutorRunOnBoundary } from "../stage-executor/recovery";
import { createPipelineUI } from "../pipeline-ui";

export type ReleaseReason = "user_quit" | "auto_completed" | "auto_failed" | "auto_stopped";

export interface ReleaseResult {
  criticalFailed: boolean;
  failedSteps: string[];
}

/**
 * Release the session-level resources a pipeline accumulates:
 * authorisation + executor binding + per-session allowlists + verify counters
 * + refusal/approval gates + the TUI stage bar.
 */
export async function releaseSessionResources(
  ctx: RuntimeCtx,
  config: PipelineConfig,
  opts: { reason: ReleaseReason },
): Promise<ReleaseResult> {
  const failedSteps: string[] = [];
  let criticalFailed = false;

  try {
    await invalidateDesignReviewAuthorization(ctx, opts.reason);
  } catch (err) {
    criticalFailed = true;
    failedSteps.push("invalidate_design_review_authorization");
    console.error(`[auto-pipeline] releaseSessionResources: authorization invalidation failed: ${String(err)}`);
  }

  try {
    await invalidateExecutorRunOnBoundary({ session: ctx.session, reason: opts.reason });
  } catch (err) {
    criticalFailed = true;
    failedSteps.push("invalidate_executor_binding");
    console.error(`[auto-pipeline] releaseSessionResources: executor invalidation failed: ${String(err)}`);
  }

  try {
    ctx.session.updateMeta({
      sessionAllowedCommands: [],
      sessionAllowedWritePaths: [],
      verifyAttempts: 0,
      verifyFailures: [],
      stageExitRefusal: undefined,
      pendingOwnerApprovals: undefined,
      blockedReason: undefined,
    });
  } catch (err) {
    failedSteps.push("clear_session_fields");
    console.warn(`[auto-pipeline] releaseSessionResources: meta clear failed: ${String(err)}`);
  }

  try {
    createPipelineUI(config).clearStage(ctx);
  } catch (err) {
    failedSteps.push("clear_stage");
    console.warn(`[auto-pipeline] releaseSessionResources: stage bar clear failed: ${String(err)}`);
  }

  return { criticalFailed, failedSteps };
}
