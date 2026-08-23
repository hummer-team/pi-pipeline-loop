/**
 * @module pipeline-quit
 * /pipeline-quit — exits the current pipeline and releases session-level resources.
 * Idempotent: no meta → error (no audit); already aborted → success (no repeat audit).
 */

import type { PipelineConfig, Command, SessionMeta } from "../types";
import { getFlowState } from "../core/flow-state";
import { createPipelineUI } from "../core/pipeline-ui";
import { safeWriteAuditLog } from "../utils/auditLog";

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

      // Release session-level resources (preserve pipelineId/currentStage/summaries/domain/requirementDoc)
      ctx.session.updateMeta({
        flowState: "aborted",
        terminateReason: "user_quit",
        blockedReason: undefined,
        sessionAllowedCommands: [],
        verifyAttempts: 0,
        verifyFailures: [],
        sessionAllowedWritePaths: [],
      });

      // Audit the quit event
      await safeWriteAuditLog("pipeline_quit", {
        pipelineId,
        stage,
        from: fromState,
      });

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
