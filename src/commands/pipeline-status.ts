/**
 * @module pipeline-status
 * Factory for the `/pipeline-status` command.
 * Returns a formatted overview of the current pipeline state.
 */

import type { PipelineConfig, Command, SessionMeta } from "../types";
import { PROTECTED_PATHS } from "../constants";

/**
 * Creates the `/pipeline-status` command.
 *
 * Displays a comprehensive status overview including:
 * - Pipeline ID, current stage, model, domain
 * - Summary validation status
 * - Loop iteration count and step index
 * - Protected paths list
 *
 * @param config - The pipeline configuration
 * @returns A Command object for the "pipeline-status" slash command
 */
export function createPipelineStatusCommand(config: PipelineConfig): Command {
  return {
    name: "pipeline-status",
    description: "Show current pipeline status",
    execute: async (_args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      if (!ctx?.session) {
        return { error: "No session context available" };
      }

      const meta = ctx.session.getMetadata() as SessionMeta;
      const stageConfig = config.stages[meta.currentStage];
      const currentSummary = meta.summaries[meta.currentStage];

      const content =
        `# Pipeline Status\n` +
        `- ID: ${meta.pipelineId}\n` +
        `- Stage: ${meta.currentStage}\n` +
        `- Model: ${stageConfig.model || "default"}\n` +
        `- Domain: ${meta.domain.id}@${meta.domain.version}\n` +
        `- Summary Status: ${currentSummary?.status || "Missing"} (Path: ${currentSummary?.path || "N/A"})\n` +
        `- Loop: ${meta.loopCount}/${meta.maxLoops} (Step: ${meta.currentStepIndex})\n` +
        `- Protected: ${PROTECTED_PATHS.join(", ")}`;

      return { success: true, content };
    },
  };
}
