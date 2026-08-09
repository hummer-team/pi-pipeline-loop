/**
 * @module pipeline-verify
 * Factory for the `pipeline_verify` tool.
 * Provides agent-triggered verification for stages configured with verify.mode = "tool".
 * Reads verify.md, runs structured rules + optional LLM verification, and auto-advances on success.
 */

import type { PipelineConfig, Tool, SessionMeta, PipelineStage, ExecFn, VerifyFailureItem } from "../types";
import { runVerification } from "../core/auto-verifier";
import type { RunVerificationOptions } from "../core/auto-verifier";
import { writeAuditLog } from "../utils/auditLog";

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
          getMetadata: () => SessionMeta;
          updateMetadata: (meta: SessionMeta) => void;
        };
        ui?: { notify: (msg: string) => void };
      };

      if (!sessionCtx.session) {
        return { error: "No session context available" };
      }

      const meta = sessionCtx.session.getMetadata();
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

      const assistantMessages = meta.assistantMessages || [];

      const verifyResult = await runVerification(
        config,
        { ...meta, currentStage: stageName },
        assistantMessages,
        verifyOptions,
      );

      if (verifyResult.verifyResult?.overallPassed) {
        // Verification passed — auto-advance
        return handleVerifyPass(
          sessionCtx,
          meta,
          stageName,
          stageConfig,
          verifyResult,
        );
      }

      // Check rulePassed for backward compat
      if (verifyResult.rulePassed) {
        return handleVerifyPass(
          sessionCtx,
          meta,
          stageName,
          stageConfig,
          verifyResult,
        );
      }

      // Verification failed
      return handleVerifyFail(
        sessionCtx,
        meta,
        stageName,
        verifyResult,
      );
    },
  };
}

/**
 * Handles successful verification: auto-advance to next stage.
 */
async function handleVerifyPass(
  ctx: {
    session: {
      getMetadata: () => SessionMeta;
      updateMetadata: (meta: SessionMeta) => void;
    };
    ui?: { notify: (msg: string) => void };
  },
  meta: SessionMeta,
  stageName: PipelineStage,
  stageConfig: { nextStage: PipelineStage | null },
  verifyResult: { verifyResult?: { structured: { passed: boolean }; llm: unknown; overallPassed: boolean } | undefined },
): Promise<Record<string, unknown>> {
  const nextStage = stageConfig.nextStage;
  if (nextStage) {
    ctx.session.updateMetadata({
      ...meta,
      previousStage: stageName,
      currentStage: nextStage,
      stageStartTime: Date.now(),
      loopCount: 0,
      currentStepIndex: 0,
      verifyFailures: [],
    });

    await writeAuditLog("auto_verify_pass", {
      pipelineId: meta.pipelineId,
      fromStage: stageName,
      nextStage,
      method: "tool",
    });

    if (ctx.ui?.notify) {
      ctx.ui.notify(
        `Verification passed for "${stageName}". Advanced to "${nextStage}".`,
      );
    }

    return {
      success: true,
      passed: true,
      message: `Verification passed for "${stageName}". Advanced to "${nextStage}".`,
      verifyResult: verifyResult.verifyResult || null,
    };
  }

  // No next stage (terminal stage)
  await writeAuditLog("auto_verify_pass", {
    pipelineId: meta.pipelineId,
    stage: stageName,
    method: "tool",
    note: "terminal stage, no advance",
  });

  return {
    success: true,
    passed: true,
    message: `Verification passed for terminal stage "${stageName}".`,
    verifyResult: verifyResult.verifyResult || null,
  };
}

/**
 * Handles failed verification: write verifyFailures to SessionMeta.
 */
async function handleVerifyFail(
  ctx: {
    session: {
      getMetadata: () => SessionMeta;
      updateMetadata: (meta: SessionMeta) => void;
    };
    ui?: { notify: (msg: string) => void };
  },
  meta: SessionMeta,
  stageName: PipelineStage,
  verifyResult: {
    structuredResult?: { failures: { ruleType: string; detail: string }[] };
    ruleMissing: string[];
  },
): Promise<Record<string, unknown>> {
  const now = Date.now();
  const verifyFailures: VerifyFailureItem[] = [];

  // Convert structured failures to VerifyFailureItem format
  if (verifyResult.structuredResult) {
    for (const f of verifyResult.structuredResult.failures) {
      verifyFailures.push({
        ruleType: f.ruleType,
        detail: f.detail,
        timestamp: now,
      });
    }
  }

  // Convert keyword missing to failures if not already captured
  if (
    verifyResult.ruleMissing.length > 0 &&
    !verifyFailures.some((f) => f.ruleType === "keywords")
  ) {
    verifyFailures.push({
      ruleType: "keywords",
      detail: `Missing keywords: ${verifyResult.ruleMissing.join(", ")}`,
      timestamp: now,
    });
  }

  ctx.session.updateMetadata({
    ...meta,
    verifyAttempts: (meta.verifyAttempts || 0) + 1,
    verifyFailures,
    assistantMessages: [],
  });

  await writeAuditLog("auto_verify_fail", {
    pipelineId: meta.pipelineId,
    stage: stageName,
    method: "tool",
    failureCount: String(verifyFailures.length),
    failureTypes: verifyFailures.map((f) => f.ruleType).join(","),
  });

  const failureSummary = verifyFailures
    .map((f) => `[${f.ruleType}] ${f.detail}`)
    .join("; ");

  if (ctx.ui?.notify) {
    ctx.ui.notify(
      `Verification failed for "${stageName}": ${failureSummary}. Fix the issues and try again.`,
    );
  }

  return {
    success: false,
    passed: false,
    message: `Verification failed for "${stageName}": ${failureSummary}`,
    failures: verifyFailures,
  };
}
