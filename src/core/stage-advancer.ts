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
import { runVerification, precheckRequiredFiles } from "./auto-verifier";
import { extractAssistantMessages, extractToolCallRecords } from "./session-state";
import { applyVerifyFail, maybeHandlePlanHumanGate } from "./verify-advance";
import { safeWriteStageAudit } from "../utils/auditLog";
import { findFirstMismatch, checkStageSummaryHash } from "../utils/summary-hash";

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
      "Supports `skipVerify: true` as an escape hatch for verification configuration errors " +
      "(EISDIR/empty path/directory/unresolved placeholder) — will be rejected when no " +
      "config-class error is present. " +
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
        skipVerify: {
          type: "boolean",
          description:
            "Skip the verification gate and advance directly. " +
            "Only allowed when the current verification failure is a config-class error " +
            "(EISDIR, empty path, directory path, or unresolved requirementDoc placeholder). " +
            "Will be rejected if no config-class error is detected.",
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

      // Phase 4 (143): Hash integrity check — if current stage has a summary
      // with a hash mismatch, block advance and prompt for re-entry.
      // Only check the current stage's summary (not all stages).
      if (meta.summaries[currentStage]) {
        const currentCheck = checkStageSummaryHash(meta, currentStage);
        if (currentCheck && !currentCheck.match) {
          const mismatchedStage = currentCheck.stage;
          return {
            success: false,
            message:
              `Summary '${mismatchedStage}' has been modified manually (hash mismatch). ` +
              `Cannot advance. Re-enter stage '${mismatchedStage}' to regenerate summary, ` +
              `or call stage_advance({ nextStage: "${mismatchedStage}" }) to confirm re-entry.`,
            mismatchedStage,
            hint: `stage_advance({ nextStage: "${mismatchedStage}" })`,
          };
        }
      }

      // (a) Intercept completed stage
      if (currentStage === "completed") {
        await safeWriteStageAudit(config, "stage_advance_failed", meta, {
          fromStage: "completed",
          reason: "already_completed",
        }, "warn");
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
        await safeWriteStageAudit(config, "stage_advance_failed", meta, {
          fromStage: currentStage,
          reason: "invalid_next_stage",
          target: String(resolvedTarget),
        }, "warn");
        return {
          success: false,
          message: `Invalid nextStage "${resolvedTarget}": not defined in pipeline config`,
          currentStage,
        };
      }
      if (resolvedTarget !== null && resolvedTarget === currentStage) {
        await safeWriteStageAudit(config, "stage_advance_failed", meta, {
          fromStage: currentStage,
          reason: "same_stage",
          target: String(resolvedTarget),
        }, "warn");
        return {
          success: false,
          message: `Invalid nextStage "${resolvedTarget}": cannot advance to the same stage`,
          currentStage,
        };
      }

      // (d) Verification gate: run when stage requires it (unless skipVerify is valid)
      const argSkipVerify = args.skipVerify === true;
      if (stageConfig.verify?.require && !argSkipVerify) {
        // P1: Pre-check required files before running full verification
        const precheck = await precheckRequiredFiles(config, meta);
        if (!precheck.passed) {
          // Required files not yet produced — return guidance without failure/freeze
          return {
            success: false,
            message: `Required deliverables not yet produced. Please create: ${precheck.missing.join(", ")}`,
            precheck: true,
            missing: precheck.missing,
          };
        }

        // Plan human-gate pre-check: if triggered, handles confirm dialog and returns
        // without entering normal verify flow (defensive coverage for tool path)
        const gateResult = await maybeHandlePlanHumanGate(config, ctx, meta, ui);
        if (gateResult.result === "handled") {
          if (gateResult.action === "advanced") {
            // User approved: stage has been advanced to develop inside the gate.
            return {
              success: true,
              message: "Plan human-gate approved. Stage advanced to develop.",
              currentStage: (ctx.session.getMeta() as SessionMeta).currentStage,
            };
          }
          // Pending / adjust / cancelled / write-failed: stage did NOT advance.
          // Return success:false to prevent caller from misreading the state as advanced.
          return {
            success: false,
            pending: true,
            message: "Plan stage awaiting human confirmation. Stage not advanced.",
            currentStage: (ctx.session.getMeta() as SessionMeta).currentStage,
          };
        }

        const messages = extractAssistantMessages(ctx._ctx);
        // Extract tool call records for selfVerifySkip (same as agent-settled hook path)
        const toolCallRecords = extractToolCallRecords(ctx._ctx);
        const vr = await runVerification(config, meta, messages, { execFn: deps?.execFn, toolCallRecords });

        // S1: Verification passes only on structured rules (rulePassed)
        const verifyPassed = vr.rulePassed;
        if (!verifyPassed) {
          // Audit verify-gate failure
          await safeWriteStageAudit(config, "stage_advance_failed", meta, {
            fromStage: currentStage,
            reason: "verify_failed",
          }, "warn");
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
      } else if (stageConfig.verify?.require && argSkipVerify) {
        // skipVerify=true: abuse guard — only allowed when config-class error present
        // Use persistent verifyConfigError marker (survives resume) instead of
        // checking verifyFailures which are cleared by resume decision.
        if (!meta.verifyConfigError) {
          await safeWriteStageAudit(config, "stage_advance_failed", meta, {
            fromStage: currentStage,
            reason: "skipVerify_rejected",
          }, "warn");
          return {
            success: false,
            message: "skipVerify is only allowed when a verification config-class error is detected (EISDIR/empty path/directory/unresolved requirementDoc placeholder)",
          };
        }
        // Config error confirmed — skip verification and proceed to advance
      }

      // (e) Advance to target stage
      // C2: Set advancedThisTurn flag to prevent agent_settled from triggering redundant verification
      // Pass only the delta (not a full snapshot) to avoid overwriting concurrent
      // writes from shared source during async operations (e.g., runVerification).
      ctx.session.updateMeta({
        previousStage: currentStage,
        currentStage: resolvedTarget ?? "completed",
        stageStartTime: Date.now(),
        loopCount: 0,
        currentStepIndex: 0,
        verifyFailures: [],
        verifyConfigError: undefined,
        violations: [],
        advancedThisTurn: true,
      });

      if (resolvedTarget === null || resolvedTarget === "completed") {
        ui.clearStage(ctx);
        // Write pipeline_completed terminal audit event
        await safeWriteStageAudit(config, "pipeline_completed", meta, {
          finalStage: currentStage,
          loopCycleCount: String(meta.loopCycleCount ?? 0),
          stageVisitOrder: (meta.stageVisitOrder ?? []).join(","),
        });
        return {
          success: true,
          message: resolvedTarget === null
            ? "Pipeline completed — no further stages"
            : `Advanced from "${currentStage}" to "completed"`,
          currentStage: "completed",
        };
      }

      // Success audit for non-terminal advance
      await safeWriteStageAudit(config, "stage_advance", meta, {
        fromStage: currentStage,
        toStage: resolvedTarget,
        override: argNextStage ? "yes" : "no",
      });

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
