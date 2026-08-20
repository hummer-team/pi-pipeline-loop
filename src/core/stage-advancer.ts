/**
 * @module stage-advancer
 * Factory for the `stage_advance` tool.
 * Transitions the pipeline from the current stage to the next stage
 * defined in the project's PipelineConfig.
 *
 * Phase 0 (121_PipelineFlow): embeds a verification gate — when the current
 * stage has `verify.require=true`, the tool runs `runVerification` before
 * advancing. Also supports an optional `nextStage` parameter for conditional
 * branching (e.g. review → fix vs review → completed).
 */

import type { PipelineConfig, Tool, SessionMeta, PipelineStage, ExecFn } from "../types";
import { createPipelineUI } from "./pipeline-ui";
import { runVerification } from "./auto-verifier";
import { extractAssistantMessages, extractToolCallRecords } from "./session-state";
import { applyVerifyFail } from "./verify-advance";

/**
 * Dependencies injected into the stage advancer for verification execution.
 */
export interface StageAdvancerDeps {
  /** Dependency-injected shell execution function (replaces child_process.execSync) */
  execFn?: ExecFn;
}

/**
 * Creates the `stage_advance` tool.
 *
 * When invoked by the agent:
 * 1. Reads the current stage from SessionMeta.
 * 2. Determines the target stage (optional `nextStage` arg overrides config default).
 * 3. Validates the target stage exists and differs from the current stage.
 * 4. If the current stage requires verification (`verify.require=true`), runs
 *    `runVerification` first — advances only on success.
 * 5. Updates metadata and performs the UI stage transition.
 *
 * @param config - The pipeline configuration
 * @param deps - Optional dependencies (execFn for shell execution in verifiers)
 * @returns A Tool object for the "stage_advance" tool
 */
export function createStageAdvancer(config: PipelineConfig, deps?: StageAdvancerDeps): Tool {
  const ui = createPipelineUI(config);
  return {
    name: "stage_advance",
    description:
      "Advance the pipeline to the next stage. Reads the current stage from session metadata, " +
      "looks up the configured next stage, and updates the session state. " +
      "If the current stage has verification enabled, runs the verification gate first — " +
      "advances only when verification passes. " +
      "Optionally accepts a `nextStage` parameter to override the default transition target " +
      "(e.g. review → fix instead of review → completed). " +
      "Call this when the current stage's work is complete and validated.",
    parameters: {
      type: "object",
      properties: {
        nextStage: {
          type: "string",
          description:
            "Override the default next stage target. Must be a valid stage name " +
            "defined in the pipeline config and different from the current stage. " +
            "When omitted, uses the stage's configured nextStage.",
        },
      },
      required: [],
    },
    execute: async (args: Record<string, unknown>, ctx?: any): Promise<unknown> => {
      if (!ctx?.session) {
        return { error: "No session context available" };
      }

      const meta = ctx.session.getMeta() as SessionMeta;
      const currentStage: PipelineStage = meta.currentStage;

      // (a) Intercept completed stage
      if (currentStage === "completed") {
        return {
          success: false,
          message: "Pipeline is already completed",
          currentStage: "completed",
        };
      }

      const stageConfig = config.stages[currentStage];

      // (b) Determine target stage: explicit arg overrides static config
      const argNextStage = typeof args.nextStage === "string" ? args.nextStage.trim() : "";
      const resolvedTarget = (argNextStage ? (argNextStage as PipelineStage) : stageConfig.nextStage);

      // (c) Target legality validation
      if (resolvedTarget !== null && !(resolvedTarget in config.stages)) {
        return {
          success: false,
          message: `Invalid nextStage "${resolvedTarget}": not defined in pipeline config`,
          currentStage,
        };
      }
      if (resolvedTarget !== null && resolvedTarget === currentStage) {
        return {
          success: false,
          message: `Invalid nextStage "${resolvedTarget}": cannot advance to the same stage`,
          currentStage,
        };
      }

      // (d) Verification gate: run when stage requires it
      if (stageConfig.verify?.require) {
        const messages = extractAssistantMessages(ctx._ctx);
        // Extract tool call records for selfVerifySkip (same as agent-settled hook path)
        const toolCallRecords = extractToolCallRecords(ctx._ctx);
        const vr = await runVerification(config, meta, messages, { execFn: deps?.execFn, toolCallRecords });

        const verifyPassed = vr.rulePassed || vr.verifyResult?.overallPassed;
        if (!verifyPassed) {
          // Build shared result shape for applyVerifyFail
          const sharedResult = {
            structuredResult: vr.verifyResult?.structured,
            ruleMissing: vr.ruleMissing,
            verifyResult: vr.verifyResult,
          };
          const failResult = await applyVerifyFail(ctx, meta, currentStage, sharedResult, "tool", ui, config);
          return {
            success: false,
            message: failResult.message,
            failures: failResult.failures,
          };
        }
        // Verification passed — continue to advance
      }

      // (e) Advance to target stage
      ctx.session.updateMeta({
        ...meta,
        previousStage: currentStage,
        currentStage: resolvedTarget ?? "completed",
        stageStartTime: Date.now(),
        loopCount: 0,
        currentStepIndex: 0,
        verifyFailures: [],
      });

      if (resolvedTarget === null || resolvedTarget === "completed") {
        ui.clearStage(ctx);
        return {
          success: true,
          message: resolvedTarget === null
            ? "Pipeline completed — no further stages"
            : `Advanced from "${currentStage}" to "completed"`,
          currentStage: "completed",
        };
      }

      ui.transition(ctx, currentStage, resolvedTarget);

      return {
        success: true,
        message: `Advanced from "${currentStage}" to "${resolvedTarget}"`,
        previousStage: currentStage,
        currentStage: resolvedTarget,
      };
    },
  };
}
