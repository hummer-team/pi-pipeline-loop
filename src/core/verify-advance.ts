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
import { writeAuditLog, writeStageAudit, safeWriteAuditLog } from "../utils/auditLog";
import type { PipelineUI } from "./pipeline-ui";
import { freezeAndPrompt } from "./flow-state";
// 210 Phase 2: re-arm the stage clocks once a transition is committed (5.4).
import { armStageWatchdog } from "./stage-watchdog";
// 193 Phase 0: report-domain failures carry the complete corrective template
import { buildDesignReviewReportFeedback } from "./design-review/report-feedback";
import { buildPlanDocFeedback } from "./plan-doc-feedback";
// 193 Phase 3 (task 6): RECHECK barrier for ordinary forward releases
import { checkRecheckForwardRelease } from "./design-review/flow-decision-guard";
import { recordStageVisit, effectiveMax, remainingRoundsOf } from "../utils/stage-visit";
// 194 Phase 3 (C5): bound exits and failure records go through strict commits
import {
  boundActiveRun,
  commitBoundStageExit,
  commitBoundFailureRecord,
} from "./stage-executor/transition-commit";
import { computeResultKey } from "./stage-executor/run-state";
import { spawnStageSubagent, clearAllPendingSpawns } from "../utils/subagent-rpc";
// Phase 0 (182): dispatch stage executor after choose_stage from frozen menu
import { buildOnStageChangedCallback } from "../commands/pipeline-start";
import { describeEmptyOrInvalidRuleSet } from "../utils/guard-conflict-report";

/**
 * Session context interface shared by hook and tool callers.
 * Provides metadata access, audit, and UI notification capabilities.
 * Phase 1 (169): session interface extended for spawn idempotency guard.
 */
interface VerifyAdvanceCtx {
  session: {
    getMeta: () => SessionMeta | undefined;
    updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
  };
  ui?: { notify: (msg: string) => void; select?: (message: string, options: string[]) => Promise<string | undefined> };
  /** @internal pi SDK handle for sending wake messages (used by autoAdvanceAfterVerify) */
  pi?: { sendUserMessage?: (msg: string, opts?: Record<string, unknown>) => void; events?: unknown };
  /** Phase 3 (195_Bug): PipelineConfig for edge classification */
  config: PipelineConfig;
}

/**
 * Structured verification result consumed by applyVerifyPass/applyVerifyFail.
 * Captures the union of fields needed from both auto-verifier VerifyResult
 * and the runVerification return shape.
 */
interface VerifyAdvanceResult {
  structuredResult?: {
    failures: {
      ruleType: string;
      detail: string;
      group?: string;
      /** 203_Bug Phase 2 (RC3): environmental-only failure marker passthrough */
      nonCountable?: boolean;
    }[];
  };
  ruleMissing: string[];
  verifyResult?: { structured: { passed: boolean }; overallPassed: boolean } | null;
  /** Phase 9: rule set source file path (relative to projectRoot) */
  rulesSource?: string;
  /** Phase 9: whether rules were successfully parsed */
  rulesParsed?: boolean;
  /** Phase 9: whether self-verify skip is enabled */
  selfVerifySkip?: boolean;
  /** Phase 9: parse error reason when rules failed to parse */
  parseError?: string;
}

/**
 * Builds a failure summary line. Group-tagged failures (Phase 1 / 176) use the
 * `[group:name][ruleType] detail` format; flat failures keep the legacy format.
 */
function formatFailure(failure: { ruleType: string; detail: string; group?: string }): string {
  return failure.group
    ? `[${failure.group}][${failure.ruleType}] ${failure.detail}`
    : `[${failure.ruleType}] ${failure.detail}`;
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
 * 203_Bug Phase 2 (RC3): Detects whether ALL failures are environmental-only
 * — structurally unsatisfiable for the current stage (e.g. requiredGit
 * cleanWorkingTree dirtied solely by pipeline-managed/ignored paths).
 * Exported for unit tests and potential reuse.
 *
 * @param failures - Failure items carrying the optional nonCountable marker
 * @returns true when the set is non-empty and every item is nonCountable
 */
export function isEnvironmentalOnly(
  failures: { nonCountable?: boolean }[],
): boolean {
  return failures.length > 0 && failures.every((f) => f.nonCountable === true);
}

/** Owner-facing guidance for environmental (non-countable) verification blocks. */
function envGuidance(failures: VerifyFailureItem[]): string {
  return (
    `Verification blocked by environmental conditions only (${failures.map((f) => f.ruleType).join(", ")}) ` +
    "— not counted against verify attempts. " +
    "Fix the environment or re-commit stage outputs in their expected locations; " +
    "see .pi/references/develop_spec/verify.md."
  );
}

/**
 * 203_Bug Phase 2 (review fix): de-duplication window for environmental-block
 * feedback. The condition is structural (managed/ignored paths) and therefore
 * repeats on every settle; re-auditing / re-notifying / re-waking on each turn
 * would either add noise or create a wake loop. Feedback is re-emitted when the
 * signature changes (pipeline/stage/details) or the window expires, so the
 * agent still gets a periodic reminder while the block persists.
 */
const ENV_BLOCKED_FEEDBACK_WINDOW_MS = 10 * 60 * 1000;

let lastEnvBlockedFeedback: { key: string; at: number } | null = null;

/**
 * Returns true when environmental-block feedback should be emitted for this
 * signature, updating the window memo.
 *
 * @param key - Stable failure signature (pipeline/stage/failure details)
 * @param now - Current timestamp
 */
function shouldEmitEnvBlockedFeedback(key: string, now: number): boolean {
  if (
    lastEnvBlockedFeedback !== null
    && lastEnvBlockedFeedback.key === key
    && now - lastEnvBlockedFeedback.at < ENV_BLOCKED_FEEDBACK_WINDOW_MS
  ) {
    return false;
  }
  lastEnvBlockedFeedback = { key, at: now };
  return true;
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
    // 193 Phase 3 (task 6): RECHECK barrier — an upstream rollback cleared
    // the design-review state but left the recheck marker armed; a verify
    // PASS may not release the pipeline toward develop/review/fix/
    // awaiting_human/completed until a NEW review authorization takes over.
    // Consulted BEFORE the stage visit is counted (a refused release must
    // not consume budget).
    const recheck = checkRecheckForwardRelease(ctx.session.getMeta() ?? meta, nextStage);
    if (recheck.blocked) {
      await writeAuditLog("design_review_recheck_forward_release_blocked", {
        pipelineId: meta.pipelineId ?? "unknown",
        fromStage: stageName,
        nextStage,
        method: opts.method,
      }, "warn");
      if (opts.returnResult) {
        return {
          success: false,
          passed: true,
          message: recheck.reason,
          verifyResult: verifyResult?.verifyResult ?? null,
        };
      }
      return;
    }

    // Record stage visit via shared helper before updateMeta (DRY with handoff,
    // stage-advancer, routeConfirmReject). Max cycles from meta with default 3.
    const maxCycles = effectiveMax(meta, ctx.config);
    const visitResult = recordStageVisit(meta, nextStage, maxCycles, ctx.config);

    // Issue #20: Check budget early stop — if recordStageVisit failed (budget exceeded),
    // freeze the pipeline instead of advancing. This prevents the "advance first, freeze later"
    // race condition mentioned in the review.
    if (!visitResult.ok) {
      await writeAuditLog("auto_verify_pass_blocked_by_budget", {
        pipelineId: meta.pipelineId,
        fromStage: stageName,
        nextStage,
        method: opts.method,
        reason: "budget_exceeded",
        loopCycleCount: String(meta.loopCycleCount ?? 0),
        maxLoopCycles: String(effectiveMax(meta, ctx.config)),
        remainingRounds: String(remainingRoundsOf(meta, ctx.config)),
        rulesSource: verifyResult?.rulesSource ?? "",
        rulesParsed: verifyResult?.rulesParsed ?? false,
        selfVerifySkip: verifyResult?.selfVerifySkip ?? false,
      });

      if (opts.returnResult) {
        return {
          success: false,
          passed: true,
          message: `Verification passed for "${stageName}" but advance blocked by budget: budget_exceeded`,
          verifyResult: verifyResult?.verifyResult ?? null,
        };
      }
      return;
    }

    // Advance to next stage — pass only the delta to avoid overwriting concurrent writes
    const transitionPatch: Partial<SessionMeta> = {
      ...visitResult.patch,
      previousStage: stageName,
      currentStage: nextStage,
      stageStartTime: Date.now(),
      loopCount: 0,
      currentStepIndex: 0,
      verifyFailures: [],
      verifyAttempts: 0, // Reset per-stage attempt counter on stage advance (168 Phase 0)
      violations: [],
      advancedThisTurn: undefined, // Clear C2 flag on stage transition
      reviewConclusionDeclared: undefined, // Clear 163 declaration flag on stage transition
      precheckBlocked: undefined, // 189 Bug 3: clear hard-stop flag on stage transition
      transientRetryCount: undefined, // 189 Phase 2: clear retry counter on stage transition
    };

    // 194 Phase 3 (C5): a bound stage exit is ONE strict commit — transition,
    // terminalConsumed and the `applied` record land together, and nothing is
    // reported or dispatched unless the commit persisted.
    const freshForAnchor = ctx.session.getMeta() ?? meta;
    const boundRunNow = boundActiveRun(freshForAnchor, stageName);
    const boundExit = commitBoundStageExit({
      session: ctx.session,
      meta: freshForAnchor,
      sourceStage: stageName,
      transitionPatch,
      runtimeCtx: ctx,
      ...(boundRunNow !== null
        ? {
            resultKey: computeResultKey({
              runId: boundRunNow.binding.runId,
              declarationRevision: boundRunNow.declaration?.revision,
              inputFingerprints: [`${stageName}->${nextStage}`],
            }),
          }
        : {}),
    });
    if (boundExit.status === "refused") {
      await safeWriteAuditLog("transition_commit", {
        action: "bound_exit_refused",
        stage: stageName,
        nextStage,
        method: opts.method,
        reason: boundExit.reason,
      }, "warn");
      if (opts.returnResult) {
        return {
          success: false,
          passed: true,
          message: `Bound stage exit refused (${boundExit.reason}). Nothing was consumed or advanced — the run stays pending for a reliable retry.`,
          verifyResult: verifyResult?.verifyResult ?? null,
        };
      }
      return;
    }
    if (boundExit.status === "not-bound") {
      ctx.session.updateMeta(transitionPatch);
    }

    // 210 Phase 2: the transition is COMMITTED (both the bound-strict and the
    // not-bound path above), with `stageStartTime` rewritten — so the previous
    // visit's pair is replaced by a fresh arm for the target stage. A
    // `completed` / `awaiting_human` target is dormant/frozen → clears instead.
    armStageWatchdog(ctx, ctx.config, { progressSource: "stage_advance" });

    // Phase 0 (186): clear all pendingSpawns when advancing to terminal completed stage.
    // Prevents stale pendingSpawns from blocking wakeOwnerOnChainTerminal.
    if (nextStage === "completed") {
      clearAllPendingSpawns(ctx.session);
    }

    // M1 fix: skip auto_verify_pass audit when called from the "skipped" path
    // (config-error skip treated as pass — should NOT write auto_verify_pass)
    if (!opts.skipPassAudit) {
      await writeAuditLog("auto_verify_pass", {
        pipelineId: meta.pipelineId,
        fromStage: stageName,
        nextStage,
        method: opts.method,
        rulesSource: verifyResult?.rulesSource ?? "",
        rulesParsed: verifyResult?.rulesParsed ?? false,
        selfVerifySkip: verifyResult?.selfVerifySkip ?? false,
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
  // Phase 0 (186): clear all pendingSpawns on terminal state to prevent stale
  // entries from blocking wakeOwnerOnChainTerminal.
  clearAllPendingSpawns(ctx.session);

  // M1 fix: skip auto_verify_pass audit when called from the "skipped" path
  if (!opts.skipPassAudit) {
    await writeAuditLog("auto_verify_pass", {
      pipelineId: meta.pipelineId,
      stage: stageName,
      method: opts.method,
      note: "terminal stage, no advance",
      rulesSource: verifyResult?.rulesSource ?? "",
      rulesParsed: verifyResult?.rulesParsed ?? false,
      selfVerifySkip: verifyResult?.selfVerifySkip ?? false,
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
 * IMPORTANT (Phase 6 / 175, R2Q3A): Format failures (requiredFiles/fileContentPattern)
 * intentionally do NOT enter trackViolation. They use the separate verify feedback loop:
 *   verifyAttempts++ → verify_fail_wake (sendUserMessage followUp) → verify_attempt_overflow
 * This ensures format issues are handled through the model retry loop (maxVerifyAttempts)
 * rather than the behavioral violations circuit breaker (DEFAULT_MAX_VIOLATIONS=3).
 * Behavioral violations (git_protected, write_protected, bash_destructive, frozen) continue
 * to use trackViolation in tool-guard.ts and are unaffected by verify failures.
 * Audit trail: verify-advance.ts has ZERO calls to trackViolation (confirmed by grep).
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
        ...(f.group ? { group: f.group } : {}),
        // 203_Bug Phase 2 (RC3): propagate the environmental-only marker
        ...(f.nonCountable === true ? { nonCountable: true } : {}),
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

  // Phase 9 Task 4: detect empty or parse-failed rule sets
  // When rule set is empty (rulesParsed=false) or parse fails (parseError exists),
  // use the shared function to display actionable "only legal next step" message
  const isEmptyOrParseFailed = verifyResult.rulesParsed === false || !!verifyResult.parseError;

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
      onStageChanged: buildOnStageChangedCallback(ctx, config),
    });

    const failureSummary = verifyFailures
      .map((f) => formatFailure(f))
      .join("; ");

    return {
      success: false,
      passed: false,
      message: `Verification config error — frozen. Use the decision menu to proceed: ${failureSummary}`,
      failures: verifyFailures,
    };
  }

  // 203_Bug Phase 2 (RC3): ENVIRONMENTAL-ONLY downgrade — when every failure
  // is structurally unsatisfiable for the current stage (managed-path tree
  // dirt), persist the failures but DO NOT count them against verifyAttempts
  // (no overflow freeze). Mirrors the isConfigError short-circuit above.
  if (config && isEnvironmentalOnly(verifyFailures)) {
    ctx.session.updateMeta({
      verifyFailures,
    });

    const guidance = envGuidance(verifyFailures);
    // Stable signature: pipeline + stage + failure identity. A changed failure
    // set always re-emits; identical repeats are damped by the window.
    const feedbackKey = [
      meta.pipelineId ?? "",
      stageName,
      verifyFailures.map((f) => `${f.ruleType}:${f.detail}`).sort().join(";"),
    ].join("|");

    if (shouldEmitEnvBlockedFeedback(feedbackKey, now)) {
      await writeAuditLog("auto_verify_env_blocked", {
        pipelineId: meta.pipelineId,
        stage: stageName,
        method,
        failureCount: String(verifyFailures.length),
        failureTypes: verifyFailures.map((f) => f.ruleType).join(","),
        details: verifyFailures.map((f) => f.detail).join("; "),
      }, "warn");

      ui?.notify(ctx, guidance);

      // 203_Bug Phase 2 (review fix): mirror the ordinary `verify_fail_wake`
      // channel. In hook mode the TUI notify alone leaves the agent feedback-
      // blind, so the pipeline neither advances nor freezes — an invisible
      // stall. Wake the model with the same guidance (tool mode returns it in
      // the structured response instead).
      if (method === "rule" && ctx.pi && typeof ctx.pi.sendUserMessage === "function") {
        try {
          ctx.pi.sendUserMessage(guidance, { deliverAs: "followUp" });
          await writeAuditLog("verify_env_blocked_wake", {
            pipelineId: meta.pipelineId,
            stage: stageName,
            method,
            failureCount: String(verifyFailures.length),
          });
        } catch (err) {
          await writeAuditLog("verify_env_blocked_wake_failed", {
            pipelineId: meta.pipelineId,
            stage: stageName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return {
      success: false,
      passed: false,
      message: guidance,
      failures: verifyFailures,
    };
  }

  const updatedVerifyAttempts = (meta.verifyAttempts || 0) + 1;
  // 194 Phase 3 (C5): a bound failure record is one strict commit carrying the
  // dedup result key — the SAME result is counted once across the hook and
  // tool paths, and consumption/wake stay untouched by a failure record.
  const freshForAnchor = ctx.session.getMeta() ?? meta;
  const boundRunNow = boundActiveRun(freshForAnchor, stageName);
  const failKey = boundRunNow !== null
    ? computeResultKey({
        runId: boundRunNow.binding.runId,
        declarationRevision: boundRunNow.declaration?.revision,
        inputFingerprints: [
          `${stageName}|${verifyFailures.map((f) => `${f.ruleType}:${f.detail}`).sort().join(";")}`,
        ],
      })
    : "";
  const boundFail = boundRunNow !== null
    ? commitBoundFailureRecord({
        session: ctx.session,
        meta: freshForAnchor,
        sourceStage: stageName,
        failurePatch: { verifyAttempts: updatedVerifyAttempts, verifyFailures },
        runtimeCtx: ctx,
        resultKey: failKey,
      })
    : ({ status: "not-bound" } as const);
  if (boundFail.status === "refused") {
    await safeWriteAuditLog("transition_commit", {
      action: "bound_failure_refused",
      stage: stageName,
      method,
      reason: boundFail.reason,
    }, "warn");
    return {
      success: false,
      passed: false,
      message: `Bound failure record refused (${boundFail.reason}). Nothing was recorded; the run stays pending.`,
      failures: verifyFailures,
    };
  }
  if (boundFail.status === "duplicate") {
    // Same verified input already recorded once — no second increment, no
    // second wake, no budget churn (plan Phase 3 rule 6).
    await safeWriteAuditLog("transition_commit", {
      action: "bound_failure_deduped",
      stage: stageName,
      method,
      resultKey: failKey.slice(0, 120),
    });
    return {
      success: false,
      passed: false,
      message: `Verification failure already recorded for this input (deduplicated). Fix the artifacts and verify fresh input.`,
      failures: verifyFailures,
    };
  }
  if (boundFail.status !== "persisted") {
    ctx.session.updateMeta({
      verifyAttempts: updatedVerifyAttempts,
      verifyFailures,
    });
  }

  await writeAuditLog("auto_verify_fail", {
    pipelineId: meta.pipelineId,
    stage: stageName,
    method,
    failureCount: String(verifyFailures.length),
    failureTypes: verifyFailures.map((f) => f.ruleType).join(","),
    details: verifyFailures.map((f) => f.detail).join("; "),
    rulesSource: verifyResult?.rulesSource ?? "",
    rulesParsed: verifyResult?.rulesParsed ?? false,
    selfVerifySkip: verifyResult?.selfVerifySkip ?? false,
  }, "warn");

  const failureSummary = verifyFailures
    .map((f) => formatFailure(f))
    .join("; ");

  // 193 Phase 0 (task 4): a design-review REPORT format defect carries the full
  // corrective template (identity rows + four required sections + shape example)
  // instead of the generic "follow the SKILL format" hint, which never told the
  // model WHAT the current report was missing. Identity values come from the
  // TRUSTED persisted context, never reverse-inferred from failure prose.
  const reportFeedback = buildDesignReviewReportFeedback({
    meta,
    stageName,
    failures: verifyFailures,
  });
  if (reportFeedback) {
    await safeWriteAuditLog("design_review_report_feedback", {
      pipelineId: meta.pipelineId,
      stage: "report_contract",
      method,
      reportDoc: reportFeedback.reportDoc,
      defectCount: String(reportFeedback.failures.length),
      defects: reportFeedback.failures.join("; ").slice(0, 500),
    }, "warn");
  }

  // 204 Phase 3: a PLAN DOCUMENT format defect gets the exact expected path and
  // the non-conforming candidates already on disk, instead of the generic
  // "follow the SKILL output format" hint. Report feedback keeps priority.
  const planFeedback = await buildPlanDocFeedback({
    config,
    meta,
    stageName,
    failures: verifyFailures,
  });
  if (planFeedback) {
    await safeWriteAuditLog("plan_doc_feedback", {
      pipelineId: meta.pipelineId,
      stage: stageName,
      method,
      planDoc: planFeedback.planDoc,
      candidateCount: String(planFeedback.candidates.length),
      // 204 fix: an unreadable plan-doc directory is a different incident from
      // "no plan doc written yet" and must be diagnosable from the audit alone.
      scanFailed: String(planFeedback.scanFailed),
    }, "warn");
  }

  // One corrective text for every consumer below (report wins over plan).
  //
  // 204 invariant (review issue 3): the `??` precedence is UNCONSTRUCTIBLE as a
  // both-present case, not merely untested. `buildDesignReviewReportFeedback()`
  // can only fire on the design-review stages and `buildPlanDocFeedback()` can
  // only fire when `stageName === "plan"`, so at most one of the two is ever
  // non-null here. Do NOT "fix" the ordering by adding a precedence test — a
  // test for it cannot exist. Keep the stage gates in those two builders as the
  // single source of this contract.
  const correctiveMessage = reportFeedback?.message ?? planFeedback?.message;
  let failLabel = "verify failed";
  if (planFeedback) failLabel = "plan doc invalid";
  if (reportFeedback) failLabel = "report format invalid";

  // TUI failure output (gated by output.pipelineStage)
  ui?.fail(ctx, stageName, failLabel);

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
        onStageChanged: buildOnStageChangedCallback(ctx, config),
      });
      // H2 fix: return immediately after freeze to prevent fall-through
      // to the wake-model code block below. Overflow freeze hands control
      // to the user (decision menu); waking the model would interfere.
      // 193 Phase 0: the frozen menu hands control to the human, so the report
      // template is surfaced through the return message only (never a wake).
      return {
        success: false,
        passed: false,
        message: isEmptyOrParseFailed
          ? describeEmptyOrInvalidRuleSet(stageName, verifyResult.rulesSource, verifyResult.parseError)
          : correctiveMessage
          ? `Verification failed and the verify budget is exhausted — pipeline frozen. ${correctiveMessage}`
          : `Verification failed for "${stageName}" (attempt overflow — frozen): ${failureSummary}`,
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
        isEmptyOrParseFailed
          ? describeEmptyOrInvalidRuleSet(stageName, verifyResult.rulesSource, verifyResult.parseError)
          : correctiveMessage
          ? correctiveMessage
          : `Verification failed for "${stageName}": ${failureSummary}. Fix the issues and re-run verification. Please strictly follow the SKILL output format requirements.`,
        { deliverAs: "followUp" },
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
  } else if (method === "rule" && correctiveMessage) {
    // Hook path with no pi wake channel: the corrective template would otherwise
    // never reach the model, so surface it through the UI notification path.
    ctx.ui?.notify(correctiveMessage);
  }

  return {
    success: false,
    passed: false,
    message: isEmptyOrParseFailed
      ? describeEmptyOrInvalidRuleSet(stageName, verifyResult.rulesSource, verifyResult.parseError)
      : correctiveMessage
      ? `${correctiveMessage}`
      : `Verification failed for "${stageName}": ${failureSummary}. Please strictly follow the SKILL output format requirements.`,
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
  const clearedMeta = { ...meta, advancedThisTurn: undefined, reviewConclusionDeclared: undefined };

  await applyVerifyPass(ctx, clearedMeta, fromStage, toStage, verifyResult, {
    method: "rule",
    handleTerminal: false,
    returnResult: false,
    ui: pipelineUI,
    skipPassAudit: options?.skipPassAudit,
  });

  // G6 (188): Spawn subagent BEFORE audit writes to close the race window where
  // owner settle fires between currentStage update and pendingSpawns write.
  // When spawn succeeds (RPC or fallback), skip the generic wake to avoid dual execution.
  const freshMeta = ctx.session.getMeta() ?? meta;
  if (toStage && toStage !== "completed") {
    const spawnResult = await spawnStageSubagent(ctx.pi, config, toStage, freshMeta, {
      ui: { notify: (msg: string) => { ctx.ui?.notify?.(msg); } },
      session: ctx.session,
      runtimeCtx: ctx,
    });

    if (spawnResult.dispatchOutcome === "conflict_blocked") {
      // 195 Phase 2: configuration conflict — UI already notified, skip wake/retry
      await writeStageAudit(config, "stage_advance", clearedMeta, {
        fromStage,
        toStage,
        method: "hook_auto_advance",
      });
      const { emitDispatchConflictBlocked } = await import("../utils/dispatch-conflict-audit");
      await emitDispatchConflictBlocked("auto_advance", {
        pipelineId: meta.pipelineId,
        fromStage,
        toStage,
        reason: "configuration_conflict",
      });
      return;
    }

    if (spawnResult.spawned || spawnResult.fallback || spawnResult.deferred) {
      // Subagent spawned or deferred — write audit after spawn to maintain ordering.
      await writeStageAudit(config, "stage_advance", clearedMeta, {
        fromStage,
        toStage,
        method: "hook_auto_advance",
      });
      // Subagent spawned or deferred — skip generic wake to prevent dual execution.
      // deferred means the spawn is queued and will execute once the old twin settles;
      // waking the owner now would cause dual execution with the pending dequeue.
      await writeAuditLog("auto_advance_wake_skipped", {
        pipelineId: meta.pipelineId,
        fromStage,
        toStage,
        reason: spawnResult.deferred ? "subagent_deferred" : "subagent_spawned",
      });
      return;
    }
  }

  // Stage audit (when spawn did not fire)
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

  // Phase 2 / 179 (G8): chain-terminal owner wake.
  // When the auto-advance chain reaches a terminal point (completed / no next
  // stage), no subagent is spawned and the owner would otherwise never learn the
  // chain ended. Inject a chain summary so the owner can review and report.
  if (!toStage || toStage === "completed") {
    await wakeOwnerOnChainTerminal(ctx, freshMeta, fromStage, toStage);
  }

  // Wake next stage via pi.sendUserMessage (only reached when spawn did not fire)
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
        { deliverAs: "followUp" },
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
 * Phase 2 / 179 (G8): Wakes the owner when the auto-advance chain reaches a
 * terminal stage (completed / no next stage configured).
 *
 * The chain counts as terminated only when there is no unconsumed pending spawn
 * (otherwise it is still in flight). Fail-open: never throws.
 *
 * @param ctx - Session/pi context
 * @param meta - Fresh metadata (post-advance, includes stageVisitOrder)
 * @param fromStage - The stage that just completed
 * @param toStage - The terminal stage (null when no next stage is configured)
 */
async function wakeOwnerOnChainTerminal(
  ctx: VerifyAdvanceCtx,
  meta: SessionMeta,
  fromStage: PipelineStage,
  toStage: PipelineStage | null,
): Promise<void> {
  // Dedup: an unconsumed pending spawn means the chain has not actually ended.
  if (meta.pendingSpawns && Object.keys(meta.pendingSpawns).length > 0) {
    await writeAuditLog("chain_terminal_wake_skipped", {
      pipelineId: meta.pipelineId,
      fromStage,
      reason: "pending_spawns",
    });
    return;
  }

  const pi = ctx.pi;
  if (!pi || typeof pi.sendUserMessage !== "function") {
    await writeAuditLog("chain_terminal_wake_skipped", {
      pipelineId: meta.pipelineId,
      fromStage,
      reason: "pi_unavailable",
    });
    return;
  }

  const visits = (meta.stageVisitOrder ?? []).join(" → ");
  const terminalStage = toStage ?? "completed";

  // Build pending-human-action hints so the owner knows what to review next.
  const pendingHints: string[] = [];
  if (meta.confirmGateReask && meta.confirmGateReask.count > 0) {
    pendingHints.push(`confirm gate pending on "${meta.confirmGateReask.stage}" (re-ask count: ${meta.confirmGateReask.count})`);
  }
  if (meta.verifyFailures && meta.verifyFailures.length > 0) {
    const details = meta.verifyFailures.map((f) => `[${f.group}][${f.ruleType}] ${f.detail}`).join("; ");
    pendingHints.push(`verify failures: ${details}`);
  }
  // Note: pendingSpawns is intentionally NOT checked here because the function
  // returns early at the top (lines 550-557) when pendingSpawns is non-empty,
  // so this branch would be unreachable.

  const actionHint = pendingHints.length > 0
    ? ` Pending human actions: ${pendingHints.join(" | ")}.`
    : "";
  const summary =
    `Pipeline chain reached its terminal stage "${terminalStage}". ` +
    `Stage visit order: ${visits || fromStage}. ` +
    `Review the final deliverables and report the outcome to the user.` +
    actionHint;
  try {
    pi.sendUserMessage(summary, { deliverAs: "followUp" });
    await writeAuditLog("chain_terminal_wake", {
      pipelineId: meta.pipelineId,
      fromStage,
      terminalStage,
      stageVisitOrder: visits,
      ...(pendingHints.length > 0 ? { pendingActions: pendingHints.join(" | ") } : {}),
    });
  } catch (err) {
    await writeAuditLog("chain_terminal_wake_failed", {
      pipelineId: meta.pipelineId,
      fromStage,
      error: err instanceof Error ? err.message : String(err),
    }, "warn");
  }
}

