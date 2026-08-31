/**
 * @module pipeline-handoff
 * Factory for the `pipeline_handoff` tool.
 * Handles stage transitions with validated summary context passing,
 * model switching, and audit logging.
 */

import type { PipelineConfig, Tool, SessionMeta, PipelineStage } from "../types";
import { writeAuditLog } from "../utils/auditLog";
import { createPipelineUI } from "../core/pipeline-ui";
import { freezeAndPrompt } from "../core/flow-state";
import { checkStageSummaryHash } from "../utils/summary-hash";
import { recordStageVisit } from "../utils/stage-visit";
import { toProjectRelative } from "../utils/path-display";
import { spawnStageSubagent } from "../utils/subagent-rpc";

/**
 * Creates the `pipeline_handoff` tool.
 *
 * Transitions the pipeline from the current stage to a specified next stage.
 * Enforces a critical precondition: the current stage's summary must have
 * `status === "valid"` before handoff is allowed.
 *
 * On successful handoff:
 * - Updates SessionMeta (previousStage, currentStage, resets loopCount/stepIndex)
 * - Passes the validated summary path as context for the next stage
 * - Switches the model to the next stage's configured model
 * - Writes a "handoff" audit log entry
 *
 * @param config - The pipeline configuration
 * @returns A Tool object for the "pipeline_handoff" tool
 */
export function createPipelineHandoff(config: PipelineConfig): Tool {
  const ui = createPipelineUI(config);
  return {
    name: "pipeline_handoff",
    description:
      "Handoff to the next pipeline stage. " +
      "Requires the current stage's summary to be validated (status=valid). " +
      "Switches model, resets loop counters, and passes summary context.",
    parameters: {
      type: "object",
      properties: {
        nextStage: {
          type: "string",
          description: "The pipeline stage to transition to",
        },
        note: {
          type: "string",
          description: "Optional handoff note",
        },
      },
      required: ["nextStage"],
    },
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      if (!ctx?.session) {
        return { error: "No session context available" };
      }

      const meta = ctx.session.getMeta() as SessionMeta;
      const currentStage = meta.currentStage;
      const nextStage = args.nextStage as PipelineStage;
      const note = (args.note as string) ?? "";

      // Precondition: current stage summary must be validated
      const currentSummary = meta.summaries[currentStage];
      if (!currentSummary || currentSummary.status !== "valid") {
        return {
          error:
            `Cannot handoff. Current stage summary is ` +
            `'${currentSummary?.status || "missing"}'. ` +
            `Please generate and validate summary first.`,
          help: "Run: generate_stage_summary, then validate_summary",
        };
      }

      // Phase 4 (143): Hash integrity check — detect manual summary modifications.
      // Check the current stage's summary (the one being passed as context for next stage).
      const currentHashCheck = checkStageSummaryHash(meta, currentStage);
      if (currentHashCheck && !currentHashCheck.match) {
        const mismatchedStage = currentHashCheck.stage;
        return {
          success: false,
          error:
            `Summary '${mismatchedStage}' has been modified manually (hash mismatch). ` +
            `Confirm to re-enter stage via stage_advance({ nextStage: "${mismatchedStage}" }).`,
          mismatchedStage,
        };
      }

      const nextStageConfig = config.stages[nextStage];
      if (!nextStageConfig) {
        return { error: `Unknown stage: "${nextStage}"` };
      }

      // Cycle detection: unified via recordStageVisit helper (DRY with stage-advancer,
      // routeConfirmReject, verify-advance). Preserves original handoff semantics.
      const maxCycles = meta.maxLoopCycles ?? config.maxLoopCycles ?? 3;
      const visitResult = recordStageVisit(meta, nextStage, maxCycles);

      if (!visitResult.ok) {
        // Max loop cycles reached — freeze pipeline and prompt for user decision
        ctx.session.updateMeta(visitResult.patch);
        await freezeAndPrompt(ctx, meta, "max_loop_cycles", config);

        return {
          error:
            `Max loop cycles (${maxCycles}) reached. ` +
            `Pipeline cannot cycle back to "${nextStage}". ` +
            `Pipeline frozen. Use the decision menu to continue.`,
        };
      }

      // Merge visit patch (loopCycleCount + stageVisitOrder) into updateMeta
      ctx.session.updateMeta(visitResult.patch);

      // Get updated metadata for the actual stage transition
      const updatedMeta = ctx.session.getMeta() as SessionMeta;

      // Update metadata: transition stage, reset counters, pass context
      // Pass only the delta (not a full snapshot) to avoid overwriting concurrent writes.
      const contextFiles = updatedMeta.contextFiles || {};
      ctx.session.updateMeta({
        previousStage: currentStage,
        currentStage: nextStage,
        stageStartTime: Date.now(),
        loopCount: 0,
        currentStepIndex: 0,
        contextFiles: {
          ...contextFiles,
          [nextStage]: [currentSummary.path],
        },
      });

      // NOTE: model management removed (Q4-A) — model is managed by user via /model command.

      // Write audit log
      await writeAuditLog("handoff", {
        pipelineId: meta.pipelineId,
        from: currentStage,
        to: nextStage,
        model: meta.currentModel?.modelId ?? "default",
        summaryHash: currentSummary.hash,
        note,
      });

      // TUI stage transition output
      if (nextStage === "completed") {
        ui.clearStage(ctx);
      } else {
        ui.transition(ctx, currentStage, nextStage);
      }

      // Phase 1 (169): Spawn subagent for the target stage after handoff
      if (nextStage !== "completed") {
        const freshMetaForSpawn = ctx.session.getMeta() as SessionMeta;
        await spawnStageSubagent(
          (ctx as { pi?: unknown }).pi,
          config,
          nextStage,
          freshMetaForSpawn,
          {
            ui: { notify: (msg: string) => { ui.notify(ctx, msg); } },
            session: ctx.session,
          },
        );
      }

      return {
        success: true,
        message: `Switched to "${nextStage}". Loaded summary: ${toProjectRelative(config.projectRoot, currentSummary.path)}`,
      };
    },
  };
}
