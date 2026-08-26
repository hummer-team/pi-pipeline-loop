/**
 * @module verify-advance
 * Shared helpers for verification pass/fail handling.
 * Extracted from agent-settled.ts and pipeline-verify.ts to eliminate
 * ~100 lines of duplicated advance/failure recording logic (DRY).
 */

import type { SessionMeta, PipelineStage, VerifyFailureItem, PipelineConfig } from "../types";
import { writeAuditLog, writeStageAudit } from "../utils/auditLog";
import type { PipelineUI } from "./pipeline-ui";
import { freezeAndPrompt } from "./flow-state";
import { resolvePlanDocPath, planDocHasConfirmMarker } from "./auto-verifier";
import fs from "node:fs/promises";

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
        `Verification failed for "${stageName}": ${failureSummary}. Fix the issues and re-run verification.`,
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
    message: `Verification failed for "${stageName}": ${failureSummary}`,
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

/**
 * Result of the plan human-gate pre-check.
 *
 * - "no-gate": preconditions not met; caller should proceed with normal verify flow.
 * - "handled": gate was triggered and handled by one of the action branches.
 *
 * `action` further disambiguates the handled outcome so callers (notably the
 * stage_advance tool) can tell whether the pipeline actually advanced to the
 * next stage or is waiting for human input:
 *
 * - "advanced"  — user approved; marker written, stage moved to develop.
 * - "pending"   — no UI available; awaiting external confirmation.
 * - "adjust"    — user requested adjustments; stage stays in plan.
 * - "cancelled" — user dismissed or cancelled; stage stays in plan.
 */
export interface PlanGateResult {
  result: "no-gate" | "handled";
  action: "none" | "advanced" | "pending" | "adjust" | "cancelled";
}

/**
 * Handles the "approved" branch of the plan human-gate dialog.
 *
 * 1. Validates the write path against the plan stage's `allowedWritePaths`.
 * 2. Appends the `## 用户确认` confirmation marker to the plan document.
 * 3. Writes `plan_confirm_approved` (or `plan_confirm_approved_failed`) audit event.
 * 4. On success, advances the pipeline to the next stage via `autoAdvanceAfterVerify`.
 *
 * @returns "advanced" when marker write + advance succeeded;
 *          "cancelled" when the write path is not allowed or the marker write failed.
 */
async function handlePlanGateApproved(
  config: PipelineConfig,
  ctx: VerifyAdvanceCtx,
  meta: SessionMeta,
  planDocPath: string,
  pipelineUI: PipelineUI,
): Promise<"advanced" | "cancelled"> {
  const stageConfig = config.stages["plan"];
  const relPlanDoc = planDocPath.startsWith(config.projectRoot)
    ? planDocPath.slice(config.projectRoot.length + 1)
    : planDocPath;

  // Validate write path against plan stage's allowedWritePaths (docs/)
  const allowed = (stageConfig.allowedWritePaths ?? []).some(
    (prefix) => prefix === "**" || relPlanDoc.startsWith(prefix),
  );
  if (!allowed) {
    await writeAuditLog("plan_confirm_rejected", {
      pipelineId: meta.pipelineId,
      stage: "plan",
      planDoc: planDocPath,
      reason: "write path not in allowedWritePaths",
    });
    pipelineUI.notify(
      ctx,
      `Plan doc path "${relPlanDoc}" not in plan allowedWritePaths. Cannot write confirmation.`,
    );
    return "cancelled";
  }

  // Append confirmation marker to plan doc
  const timestamp = new Date().toISOString();
  const markerText = `\n## 用户确认：确认无误\n\n> 确认时间：${timestamp}\n`;
  try {
    await fs.appendFile(planDocPath, markerText, "utf-8");
  } catch (err) {
    // EISDIR / permission / path-not-writable — do NOT advance
    await writeAuditLog("plan_confirm_approved_failed", {
      pipelineId: meta.pipelineId,
      stage: "plan",
      planDoc: planDocPath,
      error: err instanceof Error ? err.message : String(err),
    });
    pipelineUI.notify(
      ctx,
      `Failed to write confirmation marker to "${relPlanDoc}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return "cancelled";
  }

  await writeAuditLog("plan_confirm_approved", {
    pipelineId: meta.pipelineId,
    stage: "plan",
    planDoc: planDocPath,
    timestamp,
  });

  // Advance to next stage (develop) using shared advance logic
  const toStage = stageConfig.nextStage;
  const syntheticResult: VerifyAdvanceResult = {
    structuredResult: { failures: [] },
    ruleMissing: [],
    verifyResult: null,
  };
  await autoAdvanceAfterVerify(config, ctx, meta, "plan", toStage, syntheticResult, pipelineUI);

  return "advanced";
}

/**
 * Pre-checks whether the plan stage human-gate should be triggered.
 *
 * Conditions: currentStage === "plan" AND planDocPath resolvable AND
 * planDocHasConfirmMarker === false. If any condition fails, returns "no-gate".
 *
 * When triggered, presents a TUI select dialog with 3 options:
 * - "已确认（写入标记并推进）": appends ## 用户确认 marker, advances to develop
 * - "有问题需调整（在 plan 补充调整意见）": stays in plan, no advance
 * - "取消": stays in plan, no advance
 *
 * Each action has its own audit event. Does NOT increment verifyAttempts.
 *
 * @param config - Pipeline configuration
 * @param ctx - Session/PI context
 * @param meta - Current session metadata
 * @param pipelineUI - PipelineUI for TUI dialogs
 */
export async function maybeHandlePlanHumanGate(
  config: PipelineConfig,
  ctx: VerifyAdvanceCtx,
  meta: SessionMeta,
  pipelineUI: PipelineUI,
): Promise<PlanGateResult> {
  // Precondition 1: must be in plan stage
  if (meta.currentStage !== "plan") return { result: "no-gate", action: "none" };

  // Precondition 2: plan doc path must be resolvable
  const planDocPath = await resolvePlanDocPath(config, meta);
  if (!planDocPath) return { result: "no-gate", action: "none" };

  // Precondition 2b: plan doc file must actually exist on disk.
  // When plan doc hasn't been generated yet, skip the gate — the normal
  // verify flow will catch missing requiredFiles instead.
  try {
    await fs.access(planDocPath);
  } catch {
    return { result: "no-gate", action: "none" };
  }

  // Precondition 3: confirm marker must NOT already be present
  const hasMarker = await planDocHasConfirmMarker(planDocPath);
  if (hasMarker) return { result: "no-gate", action: "none" };

  // Gate triggered: show dialog
  const rawSelect = ctx.ui?.select;
  if (!rawSelect) {
    // No UI available: silent pending
    await writeAuditLog("plan_confirm_pending", {
      pipelineId: meta.pipelineId,
      stage: "plan",
      planDoc: planDocPath,
      reason: "no ui.select available",
    });
    pipelineUI.notify(ctx, "Plan document requires human confirmation. Awaiting UI interaction.");
    return { result: "handled", action: "pending" };
  }

  const choice = await rawSelect(
    "规划确认（以文档标记为准）：请选择操作",
    ["已确认（写入标记并推进）", "有问题需调整（在 plan 补充调整意见）", "取消"],
  );

  // Handle Esc / undefined (user pressed Esc or dialog dismissed)
  if (choice === undefined) {
    await writeAuditLog("plan_confirm_cancelled", {
      pipelineId: meta.pipelineId,
      stage: "plan",
      planDoc: planDocPath,
      action: "esc_dismissed",
    });
    pipelineUI.notify(ctx, "规划确认已取消，请在 plan 文档中补充 ## 用户确认 后重新触发验证。");
    return { result: "handled", action: "cancelled" };
  }

  // Dispatch to action branch
  if (choice.startsWith("已确认")) {
    const approvedAction = await handlePlanGateApproved(config, ctx, meta, planDocPath, pipelineUI);
    return { result: "handled", action: approvedAction };
  }

  if (choice.startsWith("有问题")) {
    await writeAuditLog("plan_confirm_adjust", {
      pipelineId: meta.pipelineId,
      stage: "plan",
      planDoc: planDocPath,
    });
    pipelineUI.notify(ctx, "请在 plan 文档追加 ## 调整意见 并说明修改项");
    return { result: "handled", action: "adjust" };
  }

  // Cancel
  await writeAuditLog("plan_confirm_cancelled", {
    pipelineId: meta.pipelineId,
    stage: "plan",
    planDoc: planDocPath,
    action: "user_cancelled",
  });
  pipelineUI.notify(ctx, "规划确认已取消，请在 plan 文档中补充 ## 用户确认 后重新触发验证。");
  return { result: "handled", action: "cancelled" };
}
