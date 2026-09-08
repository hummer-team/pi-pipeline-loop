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
import { DEFAULT_DECISION_SHORTCUT, DECISION_DISMISS_INTERRUPT_MS, CANONICAL_STAGE_ORDER } from "../constants";
import { registerSession } from "../utils/session-registry";
import { detectSessionRole } from "./session-role";
import type { RuntimeCtx } from "./runtime-ctx";

// ─── Role Detection Helper ──────────────────────────────────────────────────

/**
 * Phase 1 (173) C7: Build a minimal RuntimeCtx-like shape from FlowStateCtx
 * for session-role detection. FlowStateCtx._ctx is typed as a TerminalCompactCtx
 * subset but at runtime carries the full ExtensionContext (sessionManager etc.).
 *
 * The event field is not available in FlowStateCtx; fork detection is not
 * relevant for the decision-menu gate (fork is a session_start concept).
 *
 * Degradation: when _ctx or sessionManager is unavailable, detectSessionRole
 * returns isChild=false (conservative — treats as owner), matching the
 * established convention in session-role.ts:14-15.
 */
function buildRoleCtxForGate(ctx: FlowStateCtx): RuntimeCtx {
  return { _ctx: ctx._ctx } as unknown as RuntimeCtx;
}

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
export type PipelineDecision = "resume" | "skip" | "rollback" | "restart" | "abort" | "choose_stage";

/** Decision menu labels (English, matching TUI display). */
const DECISION_LABELS: Record<PipelineDecision, string> = {
  resume: "Resume",
  skip: "Skip",
  rollback: "Rollback",
  restart: "Restart & New",
  abort: "Abort & Exit",
  choose_stage: "Choose stage…",
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
      DECISION_LABELS.choose_stage,
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
  opts?: { source?: string; targetStage?: PipelineStage; basis?: string },
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
      // Phase 0 (173) C1: capture old pipelineId BEFORE updateMeta. Test mocks
      // mutate `meta` in place via Object.assign, so reading meta.pipelineId
      // after updateMeta would yield newPipelineId. Production updateMeta
      // (session-state) returns a fresh merged object and does not mutate the
      // input, but we normalize on the safe capture-before-mutation form so
      // clearDecisionTimer always targets the superseded pipeline.
      const oldPipelineId = meta.pipelineId;

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
        // Phase 3 (173) C10④: fromStage is the actual frozen stage, not hardcoded "restart"
        fromStage: fromStage,
        toStage: "clarify",
        newPipelineId,
        reason: meta.blockedReason ?? "",
        ...(opts?.source ? { source: opts.source } : {}),
      });

      // ─── Phase 0 (173) C1: restart rebind + stale timer cleanup ──────────
      // V5/V7 root fix — executeDecision is the ONLY channel that swaps
      // pipelineId without rebinding the session registry or clearing the
      // decision retry timer. All other pipelineId-changing sites already
      // handle this correctly:
      //   - /pipeline-start fresh      → pipeline-start.ts:679 registerSession
      //   - /pipeline-start adopt      → pipeline-start.ts:1063 registerSession
      //   - resume/skip/rollback/abort → no pipelineId swap, no rebind needed
      // Failure to rebind caused the 22:20:19 accident: new pipeline runs but
      // the owner session's registry entry still points at the superseded
      // (frozen) pipeline, so subagent JOINs resolve to the frozen flow and
      // every tool call is blocked. Failure to clear the timer caused orphaned
      // retries to keep firing against the old pipelineId (V7).
      clearDecisionTimer(oldPipelineId);
      // FlowStateCtx._ctx is a minimal TerminalCompactCtx subset (no sessionManager
      // typed); at runtime, when invoked from the plugin hooks, it IS the full
      // RuntimeCtx ExtensionContext which carries sessionManager. Mirror the
      // established cast pattern from tool-guard.ts:570-572 / session-starter.ts:315.
      const sm = ((ctx._ctx as unknown) as Record<string, unknown> | undefined)?.sessionManager as
        | { getSessionFile?: () => string } | undefined;
      const sessionFile = sm?.getSessionFile?.() ?? "";
      if (sessionFile) {
        await registerSession(config, sessionFile, newPipelineId);
      }
      // ─── end Phase 0 (173) C1 ────────────────────────────────────────────

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

    case "choose_stage": {
      if (!isFrozen(meta)) {
        return { success: false, message: "Cannot choose stage: pipeline is not frozen." };
      }

      const target = opts?.targetStage;
      if (!target) {
        return { success: false, message: "choose_stage requires targetStage option." };
      }

      const frozenStage = meta.currentStage;
      const fromIdx = CANONICAL_STAGE_ORDER.indexOf(frozenStage);
      const toIdx = CANONICAL_STAGE_ORDER.indexOf(target);

      // Clear counters and violations (same as resume/skip/rollback)
      const clearFields: Partial<SessionMeta> = {
        flowState: "running",
        blockedReason: undefined,
        loopCount: 0,
        currentStepIndex: 0,
        verifyAttempts: 0,
        verifyFailures: [],
        verifyConfigError: undefined,
        violations: [],
        currentStage: target,
        stageStartTime: Date.now(),
      };

      // Build summaries patch based on jump direction
      const summariesPatch: Partial<SessionMeta> = {};
      if (toIdx > fromIdx && fromIdx >= 0) {
        // Forward jump: mark skipped stages between frozen and target
        const skippedSummaries = { ...meta.summaries };
        for (let i = fromIdx + 1; i < toIdx; i++) {
          const stageName = CANONICAL_STAGE_ORDER[i] as PipelineStage;
          if (meta.summaries[stageName]) {
            skippedSummaries[stageName] = { ...meta.summaries[stageName], status: "skipped" as const };
          }
        }
        summariesPatch.summaries = skippedSummaries;
      } else if (toIdx < fromIdx && fromIdx >= 0) {
        // Backward jump: mark target stage as invalid
        if (meta.summaries[target]) {
          summariesPatch.summaries = {
            ...meta.summaries,
            [target]: { ...meta.summaries[target], status: "invalid" as const },
          };
        }
      }

      // Append target to stageVisitOrder
      const visitOrder = [...(meta.stageVisitOrder ?? []), target];
      clearFields.stageVisitOrder = visitOrder;

      // Preserve sessionAllowedWritePaths/Commands (same freeze event, continued run)
      ctx.session.updateMeta({ ...clearFields, ...summariesPatch });

      // Infer basis for audit — prefer the inference basis from the caller
      // (currentStage / stageVisitOrder / summaries / none), fall back to source-based heuristic
      const basis = opts?.basis ?? (opts?.source === "replay" ? "replay_inference" : "user_choice");

      await safeWriteAuditLog("pipeline_decision", {
        pipelineId: meta.pipelineId,
        decision,
        fromStage: frozenStage,
        toStage: target,
        reason: meta.blockedReason ?? "",
        basis,
        ...(opts?.source ? { source: opts.source } : {}),
      });

      // If target is completed, trigger terminal compaction
      if (target === "completed" && ctx._ctx) {
        await maybeCompactOnPipelineCompleted(
          { session: ctx.session, ui: ctx.ui, _ctx: ctx._ctx },
          config,
        );
      }

      return { success: true, message: `Pipeline resumed at stage "${target}" (chosen from "${frozenStage}").` };
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

// ─── inferResumeStage (Phase 3 / 173 C9) ────────────────────────────────────

/**
 * Infers the most likely resume stage from frozen pipeline metadata.
 *
 * Inference chain (first match wins):
 * 1. currentStage (if awaiting_human → use previousStage) — basis: "currentStage"
 * 2. stageVisitOrder last entry — basis: "stageVisitOrder"
 * 3. Highest valid summary's nextStage (via config chain) — basis: "summaries"
 * 4. null (no inference possible — caller should prompt user) — basis: "none"
 *
 * @param meta - Current session metadata
 * @param config - Pipeline configuration for stage chain lookup
 * @returns Object with inferred stage (or null) and the inference basis
 */
export function inferResumeStage(
  meta: SessionMeta,
  config: PipelineConfig,
): { stage: PipelineStage | null; basis: string } {
  // 1. currentStage (awaiting_human → previousStage)
  if (meta.currentStage === "awaiting_human" && meta.previousStage) {
    return { stage: meta.previousStage, basis: "currentStage" };
  }
  if (meta.currentStage && meta.currentStage !== "awaiting_human" && meta.currentStage !== "completed") {
    return { stage: meta.currentStage, basis: "currentStage" };
  }

  // 2. stageVisitOrder last entry
  if (meta.stageVisitOrder && meta.stageVisitOrder.length > 0) {
    const last = meta.stageVisitOrder[meta.stageVisitOrder.length - 1];
    if (last && last !== "completed") {
      return { stage: last, basis: "stageVisitOrder" };
    }
  }

  // 3. Highest valid summary's nextStage
  const stageOrder = CANONICAL_STAGE_ORDER;
  let highestValidIdx = -1;
  let highestValidStage: PipelineStage | null = null;
  for (const [stageName, summary] of Object.entries(meta.summaries)) {
    if (summary.status === "valid") {
      const idx = stageOrder.indexOf(stageName);
      if (idx > highestValidIdx) {
        highestValidIdx = idx;
        highestValidStage = stageName as PipelineStage;
      }
    }
  }
  if (highestValidStage && config.stages[highestValidStage]?.nextStage) {
    return { stage: config.stages[highestValidStage].nextStage, basis: "summaries" };
  }

  // 4. No inference possible
  return { stage: null, basis: "none" };
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
  opts?: { ui?: FlowStateCtx["ui"]; source?: string },
): Promise<PromptDecisionOutcome> {
  const ui = opts?.ui ?? ctx.ui;
  const menu = buildDecisionMenu(meta);
  const tuiEnabled = config.output?.pipelineStage !== false;

  if (!menu) {
    // aborted → do not prompt
    return "no-menu";
  }

  // Phase 1 (173) C7: Owner-only menu gate.
  // Child sessions must not present the decision menu — the owner side is
  // responsible for rendering (via settle re-popup, shortcut, replay, or start).
  // Detection degradation: missing _ctx/sessionManager → treat as owner (conservative).
  try {
    const { isChild } = detectSessionRole(buildRoleCtxForGate(ctx));
    if (isChild) {
      await safeWriteAuditLog("pipeline_menu_suppressed_child", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        ...(opts?.source ? { source: opts.source } : {}),
      });
      return "no-menu";
    }
  } catch {
    // Fail-open: role detection error → treat as owner (conservative, same as session-role.ts:14-15)
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

        // Phase 3 (173) C9: choose_stage → secondary menu
        if (decision === "choose_stage") {
          const inferenceResult = inferResumeStage(freshMeta, config);
          const inferred = inferenceResult.stage;
          const inferenceBasis = inferenceResult.basis;
          const stageChoices: PipelineStage[] = ["clarify", "plan", "develop", "review", "fix", "completed"];

          // Build secondary menu items with inferred stage first (if available)
          const menuItems: string[] = [];
          const orderedChoices: PipelineStage[] = [];
          if (inferred) {
            menuItems.push(`${inferred} (default)`);
            orderedChoices.push(inferred);
          }
          for (const s of stageChoices) {
            if (s !== inferred) {
              menuItems.push(s);
              orderedChoices.push(s);
            }
          }

          const stageSelection = await ui.select!(
            inferred
              ? `Choose stage to resume from (inferred: ${inferred}):`
              : "Choose stage to resume from (cannot infer — select manually):",
            menuItems,
          );

          if (stageSelection === undefined) {
            // Phase 3 (173) C10④ fix: secondary menu Esc audit + notify
            // Consistent with primary Esc path (pipeline_decision_cancelled)
            clearDecisionTimer(freshMeta.pipelineId);
            await safeWriteAuditLog("pipeline_decision_cancelled", {
              pipelineId: freshMeta.pipelineId,
              stage: freshMeta.currentStage,
              context: "choose_stage_secondary",
            });
            if (tuiEnabled) {
              ui.notify?.(
                `Pipeline frozen: ${formatFrozenReason(freshMeta)}. ${formatDecisionMenuHint(config)}`,
              );
            }
            return "cancelled";
          }

          // Find the selected stage
          const selectedIdx = menuItems.indexOf(stageSelection);
          const targetStage = orderedChoices[selectedIdx];
          if (targetStage) {
            await executeDecision(ctx, freshMeta, "choose_stage", config, {
              source: opts?.source,
              targetStage,
              basis: inferenceBasis,
            });
          }
          return "decided";
        }

        await executeDecision(ctx, freshMeta, decision, config, { source: opts?.source });
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

    // Re-read meta: self-destruct on any of three conditions:
    // 1. No meta at all (session cleared)
    // 2. No longer frozen (user or another channel resolved the block)
    // 3. Pipeline ID changed (restart swapped the flow — orphaned timer from old flow)
    //    This is the Phase 1 (173) C7 self-destruct guard that prevents the ×24
    //    retry storm (V4): after restart the old timer keeps firing against the
    //    superseded pipelineId, but the current session now belongs to a new flow.
    const freshMeta = ctx.session.getMeta() as SessionMeta | undefined;
    if (!freshMeta || !isFrozen(freshMeta) || freshMeta.pipelineId !== pipelineId) {
      // Ownership mismatch or flow resolved — ensure timer is cleaned up
      clearDecisionTimer(pipelineId);
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

/**
 * Test-only helper: returns the number of active decision retry timers.
 * Used by restart-rebind.test.ts to verify that executeDecision("restart")
 * clears the stale timer for the superseded pipeline (V7 mutation self-check).
 * @internal
 */
export function __decisionTimerCount(): number {
  return decisionRetryTimers.size;
}

/**
 * Test-only helper: returns whether a timer exists for the given pipelineId.
 * @internal
 */
export function __hasDecisionTimer(pipelineId: string): boolean {
  return decisionRetryTimers.has(pipelineId);
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

  // Phase 1 (173) C7: Detect session role before freezing.
  // Child sessions still freeze (the blocked state is a fact) but do NOT
  // present the menu or schedule retries — the owner side is responsible
  // for rendering the decision menu (via settle re-popup, shortcut, replay,
  // or /pipeline-start). Degradation: missing _ctx → treat as owner.
  let hostRole: "owner" | "child" = "owner";
  try {
    const { isChild } = detectSessionRole(buildRoleCtxForGate(ctx));
    if (isChild) {
      hostRole = "child";
    }
  } catch {
    // Fail-open: role detection error → treat as owner (conservative)
  }

  ctx.session.updateMeta({
    flowState: "blocked",
    blockedReason: reason,
  });

  // Audit: pipeline blocked (warn level)
  // Phase 1 (171) C14: enriched with nextStage (information field) and nextAction
  // Phase 1 (173) C7: hostRole field for attribution (owner vs child)
  const blockedNextStage = config.stages[meta.currentStage]?.nextStage ?? null;
  await safeWriteAuditLog("pipeline_blocked", {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    reason,
    nextStage: blockedNextStage ?? "null",
    nextAction: formatDecisionMenuHint(config),
    hostRole,
  }, "warn");

  // Phase 1 (173) C7: Child sessions skip menu prompt and retry scheduling.
  // The freeze state is recorded (owner will see it on next settle/shortcut/replay).
  if (hostRole === "child") {
    return;
  }

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
