/**
 * @module pipeline-resume
 * Factory for the `/pipeline-resume` command.
 * Provides a deterministic recovery path for frozen pipelines without
 * requiring the TUI decision menu (Phase 5 / 172 G6b).
 *
 * Behavior matrix:
 * - No meta → error message
 * - Not frozen → read-only status hint (no state change)
 * - Aborted → points to /pipeline-start (no menu available)
 * - Blocked/awaiting_human → executeDecision("resume") + stage dispatch
 */

import type { PipelineConfig, Command, SessionMeta } from "../types";
import { isFrozen, getFlowState, executeDecision, formatFrozenReason, formatAbortedNotifyText } from "../core/flow-state";
import { dispatchAfterResume } from "./pipeline-start";
import { createPipelineUI } from "../core/pipeline-ui";
import { safeWriteAuditLog } from "../utils/auditLog";
import { probeAgentState } from "../utils/subagents-introspect";
import { isSpawnableStage } from "../utils/subagent-rpc";

/**
 * Creates the `/pipeline-resume` command.
 *
 * @param config - The pipeline configuration
 * @returns A Command object for the "pipeline-resume" slash command
 */
export function createPipelineResumeCommand(config: PipelineConfig): Command {
  const ui = createPipelineUI(config);

  return {
    name: "pipeline-resume",
    description: "Resume a frozen pipeline in this session",
    execute: async (_args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      if (!ctx?.session) {
        return { error: "No session context available" };
      }

      const meta = ctx.session.getMeta() as SessionMeta | undefined;
      if (!meta || !meta.pipelineId) {
        return { error: "No active pipeline. Run /pipeline-start <doc_file> to begin." };
      }

      const flowState = getFlowState(meta);

      // Aborted: no decision menu available — redirect to /pipeline-start
      if (flowState === "aborted") {
        const abortMsg = formatAbortedNotifyText(
          meta.currentStage,
          meta.terminateReason ?? "session_quit",
          meta.requirementDoc,
        );
        ui.notify(ctx, `${abortMsg} Use /pipeline-start to begin a new run.`);
        return { message: abortMsg };
      }

      // Not frozen: read-only status hint (no state change)
      if (!isFrozen(meta)) {
        const statusMsg = `Pipeline is running (pipelineId: ${meta.pipelineId}, stage: ${meta.currentStage}, flowState: ${flowState}). No resume needed.`;
        ui.notify(ctx, statusMsg);
        return { message: statusMsg };
      }

      // Blocked or awaiting_human: execute resume decision
      try {
        const result = await executeDecision(ctx, meta, "resume", config);

        if (!result.success) {
          return { error: `Resume failed: ${result.message}` };
        }

        // Audit the decision with source=command
        await safeWriteAuditLog("pipeline_decision", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          decision: "resume",
          source: "command",
        });

        ui.notify(ctx, `Pipeline resumed at stage "${meta.currentStage}". ${result.message}`);

        // Stage-aware dispatch: re-spawn the stage subagent if not already live
        const freshMeta = ctx.session.getMeta() as SessionMeta;
        const stage = freshMeta.currentStage;

        if (isSpawnableStage(config, stage)) {
          // Check if there's already a live agent for this stage
          const activeSpawns = freshMeta.activeSpawns ?? {};
          const existingSpawn = activeSpawns[stage];
          let shouldSpawn = true;

          if (existingSpawn?.agentId || existingSpawn?.agentName) {
            try {
              const probe = probeAgentState(existingSpawn.agentId ?? existingSpawn.agentName!);
              if (probe === "live") {
                shouldSpawn = false;
                ui.notify(ctx, `Agent "${existingSpawn.agentName}" is already running for stage "${stage}". Skipping duplicate spawn.`);
              }
            } catch {
              // Probe failure → fail-open, proceed with spawn
            }
          }

          if (shouldSpawn) {
            const doc = freshMeta.requirementDoc ?? "";
            await dispatchAfterResume(ctx, config, ui, freshMeta, doc);
          }
        }

        return { message: result.message };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await safeWriteAuditLog("pipeline_resume_error", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          error: errMsg,
        }, "error");
        return { error: `Resume error: ${errMsg}` };
      }
    },
  };
}
