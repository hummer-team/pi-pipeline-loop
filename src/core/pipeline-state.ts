/**
 * @module pipeline-state
 * Factory for the `pipeline_state` tool.
 * Returns the full current pipeline state for agent visibility.
 */

import type { PipelineConfig, Tool, SessionMeta } from "../types";
import { buildStageSequence } from "../utils/stage-sequence";

/**
 * Creates the `pipeline_state` tool.
 *
 * Returns the complete pipeline state including current stage,
 * domain, loop count, stage configuration summary, and summary artifacts.
 * Useful for the agent to understand its position in the pipeline.
 *
 * @param config - The pipeline configuration
 * @returns A Tool object for the "pipeline_state" tool
 */
export function createPipelineState(config: PipelineConfig): Tool {
  return {
    name: "pipeline_state",
    description:
      "Get the current pipeline state: stage, domain, loop count, " +
      "stage transitions, and summary status.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    execute: async (_args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      if (!ctx?.session) {
        return { error: "No session context available" };
      }

      const meta = ctx.session.getMeta() as SessionMeta;
      const currentStage = meta.currentStage;
      const stageConfig = config.stages[currentStage];
      const nextStage = stageConfig.nextStage;

      const stageSequence = buildStageSequence(config, meta.currentStage);

      return {
        pipelineId: meta.pipelineId,
        stage: {
          current: currentStage,
          previous: meta.previousStage ?? null,
          next: nextStage,
          sequence: stageSequence,
        },
        domain: {
          id: meta.domain.id,
          version: meta.domain.version,
        },
        loop: {
          count: meta.loopCount,
          stepIndex: meta.currentStepIndex,
          maxLoops: meta.maxLoops,
        },
        summaries: meta.summaries,
        stageStartTime: new Date(meta.stageStartTime).toISOString(),
      };
    },
  };
}
