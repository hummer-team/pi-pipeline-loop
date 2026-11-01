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
import { auditAutoDiagnostic, notifyAuto } from "./diagnostics";

export type ReleaseReason =
  | "user_quit"
  | "auto_completed"
  | "auto_failed"
  | "auto_stopped"
  /** 221 Phase 2: a HUMAN pipeline reached `completed` (shared release). */
  | "human_completed";

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
    auditAutoDiagnostic("release_authorization_failed", "Auto-job release: design-review authorization invalidation failed.", {
      reason: opts.reason,
      error: String(err),
    }, "error");
    notifyAuto(ctx, "Pipeline cleanup: design-review authorization could not be invalidated.", "warning");
  }

  try {
    await invalidateExecutorRunOnBoundary({ session: ctx.session, reason: opts.reason });
  } catch (err) {
    criticalFailed = true;
    failedSteps.push("invalidate_executor_binding");
    auditAutoDiagnostic("release_executor_failed", "Auto-job release: executor binding invalidation failed.", {
      reason: opts.reason,
      error: String(err),
    }, "error");
    notifyAuto(ctx, "Pipeline cleanup: executor binding could not be invalidated.", "warning");
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
    auditAutoDiagnostic("release_meta_clear_failed", "Auto-job release: session meta clear failed.", {
      reason: opts.reason,
      error: String(err),
    });
  }

  try {
    createPipelineUI(config).clearStage(ctx);
  } catch (err) {
    failedSteps.push("clear_stage");
    auditAutoDiagnostic("release_stage_bar_failed", "Auto-job release: stage bar clear failed.", {
      reason: opts.reason,
      error: String(err),
    });
  }

  return { criticalFailed, failedSteps };
}
