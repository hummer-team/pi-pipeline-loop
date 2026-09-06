/**
 * @module flow-state
 * Unified flow-state helpers for the pipeline blocking/freeze model.
 *
 * Provides a single source of truth for:
 * - Reading normalized flow state (getFlowState)
 * - Checking if the pipeline is frozen (isFrozen)
 * - Building the decision menu for the TUI (buildDecisionMenu)
 * - Executing a user decision (executeDecision)
 * - Freezing + prompting the user (freezeAndPrompt)
 *
 * All blocking entries (loop-breaker, verify-advance, loop-checker, handoff)
 * converge on freezeAndPrompt, ensuring consistent state transitions and audit.
 */

import type { PipelineConfig, SessionMeta, FlowState, PipelineStage } from "../types";
import { safeWriteAuditLog } from "../utils/auditLog";
import { maybeCompactOnPipelineCompleted } from "./terminal-compact";
import type { TerminalCompactCtx } from "./terminal-compact";
import { DEFAULT_DECISION_SHORTCUT, DECISION_DISMISS_INTERRUPT_MS } from "../constants";

// ─── Context Interface ──────────────────────────────────────────────────────

/**
 * Minimal context interface required by flow-state helpers.
 * Compatible with RuntimeCtx and test mock contexts.
 * Phase 4 (169): _ctx added for terminal compact wiring (W3).
 *
 * Note: _ctx type is re-exported from TerminalCompactCtx["_ctx"] (type-only import)
 * to avoid structural duplication and eliminate strict-invariance incompatibilities
 * between `onComplete: (r: unknown) => void` (here) and `(result: CompactResult) => void`
 * (terminal-compact). The type-only import has zero runtime cost and does not introduce
 * a circular dependency.
 */
export interface FlowStateCtx {
  session: {
    getMeta: () => SessionMeta | undefined;
    updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
  };
  ui?: {
    select?: (message: string, options: string[]) => Promise<string | undefined>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    notify?: (msg: string, ...args: any[]) => void;
  };
  /** @internal ExtensionContext for terminal compact (W3 wiring). Optional for backward compat. */
  _ctx?: TerminalCompactCtx["_ctx"];
}

// ─── Decision Types ─────────────────────────────────────────────────────────

/** User decision identifiers for the pipeline decision menu. */
export type PipelineDecision = "resume" | "skip" | "rollback" | "restart" | "abort";

/** Decision menu labels (English, matching TUI display). */
const DECISION_LABELS: Record<PipelineDecision, string> = {
  resume: "Resume",
  skip: "Skip",
  rollback: "Rollback",
  restart: "Restart & New",
  abort: "Abort & Exit",
};

// ─── getFlowState ───────────────────────────────────────────────────────────

/**
 * Returns the normalized FlowState for the given SessionMeta.
 *
 * Resolution order:
 * 1. If `meta.flowState` is explicitly set → use it.
 * 2. If `meta.terminated === true` (legacy) → map to "blocked".
 * 3. Otherwise → "running" (default).
 */
export function getFlowState(meta: SessionMeta): FlowState {
  if (meta.flowState) return meta.flowState;
  if (meta.terminated === true) return "blocked";
  return "running";
}

// ─── isFrozen ───────────────────────────────────────────────────────────────

/**
 * Returns true if the pipeline is in a frozen state where agent tools
 * should be blocked and verification should be short-circuited.
 *
 * Frozen conditions:
 * - flowState === "blocked"
 * - flowState === "aborted"
 * - currentStage === "awaiting_human" (legacy freeze point)
 */
export function isFrozen(meta: SessionMeta): boolean {
  const fs = getFlowState(meta);
  return fs === "blocked" || fs === "aborted" || meta.currentStage === "awaiting_human";
}

// ─── buildDecisionMenu ──────────────────────────────────────────────────────

/**
 * Builds the decision menu items for the TUI select dialog.
 *
 * - blocked / awaiting_human → 5 items (resume/skip/rollback/restart/abort)
 * - running → 2 items (restart/abort)
 * - aborted → null (do not show menu)
 */
export function buildDecisionMenu(meta: SessionMeta): string[] | null {
  const fs = getFlowState(meta);

  if (fs === "aborted") return null;

  if (fs === "blocked" || meta.currentStage === "awaiting_human") {
    return [
      DECISION_LABELS.resume,
      DECISION_LABELS.skip,
      DECISION_LABELS.rollback,
      DECISION_LABELS.restart,
      DECISION_LABELS.abort,
    ];
  }

  // running
  return [
    DECISION_LABELS.restart,
    DECISION_LABELS.abort,
  ];
}

/** Reverse lookup: label → decision key. */
export function labelToDecision(label: string): PipelineDecision | undefined {
  for (const [key, val] of Object.entries(DECISION_LABELS)) {
    if (val === label) return key as PipelineDecision;
  }
  return undefined;
}

// ─── executeDecision ────────────────────────────────────────────────────────

/**
 * Executes a user decision against the pipeline state.
 *
 * Each decision mutates SessionMeta via ctx.session.updateMeta and writes
 * a `pipeline_decision` audit log entry.
 *
 * @param ctx - FlowStateCtx with session access
 * @param meta - Current SessionMeta snapshot
 * @param decision - The decision to execute
 * @param config - PipelineConfig for stage lookups
 * @param opts - Optional overrides (source tag for audit differentiation)
 * @returns Result object with success flag and message
 */
export async function executeDecision(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  decision: PipelineDecision,
  config: PipelineConfig,
  opts?: { source?: string },
): Promise<{ success: boolean; message: string }> {
  const fromStage = meta.currentStage;

  switch (decision) {
    case "resume": {
      const toStage = meta.currentStage === "awaiting_human"
        ? (meta.previousStage ?? "clarify")
        : meta.currentStage;

      ctx.session.updateMeta({
        flowState: "running",
        blockedReason: undefined,
        loopCount: 0,
        verifyAttempts: 0,
        verifyFailures: [],
        violations: [],
        ...(meta.currentStage === "awaiting_human"
          ? { currentStage: meta.previousStage ?? "clarify", previousStage: undefined }
          : {}),
      });

      await safeWriteAuditLog("pipeline_decision", {
        pipelineId: meta.pipelineId,
        decision,
        fromStage,
        toStage,
        reason: meta.blockedReason ?? "",
        ...(opts?.source ? { source: opts.source } : {}),
      });

      return { success: true, message: `Pipeline resumed at stage "${toStage}".` };
    }

    case "skip": {
      if (!isFrozen(meta)) {
        return { success: false, message: "Cannot skip: pipeline is not frozen." };
      }

      const stageConfig = config.stages[meta.currentStage];
      const toStage: PipelineStage = stageConfig?.nextStage ?? "completed";
      const prevStage = meta.currentStage;

      const summariesPatch = meta.summaries[prevStage]
        ? {
            summaries: {
              ...meta.summaries,
              [prevStage]: { ...meta.summaries[prevStage], status: "skipped" as const },
            },
          }
        : {};

      ctx.session.updateMeta({
        previousStage: prevStage,
        currentStage: toStage,
        stageStartTime: Date.now(),
        flowState: "running",
        blockedReason: undefined,
        loopCount: 0,
        currentStepIndex: 0,
        verifyAttempts: 0,
        verifyFailures: [],
        verifyConfigError: undefined,
        violations: [],
        ...summariesPatch,
      });

      await safeWriteAuditLog("pipeline_decision", {
        pipelineId: meta.pipelineId,
        decision,
        fromStage: prevStage,
        toStage,
        reason: meta.blockedReason ?? "",
      });

      // Phase 4 (169) W3: When skip targets completed, trigger terminal compaction.
      // The helper's internal isIdle guard handles the shortcut-key scenario.
      // FlowStateCtx._ctx and TerminalCompactCtx._ctx share the same type
      // (re-exported via type-only import), so no cast is required.
      if (toStage === "completed" && ctx._ctx) {
        await maybeCompactOnPipelineCompleted(
          { session: ctx.session, ui: ctx.ui, _ctx: ctx._ctx },
          config,
        );
      }

      return { success: true, message: `Skipped "${prevStage}", advanced to "${toStage}".` };
    }

    case "rollback": {
      if (!isFrozen(meta)) {
        return { success: false, message: "Cannot rollback: pipeline is not frozen." };
      }

      const toStage: PipelineStage = meta.previousStage ?? "clarify";
      const prevStage = meta.currentStage;

      const summariesPatch = meta.summaries[toStage]
        ? {
            summaries: {
              ...meta.summaries,
              [toStage]: { ...meta.summaries[toStage], status: "invalid" as const },
            },
          }
        : {};

      ctx.session.updateMeta({
        currentStage: toStage,
        previousStage: undefined,
        stageStartTime: Date.now(),
        flowState: "running",
        blockedReason: undefined,
        loopCount: 0,
        currentStepIndex: 0,
        verifyAttempts: 0,
        verifyFailures: [],
        verifyConfigError: undefined,
        violations: [],
        ...summariesPatch,
      });

      await safeWriteAuditLog("pipeline_decision", {
        pipelineId: meta.pipelineId,
        decision,
        fromStage: prevStage,
        toStage,
        reason: meta.blockedReason ?? "",
      });

      return { success: true, message: `Rolled back from "${prevStage}" to "${toStage}".` };
    }

    case "restart": {
      const newPipelineId = `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      ctx.session.updateMeta({
        pipelineId: newPipelineId,
        currentStage: "clarify",
        previousStage: undefined,
        stageStartTime: Date.now(),
        flowState: "running",
        blockedReason: undefined,
        terminated: undefined,
        terminateReason: undefined,
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        verifyAttempts: 0,
        verifyFailures: [],
        verifyConfigError: undefined,
        violations: [],
        // Phase 4 (169): clear terminal compaction flag on restart
        terminalCompact: undefined,
        // Preserve: requirementDoc, domain (spread from meta by updateMeta merge)
      });

      await safeWriteAuditLog("pipeline_decision", {
        pipelineId: meta.pipelineId,
        decision,
        fromStage: "restart",
        toStage: "clarify",
        newPipelineId,
        reason: meta.blockedReason ?? "",
      });

      return { success: true, message: `Pipeline restarted as "${newPipelineId}" at stage "clarify".` };
    }

    case "abort": {
      ctx.session.updateMeta({
        flowState: "aborted",
        terminateReason: "user_abort",
      });

      // Phase 1 (171) C14/C15: abort decision nextStage derived from config chain
      // (consistent with markPipelineAborted and freezeAndPrompt)
      const abortNextStage = config.stages[fromStage]?.nextStage ?? null;
      const abortDocHint = meta.requirementDoc ?? "<requirement-doc>";
      // Phase 1 (171) C14: enriched audit with terminateReason, nextStage, nextAction
      // (Menu Abort = user-initiated, no notify needed — command layer echoes result)
      await safeWriteAuditLog("pipeline_decision", {
        pipelineId: meta.pipelineId,
        decision,
        fromStage,
        toStage: "aborted",
        reason: meta.blockedReason ?? "",
        terminateReason: "user_abort",
        nextStage: abortNextStage ?? "null",
        nextAction: `run /pipeline-start ${abortDocHint} to resume at "${fromStage}"`,
      });

      return { success: true, message: "Pipeline aborted. Use /pipeline-start to begin a new run." };
    }

    default:
      return { success: false, message: `Unknown decision: "${String(decision)}".` };
  }
}

// ─── isTerminalCompleted ────────────────────────────────────────────────────

/**
 * Returns true when the pipeline has reached the completed terminal state.
 * Used as a central guard to protect completed pipelines from being overwritten
 * by abort/reset logic (e.g. session_shutdown quit/new, session_start stale recovery).
 *
 * @param meta - Current session metadata (may be undefined)
 * @returns true if currentStage === "completed"
 */
export function isTerminalCompleted(meta: SessionMeta | undefined): boolean {
  return meta?.currentStage === "completed";
}

// ─── formatAbortedNotifyText ────────────────────────────────────────────────

/**
 * Builds the user-visible notification text for an aborted pipeline.
 * Shared across markPipelineAborted (notify on transition), tool-guard
 * (frozen rejection reason for aborted state), and session-starter
 * (resume notify). Ensures text consistency across all abort-related outputs.
 *
 * @param currentStage - The stage at which the pipeline was aborted
 * @param reason - Machine-readable abort reason (e.g. "session_quit")
 * @param requirementDoc - Bound requirement doc path (or undefined)
 */
export function formatAbortedNotifyText(
  currentStage: string,
  reason: string,
  requirementDoc?: string,
): string {
  const docHint = requirementDoc ?? "<requirement-doc>";
  return `Pipeline aborted at "${currentStage}" (${reason}). Run /pipeline-start ${docHint} to resume.`;
}

// ─── markPipelineAborted ────────────────────────────────────────────────────

/**
 * Optional parameters for markPipelineAborted.
 * Phase 1 (171): C14-C16 frozen audit integrity.
 */
export interface MarkAbortedOpts {
  /** Trigger identity fields for audit (which session/event caused the abort) */
  trigger?: {
    sessionFile?: string;
    isSubagent?: boolean;
    eventReason?: string;
  };
  /** Pipeline config for nextStage computation (information field) */
  config?: PipelineConfig;
}

/**
 * Resets the pipeline flowState to "aborted" and writes an audit log.
 *
 * Shared by session_shutdown (on quit/new) and session_start (stale startup recovery)
 * to ensure flowState never remains "running" after the process exits or restarts.
 *
 * Convention: only mutates flowState and terminateReason; preserves pipelineId,
 * currentStage, summaries, domain, requirementDoc for audit and restart hint.
 *
 * Terminal guard: when the pipeline is already completed, this function skips
 * the flowState/terminateReason mutation and writes a skip audit instead,
 * preventing the completed terminal state from being overwritten.
 *
 * Phase 1 (171): Enriched audit with nextStage/nextAction/trigger fields.
 * On real transition (not idempotent skip or completed guard), emits ui.notify
 * with stage/reason/resume hint (C16).
 *
 * @param ctx - FlowStateCtx with session access
 * @param reason - Machine-readable abort reason (e.g. "session_quit", "stale_startup")
 * @param opts - Optional trigger identity and config for audit enrichment
 */
export async function markPipelineAborted(
  ctx: FlowStateCtx,
  reason: string,
  opts?: MarkAbortedOpts,
): Promise<void> {
  const meta = ctx.session.getMeta();

  // Terminal guard: completed pipelines must not be overwritten
  if (isTerminalCompleted(meta)) {
    await safeWriteAuditLog("pipeline_abort_skipped_completed", {
      pipelineId: meta?.pipelineId ?? "unknown",
      reason,
    });
    return;
  }

  // Phase 3 (170) ⑦: Idempotent abort — skip when already aborted with the same reason.
  // Eliminates duplicate audits from parent+child double-trigger and repeated quit events.
  if (meta && getFlowState(meta) === "aborted" && meta.terminateReason === reason) {
    await safeWriteAuditLog("pipeline_abort_skipped_idempotent", {
      pipelineId: meta.pipelineId ?? "unknown",
      reason,
    });
    return;
  }

  // Phase 1 (171): compute nextStage (information field, does NOT advance) and nextAction
  const stage = meta?.currentStage ?? "unknown";
  const nextStage = opts?.config?.stages[meta?.currentStage as PipelineStage]?.nextStage ?? null;
  const docHint = meta?.requirementDoc ?? "<requirement-doc>";
  const nextAction = `run /pipeline-start ${docHint} to resume at "${stage}"`;

  ctx.session.updateMeta({
    flowState: "aborted",
    terminateReason: reason,
  });

  // Enriched audit with full frozen-transition fields (C14-C15)
  const auditFields: Record<string, string> = {
    pipelineId: meta?.pipelineId ?? "unknown",
    stage,
    currentStage: stage,
    nextStage: nextStage ?? "null",
    nextAction,
    reason,
  };

  // Trigger identity (only include when present — fail-open)
  if (opts?.trigger) {
    if (opts.trigger.sessionFile) auditFields.triggerSessionFile = opts.trigger.sessionFile;
    if (opts.trigger.isSubagent !== undefined) auditFields.triggerIsSubagent = String(opts.trigger.isSubagent);
    if (opts.trigger.eventReason) auditFields.triggerEventReason = opts.trigger.eventReason;
  }

  await safeWriteAuditLog("pipeline_session_aborted", auditFields);

  // Phase 1 (171) C16: notify user on real abort transition (not skip/guard)
  const notifyText = formatAbortedNotifyText(stage, reason, meta?.requirementDoc);
  ctx.ui?.notify?.(notifyText);
}

// ─── formatFrozenReason ──────────────────────────────────────────────────────

/**
 * Formats a human-readable frozen reason string from SessionMeta.
 * Combines blockedReason/terminateReason with the first 2 verifyFailures
 * (formatted as "[ruleType] detail") for diagnostic context.
 *
 * Truncates to maxLen characters and appends "…" when exceeded.
 *
 * @param meta - Current session metadata
 * @param maxLen - Maximum output length (default 200)
 * @returns Formatted reason string
 */
export function formatFrozenReason(meta: SessionMeta, maxLen = 200): string {
  const baseReason = meta.blockedReason ?? meta.terminateReason ?? "unknown";

  const failures = meta.verifyFailures ?? [];
  const failureParts: string[] = [];
  for (let i = 0; i < Math.min(failures.length, 2); i++) {
    const f = failures[i];
    failureParts.push(`[${f.ruleType}] ${f.detail}`);
  }

  let result = baseReason;
  if (failureParts.length > 0) {
    result = `${baseReason} (${failureParts.join("; ")})`;
  }

  if (result.length > maxLen) {
    // Respect maxLen as hard upper bound: slice to (maxLen-1) + "…" gives total = maxLen.
    // Use Array.from to avoid splitting multi-byte characters.
    const chars = Array.from(result);
    result = chars.slice(0, maxLen - 1).join("") + "…";
  }

  return result;
}

// ─── promptDecisionMenu ─────────────────────────────────────────────────────

/**
 * Prompts the user with the decision menu via TUI select.
 * Extracted from freezeAndPrompt so it can be reused by agent-settled
 * for re-prompting while the pipeline is already frozen (168 Phase 2).
 *
 * Behavior:
 * - Builds decision menu via buildDecisionMenu
 * - If UI available → shows select → executeDecision on choice / audit + notify on Esc
 * - If no UI → notify with frozen reason
 * - If aborted → no prompt
 *
 * @param ctx - FlowStateCtx with session and optional UI
 * @param meta - Current SessionMeta snapshot
 * @param config - PipelineConfig for stage lookups
 * @param opts - Optional overrides (ui for external callers)
 */
/**
 * Formats a hint message for the decision menu shortcut key.
 * Uses the configured `decisionShortcutKey` or falls back to DEFAULT_DECISION_SHORTCUT.
 * Single source for all three consumers: frozen notify, prompt-injector, and pipeline_blocked audit.
 *
 * @param config - Pipeline configuration
 * @returns Human-readable hint string like "Open the decision menu (press ctrl+enter) to proceed"
 */
export function formatDecisionMenuHint(config: PipelineConfig): string {
  const key = config.decisionShortcutKey ?? DEFAULT_DECISION_SHORTCUT;
  return `Open the decision menu (press ${key}) to proceed.`;
}

export type PromptDecisionOutcome = "cancelled" | "interrupted" | "decided" | "no-menu";

export async function promptDecisionMenu(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  config: PipelineConfig,
  opts?: { ui?: FlowStateCtx["ui"] },
): Promise<PromptDecisionOutcome> {
  const ui = opts?.ui ?? ctx.ui;
  const menu = buildDecisionMenu(meta);
  const tuiEnabled = config.output?.pipelineStage !== false;

  if (!menu) {
    // aborted → do not prompt
    return "no-menu";
  }

  if (ui?.select) {
    try {
      const reason = meta.blockedReason ?? meta.terminateReason ?? "unknown";
      const attemptAt = Date.now();
      const selection = await ui.select(
        `Pipeline blocked: ${reason}. Choose an action:`,
        menu,
      );

      if (selection === undefined) {
        const elapsed = Date.now() - attemptAt;

        // Phase 6 (172) G5: interrupt detection — if select resolved very quickly,
        // it was likely dismissed by streaming output (system interrupt), not user Esc.
        if (elapsed < DECISION_DISMISS_INTERRUPT_MS) {
          await safeWriteAuditLog("pipeline_decision_interrupted", {
            pipelineId: meta.pipelineId,
            stage: meta.currentStage,
            elapsedMs: String(elapsed),
          });
          return "interrupted";
        }

        // User pressed Esc — keep blocked, notify with reason
        // Fix: Esc (active cancel) stops the retry scheduler per plan P6 task 2.
        clearDecisionTimer(meta.pipelineId);
        await safeWriteAuditLog("pipeline_decision_cancelled", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
        });

        if (tuiEnabled) {
          const freshMeta = ctx.session.getMeta() ?? meta;
          ui.notify?.(
            `Pipeline frozen: ${formatFrozenReason(freshMeta)}. ${formatDecisionMenuHint(config)}`,
          );
        }
        return "cancelled";
      }

      const decision = labelToDecision(selection);
      if (decision) {
        // Re-read meta after potential UI delay
        const freshMeta = ctx.session.getMeta() ?? meta;
        await executeDecision(ctx, freshMeta, decision, config);
      }
      return "decided";
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await safeWriteAuditLog("pipeline_decision_error", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        error: errMsg,
      }, "error");
      return "no-menu";
    }
  } else {
    // No UI available — notify via available channel (gated by pipelineStage)
    if (tuiEnabled) {
      const frozenMeta = ctx.session.getMeta() ?? meta;
      ui?.notify?.(
        `Pipeline frozen: ${formatFrozenReason(frozenMeta)} ${formatDecisionMenuHint(config)}`,
      );
    }
    return "no-menu";
  }
}

// ─── Phase 6 (172) G5: Decision retry scheduler ──────────────────────────────

/**
 * Module-level timer registry for decision menu retry scheduling.
 * Maps pipelineId to its active retry timer. Single implementation point
 * prevents double-scheduling and enables cleanup on shutdown.
 */
const decisionRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Base delay for the first retry (ms). Subsequent retries use exponential backoff. */
const RETRY_BASE_DELAY_MS = 5000;
/** Maximum delay cap for exponential backoff (ms). */
const RETRY_MAX_DELAY_MS = 60000;
/** Backoff multiplier for each retry. */
const RETRY_BACKOFF_FACTOR = 2;

/**
 * Schedules an exponential-backoff retry for the decision menu when the pipeline
 * remains frozen after an interrupted select. Only one timer per pipelineId at a time.
 *
 * @param ctx - FlowStateCtx for re-prompting
 * @param meta - Current SessionMeta
 * @param config - Pipeline configuration
 * @param attempt - Current attempt number (for backoff calculation)
 */
export function scheduleDecisionRetry(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  config: PipelineConfig,
  attempt: number = 1,
): void {
  const pipelineId = meta.pipelineId;
  // Clear existing timer for this pipeline (prevent stacking)
  clearDecisionTimer(pipelineId);

  const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_MS);

  const timer = setTimeout(async () => {
    decisionRetryTimers.delete(pipelineId);

    // Re-read meta: if no longer frozen, self-clean
    const freshMeta = ctx.session.getMeta() as SessionMeta | undefined;
    if (!freshMeta || !isFrozen(freshMeta)) {
      return;
    }

    // Re-prompt (single in-flight select, no stacking)
    const outcome = await promptDecisionMenu(ctx, freshMeta, config);

    // Fix: cancelled (user Esc) or decided (user chose action) → stop retry loop.
    // Only interrupted (streaming dismiss) continues the retry cycle.
    if (outcome === "cancelled" || outcome === "decided") {
      return;
    }

    // If still frozen after prompt, schedule next retry
    const postMeta = ctx.session.getMeta() as SessionMeta | undefined;
    if (postMeta && isFrozen(postMeta)) {
      scheduleDecisionRetry(ctx, postMeta, config, attempt + 1);
    }
  }, delay);

  decisionRetryTimers.set(pipelineId, timer);
}

/**
 * Clears the decision retry timer for a specific pipeline.
 */
export function clearDecisionTimer(pipelineId: string): void {
  const timer = decisionRetryTimers.get(pipelineId);
  if (timer) {
    clearTimeout(timer);
    decisionRetryTimers.delete(pipelineId);
  }
}

/**
 * Clears all decision retry timers. Called on session shutdown to prevent leaks.
 */
export function clearAllDecisionTimers(): void {
  for (const [id, timer] of decisionRetryTimers) {
    clearTimeout(timer);
  }
  decisionRetryTimers.clear();
}

// ─── freezeAndPrompt ────────────────────────────────────────────────────────

/**
 * Freezes the pipeline and prompts the user for a decision via TUI select.
 *
 * Idempotent: only transitions from "running" → "blocked" on the first call.
 * Subsequent calls (already blocked) skip the state mutation and do NOT
 * re-prompt — callers who want to re-trigger the menu while frozen should
 * invoke `promptDecisionMenu` directly.
 *
 * Behavior:
 * 1. If flowState is already blocked → return early (idempotent)
 * 2. If flowState is "running" → set flowState="blocked" + blockedReason=reason
 * 3. Write audit `pipeline_blocked` (warn)
 * 4. Delegate to `promptDecisionMenu` for the actual UI interaction
 *
 * @param ctx - FlowStateCtx with session and optional UI
 * @param meta - Current SessionMeta snapshot
 * @param reason - Machine-readable freeze reason (e.g. "loop_overflow")
 * @param config - PipelineConfig for stage lookups
 * @param opts - Optional overrides (ui for external callers)
 */
export async function freezeAndPrompt(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  reason: string,
  config: PipelineConfig,
  opts?: { ui?: FlowStateCtx["ui"] },
): Promise<void> {
  // Idempotent: only transition running → blocked, and only perform
  // audit + menu prompt on the transition moment (not on repeated calls).
  const currentState = getFlowState(meta);
  if (currentState !== "running") {
    // Already frozen/aborted — do not re-freeze, re-audit, or re-prompt.
    return;
  }

  ctx.session.updateMeta({
    flowState: "blocked",
    blockedReason: reason,
  });

  // Audit: pipeline blocked (warn level)
  // Phase 1 (171) C14: enriched with nextStage (information field) and nextAction
  const blockedNextStage = config.stages[meta.currentStage]?.nextStage ?? null;
  await safeWriteAuditLog("pipeline_blocked", {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    reason,
    nextStage: blockedNextStage ?? "null",
    nextAction: formatDecisionMenuHint(config),
  }, "warn");

  // Delegate to promptDecisionMenu for the UI interaction
  const frozenMeta = { ...meta, flowState: "blocked" as const, blockedReason: reason };
  // Fix: do NOT pre-schedule timer here — it would fire during the awaited first
  // prompt, creating a concurrent second select (stacking violation per review #1b).
  // Instead, if the first prompt returns "interrupted" (streaming dismiss < 1500ms),
  // arm the retry scheduler AFTER the prompt returns. This prevents stacking while
  // still ensuring the menu re-appears after streaming settles.
  const outcome = await promptDecisionMenu(ctx, frozenMeta, config, opts);
  if (outcome === "interrupted") {
    scheduleDecisionRetry(ctx, frozenMeta, config);
  }
}
