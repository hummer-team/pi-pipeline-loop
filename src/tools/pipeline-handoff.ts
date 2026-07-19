/**
 * @module pipeline-handoff
 * Factory for the `pipeline_handoff` tool.
 * Handles stage transitions with validated summary context passing,
 * model switching, and audit logging.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig, Tool, SessionMeta, PipelineStage } from "../types";

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

      const meta = ctx.session.getMetadata() as SessionMeta;
      const currentStage = meta.currentStage;
      const nextStage = args.nextStage as PipelineStage;
      const note = (args.note as string) ?? "";
      const projectRoot = config.projectRoot;
      const auditDir = config.auditDir || ".pi/audit";

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

      const nextStageConfig = config.stages[nextStage];
      if (!nextStageConfig) {
        return { error: `Unknown stage: "${nextStage}"` };
      }

      // Update metadata: transition stage, reset counters, pass context
      const contextFiles = meta.contextFiles || {};
      ctx.session.updateMetadata({
        ...meta,
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

      // Switch model for the next stage
      if (nextStageConfig.model) {
        await ctx.session.setModel(nextStageConfig.model);
      }

      // Write audit log
      const auditLog = {
        timestamp: new Date().toISOString(),
        pipelineId: meta.pipelineId,
        action: "handoff",
        from: currentStage,
        to: nextStage,
        model: nextStageConfig.model || null,
        summaryHash: currentSummary.hash,
        note,
      };
      const auditLogPath = path.join(projectRoot, auditDir, "audit.log");
      await fs.mkdir(path.dirname(auditLogPath), { recursive: true });
      await fs.appendFile(auditLogPath, JSON.stringify(auditLog) + "\n");

      return {
        success: true,
        message: `Switched to "${nextStage}". Loaded summary: ${currentSummary.path}`,
      };
    },
  };
}
