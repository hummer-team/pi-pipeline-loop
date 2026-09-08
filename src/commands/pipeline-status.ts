/**
 * @module pipeline-status
 * Factory for the `/pipeline-status` command.
 * Returns a formatted overview of the current pipeline state.
 */

import type { PipelineConfig, Command, SessionMeta, PipelineStage } from "../types";
import { PROTECTED_PATHS } from "../constants";
import { checkTemplateDrift } from "../utils/template-drift";
import { isDormant } from "../core/dormancy";

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

      const rawMeta: SessionMeta | undefined = ctx.session.getMeta();
      // Phase 2b (173) C3: dormant guard — dormant output
      if (!rawMeta || isDormant(rawMeta)) {
        return { success: true, content: "No active pipeline. Run /pipeline-start <doc>." };
      }
      const meta: SessionMeta = rawMeta;
      const stageConfig = config.stages[meta.currentStage as PipelineStage];
      const currentSummary = meta.summaries[meta.currentStage as PipelineStage];

      // Phase 6 (170): Check template drift and append to status output
      let driftLine = "- Template drift: 0 file(s)";
      try {
        const drifts = await checkTemplateDrift(config.projectRoot);
        if (drifts.length > 0) {
          const names = drifts.map(d => d.asset).join(", ");
          driftLine = `- Template drift: ${drifts.length} file(s) [${names}]`;
        }
      } catch {
        // Fail-open: drift check failure should not break status display
      }

      const content =
        `# Pipeline Status\n` +
        `- ID: ${meta.pipelineId}\n` +
        `- Stage: ${meta.currentStage}\n` +
        `- Model: ${meta.currentModel?.modelId || "default"}\n` +
        `- Domain: ${meta.domain.id}@${meta.domain.version}\n` +
        `- Summary Status: ${currentSummary?.status || "Missing"} (Path: ${currentSummary?.path || "N/A"})\n` +
        `- Loop: ${meta.loopCount}/${meta.maxLoops} (Step: ${meta.currentStepIndex})\n` +
        `- Protected: ${PROTECTED_PATHS.join(", ")}\n` +
        driftLine;

      return { success: true, content };
    },
  };
}
