/**
 * @module verify-advance
 * Shared helpers for verification pass/fail handling.
 * Extracted from agent-settled.ts and pipeline-verify.ts to eliminate
 * ~100 lines of duplicated advance/failure recording logic (DRY).
 *
 * Phase 3 (162): the legacy plan human-gate functions (maybeHandlePlanHumanGate,
 * handlePlanGateApproved, PlanGateResult) have been removed. The confirm gate
 * now lives in stage-advancer.ts (maybeHandleConfirmGate and helpers).
 */

import type { SessionMeta, PipelineStage, VerifyFailureItem, PipelineConfig } from "../types";
import { writeAuditLog, writeStageAudit } from "../utils/auditLog";
import type { PipelineUI } from "./pipeline-ui";
import { freezeAndPrompt } from "./flow-state";

/**
 * Session context interface shared by hook and tool callers.
 * Provides metadata access, audit, and UI notification capabilities.
 */
interface VerifyAdvanceCtx {
  session: {
    getMeta: () => SessionMeta | undefined;
    updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
  };
  ui?: { notify: (msg: string) => void; select?: (message: string, options: string[]) => Promise<string | undefined> };
  /** @internal pi SDK handle for sending wake messages (used by autoAdvanceAfterVerify) */
  pi?: { sendUserMessage?: (msg: string) => void };
}

/**
 * Structured verification result consumed by applyVerifyPass/applyVerifyFail.
 * Captures the union of fields needed from both auto-verifier VerifyResult
 * and the runVerification return shape.
 */
interface VerifyAdvanceResult {
  structuredResult?: { failures: { ruleType: string; detail: string }[] };
  ruleMissing: string[];
  verifyResult?: { structured: { passed: boolean }; overallPassed: boolean } | null;
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
  /** Optional PipelineUI for TUI output */
  ui?: PipelineUI;
  /**
   * M1 fix: When true, suppress writing the auto_verify_pass audit event.
   * Used by the "skipped" path (config-error skip treated as pass) where
   * writing auto_verify_pass would misrepresent a skip as a real pass.
   */
  skipPassAudit?: boolean;
}

/**
 * Structured result returned by applyVerifyPass when returnResult=true.
 */
interface VerifyPassReturn {
  success: boolean;
  passed: boolean;
  message: string;
  verifyResult: { structured: { passed: boolean }; overallPassed: boolean } | null;
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
 * Detects whether a set of verification failures are caused by configuration
 * errors (EISDIR / empty path / directory path / unresolved requirementDoc).
 * Exported for reuse by stage-advancer skipVerify abuse guard.
 *
 * @param failures - Array of { ruleType, detail } failure items
 * @returns true if any failure matches a known config-error pattern
 */
export function isConfigError(failures: { ruleType: string; detail: string }[]): boolean {
  return failures.some(
    (f) =>
      // Config-error patterns can come from either fileContentPattern or requiredFiles
      // (auto-verifier produces requiredFiles ruleType when {requirementDoc} placeholder
      // is unresolved in a requiredFiles path — same config-class root cause)
      (f.ruleType === "fileContentPattern" || f.ruleType === "requiredFiles") &&
      /EISDIR|is a directory|points to a directory|path is empty|requirementDoc not set/.test(f.detail),
  );
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
 * - Sends TUI stage transition via opts.ui?.transition (gated by output.pipelineStage; silent terminal skip when handleTerminal=false)
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
    // Advance to next stage — pass only the delta to avoid overwriting concurrent writes
    ctx.session.updateMeta({
      previousStage: stageName,
      currentStage: nextStage,
      stageStartTime: Date.now(),
      loopCount: 0,
      currentStepIndex: 0,
      verifyFailures: [],
      violations: [],
      advancedThisTurn: undefined, // Clear C2 flag on stage transition
    });

    // M1 fix: skip auto_verify_pass audit when called from the "skipped" path
    // (config-error skip treated as pass — should NOT write auto_verify_pass)
    if (!opts.skipPassAudit) {
      await writeAuditLog("auto_verify_pass", {
        pipelineId: meta.pipelineId,
        fromStage: stageName,
        nextStage,
        method: opts.method,
      });
    }

    // TUI stage transition output (gated by output.pipelineStage)
    opts.ui?.transition(ctx, stageName, nextStage);

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
  // M1 fix: skip auto_verify_pass audit when called from the "skipped" path
  if (!opts.skipPassAudit) {
    await writeAuditLog("auto_verify_pass", {
      pipelineId: meta.pipelineId,
      stage: stageName,
      method: opts.method,
      note: "terminal stage, no advance",
    });
  }

  if (opts.handleTerminal && opts.returnResult) {
    // Pipeline reaching completed — clear status bar
    opts.ui?.clearStage(ctx);
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
 * - Sends TUI failure output via ui?.fail (gated by output.pipelineStage)
 *
 * @returns VerifyFailReturn with structured failure details
 */
export async function applyVerifyFail(
  ctx: VerifyAdvanceCtx,
  meta: SessionMeta,
  stageName: PipelineStage,
  verifyResult: VerifyAdvanceResult,
  method: "tool" | "rule",
  ui?: PipelineUI,
  config?: PipelineConfig,
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

  // Phase 3 (L3): config-error detection — freeze immediately without
  // incrementing verifyAttempts, giving the user the decision menu.
  if (config && isConfigError(verifyFailures)) {
    ctx.session.updateMeta({
      verifyFailures,
      verifyConfigError: true,
    });

    await writeAuditLog("verify_config_error", {
      pipelineId: meta.pipelineId,
      stage: stageName,
      method,
      failureCount: String(verifyFailures.length),
      failureTypes: verifyFailures.map((f) => f.ruleType).join(","),
      details: verifyFailures.map((f) => f.detail).join("; "),
    }, "error");

    // Build flowUI adapter for freezeAndPrompt (reuse existing rawSelect logic)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawSelect = (ctx.ui as any)?.select;
    const flowUI: { notify: (msg: string) => void; select?: (msg: string, opts: string[]) => Promise<string | undefined> } = {
      notify: (msg: string) => { ui?.notify(ctx, msg); },
    };
    if (typeof rawSelect === "function") {
      flowUI.select = rawSelect;
    }
    await freezeAndPrompt(ctx as Parameters<typeof freezeAndPrompt>[0], meta, "verify_config_error", config, {
      ui: flowUI,
    });

    const failureSummary = verifyFailures
      .map((f) => `[${f.ruleType}] ${f.detail}`)
      .join("; ");

    return {
      success: false,
      passed: false,
      message: `Verification config error — frozen. Use the decision menu to proceed: ${failureSummary}`,
      failures: verifyFailures,
    };
  }

  const updatedVerifyAttempts = (meta.verifyAttempts || 0) + 1;
  ctx.session.updateMeta({
    verifyAttempts: updatedVerifyAttempts,
    verifyFailures,
  });

  await writeAuditLog("auto_verify_fail", {
    pipelineId: meta.pipelineId,
    stage: stageName,
    method,
    failureCount: String(verifyFailures.length),
    failureTypes: verifyFailures.map((f) => f.ruleType).join(","),
    details: verifyFailures.map((f) => f.detail).join("; "),
  }, "warn");

  const failureSummary = verifyFailures
    .map((f) => `[${f.ruleType}] ${f.detail}`)
    .join("; ");

  // TUI failure output (gated by output.pipelineStage)
  ui?.fail(ctx, stageName, "verify failed");

  // Circuit breaker: if verifyAttempts reaches maxVerifyAttempts, freeze pipeline
  if (config) {
    const maxAttempts = config.maxVerifyAttempts ?? config.maxLoops ?? 3;
    if (updatedVerifyAttempts >= maxAttempts) {
      // Build a ui adapter for freezeAndPrompt from ctx.ui if available.
      // Include both notify and select so the decision dialog works properly
      // (avoid shadowing ctx.ui.select with a notify-only adapter).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawSelect = (ctx.ui as any)?.select;
      const flowUI: { notify: (msg: string) => void; select?: (msg: string, opts: string[]) => Promise<string | undefined> } = {
        notify: (msg: string) => { ctx.ui!.notify(msg); },
      };
      if (typeof rawSelect === "function") {
        flowUI.select = rawSelect;
      }
      await freezeAndPrompt(ctx, meta, "verify_attempt_overflow", config, {
        ui: flowUI,
      });
      // H2 fix: return immediately after freeze to prevent fall-through
      // to the wake-model code block below. Overflow freeze hands control
      // to the user (decision menu); waking the model would interfere.
      return {
        success: false,
        passed: false,
        message: `Verification failed for "${stageName}" (attempt overflow — frozen): ${failureSummary}`,
        failures: verifyFailures,
      };
    }
  }

  // 148 Phase 4: wake the model to fix verification failures in hook mode.
  // Freeze branches above hand control to the user; only the ordinary fail
  // path wakes the model. Tool mode stays silent (R2-Q1-A).
  if (method === "rule" && ctx.pi && typeof ctx.pi.sendUserMessage === "function") {
    try {
      ctx.pi.sendUserMessage(
        `Verification failed for "${stageName}": ${failureSummary}. Fix the issues and re-run verification. Please strictly follow the SKILL output format requirements.`,
      );
      await writeAuditLog("verify_fail_wake", {
        pipelineId: meta.pipelineId,
        stage: stageName,
        method,
        failureCount: String(verifyFailures.length),
      });
    } catch (err) {
      await writeAuditLog("verify_fail_wake_failed", {
        pipelineId: meta.pipelineId,
        stage: stageName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    success: false,
    passed: false,
    message: `Verification failed for "${stageName}": ${failureSummary}. Please strictly follow the SKILL output format requirements.`,
    failures: verifyFailures,
  };
}

/**
 * Shared post-verification advance logic: applyVerifyPass + stage audit + wake message.
 * Extracted from agent-settled.ts (lines 124-195) so that both the hook path
 * and the plan human-gate "approved" branch can reuse it (DRY).
 *
 * @param config - Pipeline configuration (for stage lookup)
 * @param ctx - Session/PI context
 * @param meta - Current session metadata (before advance)
 * @param fromStage - Stage being verified
 * @param toStage - Target stage to advance to
 * @param verifyResult - Synthetic or real verification result
 * @param pipelineUI - PipelineUI for TUI transitions
 */
export async function autoAdvanceAfterVerify(
  config: PipelineConfig,
  ctx: VerifyAdvanceCtx,
  meta: SessionMeta,
  fromStage: PipelineStage,
  toStage: PipelineStage | null,
  verifyResult: VerifyAdvanceResult,
  pipelineUI: PipelineUI,
  /** M1 fix: optional flags for callers (e.g., skipped path suppresses auto_verify_pass audit) */
  options?: { skipPassAudit?: boolean },
): Promise<void> {
  const clearedMeta = { ...meta, advancedThisTurn: undefined };

  await applyVerifyPass(ctx, clearedMeta, fromStage, toStage, verifyResult, {
    method: "rule",
    handleTerminal: false,
    returnResult: false,
    ui: pipelineUI,
    skipPassAudit: options?.skipPassAudit,
  });

  // Stage audit
  if (toStage && toStage !== "completed") {
    await writeStageAudit(config, "stage_advance", clearedMeta, {
      fromStage,
      toStage,
      method: "hook_auto_advance",
    });
  } else {
    await writeStageAudit(config, "pipeline_completed", clearedMeta, {
      fromStage,
      finalStage: fromStage,
      method: "hook_auto_advance",
    });
  }

  // Wake next stage via pi.sendUserMessage
  const pi = ctx.pi;
  if (
    pi
    && typeof pi.sendUserMessage === "function"
    && toStage
    && toStage !== "completed"
  ) {
    try {
      pi.sendUserMessage(
        `Pipeline advanced from ${fromStage} to ${toStage}. Begin the ${toStage} stage work now.`,
      );
      await writeAuditLog("auto_advance_wake", {
        pipelineId: meta.pipelineId,
        fromStage,
        toStage,
        method: "rule",
      });
    } catch (err) {
      await writeAuditLog("auto_advance_wake_failed", {
        pipelineId: meta.pipelineId,
        fromStage,
        toStage,
        method: "rule",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (pi === undefined) {
    await writeAuditLog("auto_advance_wake_skipped", {
      pipelineId: meta.pipelineId,
      fromStage,
      toStage: toStage ? String(toStage) : "none",
      reason: "pi not forwarded via RuntimeCtx",
    });
  }
}

