/**
 * @module pipeline-quit
 * /pipeline-quit — exits the current pipeline and releases session-level resources.
 * Idempotent: no meta → error (no audit); already aborted → success (no repeat audit).
 */

import type { PipelineConfig, Command, SessionMeta } from "../types";
import { getFlowState, invalidateDesignReviewAuthorization } from "../core/flow-state";
import { createPipelineUI } from "../core/pipeline-ui";
import { safeWriteAuditLog, setAuditPipelineContext } from "../utils/auditLog";
// 194 Phase 3 (task 7, review issue 3): quit invalidates a stale executor binding
import { invalidateExecutorRunOnBoundary } from "../core/stage-executor/recovery";

export function createPipelineQuitCommand(config: PipelineConfig): Command {
  return {
    name: "pipeline-quit",
    description: "Exit the current pipeline and release its resources",
    execute: async (_args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      // No session context or no meta → pipeline never started
      const meta: SessionMeta | undefined = ctx?.session?.getMeta?.();
      if (!meta?.currentStage || !meta.pipelineId) {
        return { success: false, error: "No active pipeline" };
      }

      const flowState = getFlowState(meta);

      // Already exited → idempotent return, no repeat audit
      if (flowState === "aborted") {
        return { success: true, message: "Pipeline already exited" };
      }

      // Capture pre-update state for audit
      const fromState = flowState;
      const stage = meta.currentStage;
      const pipelineId = meta.pipelineId;

      // Phase 4 (191): invalidate design-review authorization on quit
      // Ensures stale authorization does not persist across pipeline runs
      await invalidateDesignReviewAuthorization(ctx, "user_quit");

      // 194 Phase 3 (task 7, review issue 3): quitting is a pipeline boundary —
      // a stale executor run must not survive into whatever starts next. Same
      // controlled strict-commit pattern as the authorization clear above; an
      // invalidation that cannot be committed is audited honestly by the
      // helper and never re-attempted by silently keeping the binding.
      await invalidateExecutorRunOnBoundary({ session: ctx.session, reason: "user_quit" });

      // Release session-level resources (preserve pipelineId/currentStage/summaries/domain/requirementDoc)
      ctx.session.updateMeta({
        flowState: "aborted",
        terminateReason: "user_quit",
        blockedReason: undefined,
        sessionAllowedCommands: [],
        verifyAttempts: 0,
        verifyFailures: [],
        sessionAllowedWritePaths: [],
        // 216 P3: quitting is a pipeline boundary — the refusal counter must
        // not leak into whatever pipeline starts next.
        stageExitRefusal: undefined,
      });

      // Phase 1 (197): set audit routing context before writing audit
      setAuditPipelineContext(pipelineId);

      // Audit the quit event (must happen before clearing audit context)
      // Pass pipelineId as 4th parameter to ensure correct routing
      await safeWriteAuditLog("pipeline_quit", {
        pipelineId,
        stage,
        from: fromState,
      }, undefined, pipelineId);

      // Phase 1 (197): clear audit routing context after terminal state
      setAuditPipelineContext(null);

      // Clear TUI stage status bar
      const ui = createPipelineUI(config);
      ui.clearStage(ctx);

      return {
        success: true,
        message: `Pipeline exited at stage "${stage}". Use /pipeline-start to begin a new run.`,
      };
    },
  };
}
