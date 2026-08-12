/**
 * @module pipeline-verify
 * Factory for the `pipeline_verify` tool.
 * Provides agent-triggered verification for stages configured with verify.mode = "tool".
 * Reads verify.md, runs structured rules + optional LLM verification, and auto-advances on success.
 */

import type { PipelineConfig, Tool, SessionMeta, PipelineStage, ExecFn } from "../types";
import { runVerification } from "../core/auto-verifier";
import type { RunVerificationOptions } from "../core/auto-verifier";
import { applyVerifyPass, applyVerifyFail } from "../core/verify-advance";
import { createPipelineUI } from "../core/pipeline-ui";

/**
 * Options injected into the pipeline_verify tool via closure.
 */
export interface PipelineVerifyDeps {
  /** Optional LLM call function for flexible verification */
  callLLM?: (prompt: string) => Promise<string>;
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
 * @param deps - Injected dependencies (callLLM, execFn)
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
          extractAssistantMessages: () => string[];
        };
        ui?: { notify: (msg: string) => void };
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
      if (deps?.callLLM) {
        verifyOptions.callLLM = deps.callLLM;
      }
      if (deps?.execFn) {
        verifyOptions.execFn = deps.execFn;
      }

      // Pass verifyFile override via options (no shared config mutation)
      if (args.verifyFile && typeof args.verifyFile === "string") {
        verifyOptions.verifyFile = args.verifyFile;
      }

      // Extract assistant messages from session branch for verification
      const assistantMessages = sessionCtx.session.extractAssistantMessages();

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

      if (vr.verifyResult?.overallPassed || vr.rulePassed) {
        return (await applyVerifyPass(sessionCtx, meta, stageName, stageConfig.nextStage, sharedResult, {
          method: "tool",
          handleTerminal: true,
          returnResult: true,
          ui,
        })) as unknown as Record<string, unknown>;
      }

      return (await applyVerifyFail(sessionCtx, meta, stageName, sharedResult, "tool", ui)) as unknown as Record<string, unknown>;
    },
  };
}
