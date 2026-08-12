/**
 * @module loop-checker
 * Factory for the `loop_check` tool.
 * Manages loop iteration counting and enforcement for the "develop"
 * and "fix" pipeline stages.
 */

import type { PipelineConfig, Tool, SessionMeta } from "../types";
import { createPipelineUI } from "./pipeline-ui";

/**
 * Creates the `loop_check` tool.
 *
 * Called by the agent after running tests in the develop or fix stage.
 * Accepts a test result ("pass" or "fail") and determines the next action:
 * - pass → signal to advance to the next stage
 * - fail (within limit) → increment loop count, signal retry
 * - fail (limit exceeded) → signal halt, pipeline freezes
 *
 * Only valid in "develop" and "fix" stages — returns an error otherwise.
 *
 * @param config - The pipeline configuration
 * @returns A Tool object for the "loop_check" tool
 */
export function createLoopChecker(config: PipelineConfig): Tool {
  const ui = createPipelineUI(config);
  return {
    name: "loop_check",
    description:
      "Check loop status for develop/fix stages. Call this after running tests. " +
      'Accepts result: "pass" or "fail". Returns the recommended action: ' +
      '"advance" (tests passed), "retry" (tests failed, within limit), ' +
      'or "halt" (max loops exceeded, pipeline frozen).',
    parameters: {
      type: "object",
      properties: {
        result: {
          type: "string",
          enum: ["pass", "fail"],
          description: 'Test result: "pass" or "fail"',
        },
        summary: {
          type: "string",
          description: "Brief summary of what was done in this iteration",
        },
      },
      required: ["result"],
    },
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      if (!ctx?.session) {
        return { error: "No session context available" };
      }

      const meta = ctx.session.getMeta() as SessionMeta;
      const currentStage = meta.currentStage;

      if (currentStage !== "develop" && currentStage !== "fix") {
        return {
          success: false,
          error: `loop_check is only valid in "develop" or "fix" stages, not "${currentStage}"`,
        };
      }

      const result = args.result as string;
      const summary = (args.summary as string) ?? "";

      if (result === "pass") {
        return {
          action: "advance",
          message: "Tests passed — ready to advance to next stage",
          loopCount: meta.loopCount,
          maxLoops: meta.maxLoops,
        };
      }

      const newLoopCount = meta.loopCount + 1;
      const maxLoops = meta.maxLoops;

      ctx.session.updateMeta({
        ...meta,
        loopCount: newLoopCount,
        currentStepIndex: meta.currentStepIndex + 1,
      });

      if (newLoopCount >= maxLoops) {
        ui.fail(ctx, currentStage, "max loops reached");
        return {
          action: "halt",
          message:
            `Max loop iterations (${maxLoops}) reached. Pipeline frozen. ` +
            `Review failures and adjust approach before resuming.`,
          loopCount: newLoopCount,
          maxLoops,
        };
      }

      return {
        action: "retry",
        message:
          `Test failed. Retry ${newLoopCount}/${maxLoops}. ` +
          `Fix the issues and run tests again.`,
        loopCount: newLoopCount,
        maxLoops,
        summary,
      };
    },
  };
}
