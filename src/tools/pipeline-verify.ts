/**
 * @module pipeline-verify
 * Factory for the `pipeline_verify` tool.
 * Provides agent-triggered verification for stages configured with verify.mode = "tool".
 * Reads verify.md, runs structured rules + optional LLM verification, and auto-advances on success.
 */

import type { PipelineConfig, Tool, SessionMeta, PipelineStage, ExecFn } from "../types";
import { runVerification, precheckRequiredFiles } from "../core/auto-verifier";
import type { RunVerificationOptions } from "../core/auto-verifier";
import { applyVerifyPass, applyVerifyFail } from "../core/verify-advance";
import { createPipelineUI } from "../core/pipeline-ui";
import { extractAssistantMessages } from "../core/session-state";
import { safeWriteAuditLog } from "../utils/auditLog";
import { PLAN_CONFIRM_MARKER_RULE, shouldDeferPlanMarkerRule } from "../core/stage-advancer";

/**
 * Options injected into the pipeline_verify tool via closure.
 */
export interface PipelineVerifyDeps {
  /** Injected shell execution function (replaces child_process.execSync) */
  execFn?: ExecFn;
}

/**
 * Creates the `pipeline_verify` tool.
 *
 * This tool allows the agent to explicitly trigger verification for a stage,
 * used when verify.mode = "tool" (as opposed to automatic hook-based verification).
 *
 * On success: auto-advances to the next stage (same logic as agent-settled hook).
 * On failure: writes verifyFailures to SessionMeta for prompt injection feedback.
 *
 * @param config - The pipeline configuration
 * @param deps - Injected dependencies (execFn)
 * @returns A Tool object for the "pipeline_verify" tool
 */
export function createPipelineVerify(
  config: PipelineConfig,
  deps?: PipelineVerifyDeps,
): Tool {
  const ui = createPipelineUI(config);
  return {
    name: "pipeline_verify",
    description:
      "Run verification for the current (or specified) pipeline stage. " +
      "Checks structured rules from verify.md and optionally runs LLM verification. " +
      "On success, auto-advances to the next stage. On failure, records verifyFailures " +
      "for the agent to fix.",
    parameters: {
      type: "object",
      properties: {
        stage: {
          type: "string",
          description:
            "The stage to verify (default: current stage from session metadata)",
        },
        verifyFile: {
          type: "string",
          description:
            "Override path to verify.md file (default: from stage config)",
        },
      },
      required: [],
    },
    execute: async (args: Record<string, unknown>, ctx?: unknown): Promise<unknown> => {
      if (!ctx || typeof ctx !== "object") {
        return { error: "No session context available" };
      }

      const sessionCtx = ctx as {
        session: {
          getMeta: () => SessionMeta | undefined;
          updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
        };
        ui?: { notify: (msg: string) => void };
        /** @internal Original ExtensionContext for standalone functions */
        _ctx: { sessionManager: { getBranch(): any[] } };
      };

      if (!sessionCtx.session) {
        return { error: "No session context available" };
      }

      const meta = sessionCtx.session.getMeta() as SessionMeta;
      const stageName = (args.stage as PipelineStage) || meta.currentStage;
      const stageConfig = config.stages[stageName];

      if (!stageConfig) {
        return { error: `Unknown stage: "${stageName}"` };
      }

      if (!stageConfig.verify?.require) {
        return {
          error: `Stage "${stageName}" does not have verification enabled`,
        };
      }

      // Build verification options
      const verifyOptions: RunVerificationOptions = {};
      if (deps?.execFn) {
        verifyOptions.execFn = deps.execFn;
      }

      // Pass verifyFile override via options (no shared config mutation)
      if (args.verifyFile && typeof args.verifyFile === "string") {
        verifyOptions.verifyFile = args.verifyFile;
      }

      // Phase 4 (162): defer plan marker rule when confirm mode is non-auto (C2 fix).
      const deferPatterns = shouldDeferPlanMarkerRule(stageName, stageConfig) ? [PLAN_CONFIRM_MARKER_RULE] : [];
      if (deferPatterns.length > 0) {
        verifyOptions.deferContentPatterns = deferPatterns;
      }

      // Extract assistant messages from session branch for verification
      const assistantMessages = extractAssistantMessages(sessionCtx._ctx as any);

      // P1: Pre-check required files before running full verification
      const precheck = await precheckRequiredFiles(config, { ...meta, currentStage: stageName });
      if (!precheck.passed) {
        // Required files not yet produced — return guidance without failure/freeze
        return {
          success: false,
          passed: false,
          message: `Required deliverables not yet produced. Please create: ${precheck.missing.join(", ")}`,
          precheck: true,
          missing: precheck.missing,
        };
      }

      const vr = await runVerification(
        config,
        { ...meta, currentStage: stageName },
        assistantMessages,
        verifyOptions,
      );

      // Build the shared result shape consumed by applyVerifyPass/applyVerifyFail
      const sharedResult = {
        structuredResult: vr.structuredResult,
        ruleMissing: vr.ruleMissing,
        verifyResult: vr.verifyResult ?? null,
      };

      // 148 Phase 3: Config-error skip → return skipped result (treat as pass for tool caller)
      if (vr.skipped) {
        const errorSummary = vr.configErrors?.join("; ") ?? "unknown config error";
        const notifyMsg = `Verification config error: ${errorSummary}. Verification skipped. See guide.md for correct rule syntax.`;
        ui.notify(sessionCtx, notifyMsg);
        await safeWriteAuditLog("verify_config_skip", {
          pipelineId: meta.pipelineId,
          stage: stageName,
          errorCount: String(vr.configErrors?.length ?? 0),
          errors: errorSummary,
        }, "warn");
        return {
          success: true,
          passed: false,
          skipped: true,
          message: notifyMsg,
          configErrors: vr.configErrors,
          structuredResult: vr.structuredResult,
          ruleMissing: vr.ruleMissing,
          verifyResult: vr.verifyResult ?? null,
        };
      }

      // S1: Verification passes only on structured rules (rulePassed)
      if (vr.rulePassed) {
        // Phase 4 (162): bypass prevention — confirm non-auto stages must go through
        // stage_advance tool, not pipeline_verify. This prevents agents from skipping
        // the confirm gate by calling pipeline_verify directly.
        if (stageConfig.confirm?.mode && stageConfig.confirm.mode !== "auto") {
          await safeWriteAuditLog("confirm_defer_to_stage_advance", {
            pipelineId: meta.pipelineId,
            stage: stageName,
            confirmMode: stageConfig.confirm.mode,
          });
          // 163 Goal 2: in review scenario, guide the agent to declare reviewConclusion
          const reviewGuidance = stageName === "review"
            ? ' Call stage_advance({ reviewConclusion: "pass" | "fail" }) to declare the review verdict and advance.'
            : "";
          return {
            success: false,
            passed: true,
            pending: true,
            message: `Stage "${stageName}" uses confirm gate (mode=${stageConfig.confirm.mode}). Call stage_advance to confirm and advance.${reviewGuidance}`,
          };
        }

        return (await applyVerifyPass(sessionCtx, meta, stageName, stageConfig.nextStage, sharedResult, {
          method: "tool",
          handleTerminal: true,
          returnResult: true,
          ui,
        })) as unknown as Record<string, unknown>;
      }

      return (await applyVerifyFail(sessionCtx, meta, stageName, sharedResult, "tool", ui, config)) as unknown as Record<string, unknown>;
    },
  };
}
