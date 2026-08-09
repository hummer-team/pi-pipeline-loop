/**
 * @module verify-advance
 * Shared helpers for verification pass/fail handling.
 * Extracted from agent-settled.ts and pipeline-verify.ts to eliminate
 * ~100 lines of duplicated advance/failure recording logic (DRY).
 */

import type { SessionMeta, PipelineStage, VerifyFailureItem } from "../types";
import { writeAuditLog } from "../utils/auditLog";

/**
 * Session context interface shared by hook and tool callers.
 * Provides metadata access, audit, and UI notification capabilities.
 */
interface VerifyAdvanceCtx {
  session: {
    getMetadata: () => SessionMeta;
    updateMetadata: (meta: SessionMeta) => void;
  };
  ui?: { notify: (msg: string) => void };
}

/**
 * Structured verification result consumed by applyVerifyPass/applyVerifyFail.
 * Captures the union of fields needed from both auto-verifier VerifyResult
 * and the runVerification return shape.
 */
interface VerifyAdvanceResult {
  structuredResult?: { failures: { ruleType: string; detail: string }[] };
  ruleMissing: string[];
  verifyResult?: { structured: { passed: boolean }; llm: unknown; overallPassed: boolean } | null;
}

/** Options controlling applyVerifyPass behavior for different callers */
interface ApplyVerifyPassOpts {
  /** Whether this was triggered by a "tool" (pipeline_verify) or "rule" (agent_settled hook) */
  method: "tool" | "rule";
  /**
   * Whether to handle the terminal stage case (nextStage is null) explicitly:
   * - true (tool path): writes audit "terminal stage, no advance" and returns a message
   * - false (hook path): silently skips without notification
   */
  handleTerminal: boolean;
  /**
   * Whether to return a structured result object:
   * - true (tool path): returns { success, passed, message, verifyResult }
   * - false (hook path): returns void
   */
  returnResult: boolean;
}

/**
 * Structured result returned by applyVerifyPass when returnResult=true.
 */
interface VerifyPassReturn {
  success: boolean;
  passed: boolean;
  message: string;
  verifyResult: { structured: { passed: boolean }; llm: unknown; overallPassed: boolean } | null;
}

/**
 * Structured result returned by applyVerifyFail.
 */
interface VerifyFailReturn {
  success: false;
  passed: false;
  message: string;
  failures: VerifyFailureItem[];
}

/**
 * Handles successful verification: advances to next stage (or handles terminal stage).
 *
 * Shared between agent_settled hook (method="rule", handleTerminal=false, returnResult=false)
 * and pipeline_verify tool (method="tool", handleTerminal=true, returnResult=true).
 *
 * Side effects:
 * - On advance: updates metadata (previousStage, currentStage, resets loopCount/stepIndex/verifyFailures)
 * - Writes audit log "auto_verify_pass" with method tag
 * - Sends ui.notify (except silent terminal skip when handleTerminal=false)
 *
 * @returns VerifyPassReturn when returnResult=true; void when returnResult=false
 */
export async function applyVerifyPass(
  ctx: VerifyAdvanceCtx,
  meta: SessionMeta,
  stageName: PipelineStage,
  nextStage: PipelineStage | null,
  verifyResult: VerifyAdvanceResult,
  opts: ApplyVerifyPassOpts & { returnResult: true },
): Promise<VerifyPassReturn>;
export async function applyVerifyPass(
  ctx: VerifyAdvanceCtx,
  meta: SessionMeta,
  stageName: PipelineStage,
  nextStage: PipelineStage | null,
  verifyResult: VerifyAdvanceResult,
  opts: ApplyVerifyPassOpts & { returnResult: false },
): Promise<void>;
export async function applyVerifyPass(
  ctx: VerifyAdvanceCtx,
  meta: SessionMeta,
  stageName: PipelineStage,
  nextStage: PipelineStage | null,
  verifyResult: VerifyAdvanceResult,
  opts: ApplyVerifyPassOpts,
): Promise<VerifyPassReturn | void> {
  if (nextStage) {
    // Advance to next stage
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
      method: opts.method,
    });

    if (ctx.ui?.notify) {
      ctx.ui.notify(
        `Verification passed for "${stageName}". Advanced to "${nextStage}".`,
      );
    }

    if (opts.returnResult) {
      return {
        success: true,
        passed: true,
        message: `Verification passed for "${stageName}". Advanced to "${nextStage}".`,
        verifyResult: verifyResult?.verifyResult ?? null,
      };
    }
    return;
  }

  // Terminal stage (no next stage)
  await writeAuditLog("auto_verify_pass", {
    pipelineId: meta.pipelineId,
    stage: stageName,
    method: opts.method,
    note: "terminal stage, no advance",
  });

  if (opts.handleTerminal && opts.returnResult) {
    return {
      success: true,
      passed: true,
      message: `Verification passed for terminal stage "${stageName}".`,
      verifyResult: verifyResult?.verifyResult ?? null,
    };
  }
  // handleTerminal=false (hook path): silently skip — no notification, no return
}

/**
 * Handles failed verification: writes verifyFailures to SessionMeta and logs audit.
 *
 * Shared between agent_settled hook (method="rule") and pipeline_verify tool (method="tool").
 * The hook side ignores the return value; the tool side uses it for structured response.
 *
 * Side effects:
 * - Converts structuredResult.failures + ruleMissing → VerifyFailureItem[] (with timestamp)
 * - Updates metadata: verifyAttempts+1, verifyFailures, clears assistantMessages
 * - Writes audit log "auto_verify_fail" with method, failureCount, failureTypes
 * - Sends ui.notify with failure summary
 *
 * @returns VerifyFailReturn with structured failure details
 */
export async function applyVerifyFail(
  ctx: VerifyAdvanceCtx,
  meta: SessionMeta,
  stageName: PipelineStage,
  verifyResult: VerifyAdvanceResult,
  method: "tool" | "rule",
): Promise<VerifyFailReturn> {
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
    method,
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
