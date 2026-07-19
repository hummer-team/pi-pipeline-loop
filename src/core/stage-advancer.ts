/**
 * @module stage-advancer
 * Factory for the `stage_advance` tool.
 * Transitions the pipeline from the current stage to the next stage
 * defined in the project's PipelineConfig.
 */

import type { PipelineConfig, Tool, SessionMeta, PipelineStage } from "../types";

/**
 * Creates the `stage_advance` tool.
 *
 * When invoked by the agent, reads the current stage from SessionMeta,
 * looks up the configured next stage, updates the metadata, and returns
 * the new stage. If the next stage is null, the pipeline is marked as
 * "completed".
 *
 * @param config - The pipeline configuration
 * @returns A Tool object for the "stage_advance" tool
 */
export function createStageAdvancer(config: PipelineConfig): Tool {
  return {
    name: "stage_advance",
    description:
      "Advance the pipeline to the next stage. Reads the current stage from session metadata, " +
      "looks up the configured next stage, and updates the session state. " +
      "Call this when the current stage's work is complete and validated.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      if (!ctx?.session) {
        return { error: "No session context available" };
      }

      const meta = ctx.session.getMetadata() as SessionMeta;
      const currentStage: PipelineStage = meta.currentStage;

      if (currentStage === "completed") {
        return {
          success: false,
          message: "Pipeline is already completed",
          currentStage: "completed",
        };
      }

      const stageConfig = config.stages[currentStage];
      const nextStage = stageConfig.nextStage;

      ctx.session.updateMetadata({
        ...meta,
        previousStage: currentStage,
        currentStage: nextStage ?? "completed",
        stageStartTime: Date.now(),
        loopCount: 0,
        currentStepIndex: 0,
      });

      if (nextStage === null) {
        return {
          success: true,
          message: "Pipeline completed — no further stages",
          currentStage: "completed",
        };
      }

      return {
        success: true,
        message: `Advanced from "${currentStage}" to "${nextStage}"`,
        previousStage: currentStage,
        currentStage: nextStage,
      };
    },
  };
}
