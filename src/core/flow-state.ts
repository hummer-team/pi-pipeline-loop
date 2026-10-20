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
import { safeWriteAuditLog, prepareAuditPipelineLog } from "../utils/auditLog";
import { effectiveMax, deriveReworkLoopGate, remainingRoundsOf } from "../utils/stage-visit";
import { maybeCompactOnPipelineCompleted } from "./terminal-compact";
import type { TerminalCompactCtx } from "./terminal-compact";
import { DECISION_DISMISS_INTERRUPT_MS, CANONICAL_STAGE_ORDER } from "../constants";
import { registerSession } from "../utils/session-registry";
import { detectSessionRole } from "./session-role";
import type { RuntimeCtx } from "./runtime-ctx";
import { createPipelineUI, syncStageStatusBar } from "./pipeline-ui";
import { designReviewAuthorisationGate } from "./design-review/authorization";
import { guardGenericFlowDecision } from "./design-review/flow-decision-guard";
import { strictCommitMeta, expectedFromCurrent } from "./session-state";
import { isAuthorizationValid } from "./design-review/state";
import { broadcastEscalation } from "../utils/escalation-bus";
import type { EscalationPayload } from "../utils/escalation-bus";
import { buildContinueResetFields, buildNewPeriodResetFields } from "./meta-reset";
import { clearStageSpawnResidue } from "../utils/spawn-cleanup";
import { probeAgentState } from "../utils/subagents-introspect";
// 208: explicit imports create LOCAL bindings — `export { … } from "…"` alone
// would not make these names visible inside this module (TS2304).
import {
  markInputUnavailable,
  isInputUnavailable,
} from "./decision-menu-runtime";
import type {
  EnsureDecisionMenuOpts,
  EnsureDecisionMenuResult,
  MenuAttemptDetail,
  DecisionMenuCapabilities,
  DecisionMenuRuntimeDeps,
} from "./decision-menu-runtime";
import type { PromptDecisionOutcome as RuntimePromptDecisionOutcome } from "./decision-menu-runtime";

// 208: PromptDecisionOutcome moved down into decision-menu-runtime (Design J4);
// re-exported here so callers keep importing from flow-state unchanged.
export type {
  PromptDecisionOutcome,
  EnsureDecisionMenuOpts,
  EnsureDecisionMenuResult,
  MenuAttemptDetail,
  DecisionMenuCapabilities,
  DecisionMenuFailureReason,
  DecisionMenuUnavailableReason,
} from "./decision-menu-runtime";

/** Local alias for internal signatures (public type is re-exported above). */
type PromptDecisionOutcome = RuntimePromptDecisionOutcome;

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
 *
 * Fix for Issue #2: Include ui property to enable authorization gate TUI interaction.
 */
function buildRoleCtxForGate(ctx: FlowStateCtx): RuntimeCtx {
  // SAFETY: FlowStateCtx contains a subset of RuntimeCtx fields (_ctx, ui, session).
  // This cast is safe because we only use role-detection APIs that don't access
  // other RuntimeCtx properties (toolCall, etc.). Verified by session-role.ts contract.
  return { 
    _ctx: ctx._ctx,
    ui: ctx.ui,
    session: ctx.session
  } as unknown as RuntimeCtx;
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
    /** 208 (J1/J3): host input dialog — collects the `set_budget` loop budget. */
    input?: (message: string) => Promise<string | undefined>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    notify?: (msg: string, ...args: any[]) => void;
  };
  /** @internal ExtensionContext for terminal compact (W3 wiring). Optional for backward compat. */
  _ctx?: TerminalCompactCtx["_ctx"];
  /**
   * 203_Bug Phase 0 (RC1): Raw pi ExtensionAPI for event-bus broadcast.
   * Optional for backward compat; structurally compatible with RuntimeCtx.pi.
   * Used to broadcast child-side freeze escalation (see escalation-bus).
   */
  pi?: unknown;
}

// ─── Decision Types ─────────────────────────────────────────────────────────

/** User decision identifiers for the pipeline decision menu. */
export type PipelineDecision = "resume" | "skip" | "rollback" | "restart" | "abort" | "choose_stage" | "set_budget" | "rewind_last_round";

/** Decision menu labels (English, matching TUI display). */
const DECISION_LABELS: Record<PipelineDecision, string> = {
  resume: "Resume",
  skip: "Skip",
  rollback: "Rollback",
  restart: "Restart & New",
  abort: "Abort & Exit",
  choose_stage: "Choose stage…",
  set_budget: "设置轮次",
  rewind_last_round: "回退上一轮",
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
 * Phase 6 (195): Now accepts blockedReason and config to dynamically adjust menu items.
 *
 * - aborted → null (do not show menu)
 * - blockedReason === "max_loop_cycles" → [set_budget/回退上一轮/restart/abort/resume] (203_Bug Phase 1: all always offered)
 *   - rewind only when deriveReworkLoopGate(meta, config) !== null (structural gate)
 *   - 208 (J1): `set_budget` is offered only when `capabilities.input === true`
 *     (menu degradation when the host has no usable `ui.input`)
 * - Other blocked / awaiting_human → 6 items (resume/skip/rollback/restart/abort/choose_stage)
 * - running → 2 items (restart/abort)
 */
export function buildDecisionMenu(
  meta: SessionMeta,
  blockedReason?: string,
  config?: PipelineConfig,
  capabilities: DecisionMenuCapabilities = { input: true },
): string[] | null {
  const fs = getFlowState(meta);

  if (fs === "aborted") return null;

  if (fs === "blocked" || meta.currentStage === "awaiting_human") {
    // Phase 6 (195): max_loop_cycles gets a specialized 4-item menu
    // 203_Bug Phase 1: 弹门禁放开 — set_budget / rewind / resume are always
    // offered (the one-shot "extension/rewind already used" guards were
    // removed; only the structural rework-loop-gate condition remains).
    if (blockedReason === "max_loop_cycles") {
      const items: string[] = [];

      // Plan menu order: [set_budget, rewind, restart, abort, resume].
      // 208 (J1): `set_budget` requires a usable `ui.input` — degrade (hide the
      // item) when the host input capability is unavailable. All other item
      // counts/order unchanged; the final item count therefore varies with the
      // rework gate (4 items with a back-edge, 3 without).
      if (capabilities.input) {
        items.push(DECISION_LABELS.set_budget);
      }

      // rewind_last_round offered whenever the rework gate can be derived
      const rewindGate = deriveReworkLoopGate(meta, config);
      if (rewindGate !== null) {
        items.push(DECISION_LABELS.rewind_last_round);
      }

      // restart and abort always present
      items.push(DECISION_LABELS.restart);
      items.push(DECISION_LABELS.abort);

      // Resume always available (budget extension via set_budget)
      items.push(DECISION_LABELS.resume);

      return items;
    }
    
    // Other blocked reasons: standard 6-item menu (E17)
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

/**
 * 208 (F2): Numeric legality for `set_budget` (shared by menu input and
 * executeDecision). Frozen-state and `budgetValue` presence guards remain in
 * `executeDecision`: they are not numeric checks and are protected by
 * dedicated tests.
 */
export function validateBudgetValue(
  value: number,
  currentCycleCount: number,
): { ok: true } | { ok: false; message: string } {
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, message: "Cannot set budget: budgetValue must be a positive number." };
  }
  if (value <= currentCycleCount) {
    return { ok: false, message: `Cannot set budget: value (${value}) must be greater than current loopCycleCount (${currentCycleCount}).` };
  }
  return { ok: true };
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
  opts?: {
    source?: string;
    targetStage?: PipelineStage;
    basis?: string;
    /** Phase 0 (182): DI callback invoked after choose_stage succeeds. Callers inject dispatchAfterResume. */
    onStageChanged?: (freshMeta: SessionMeta) => Promise<void>;
    /** Phase 5 (195): Budget value for set_budget decision (new maxLoopCycles absolute value) */
    budgetValue?: number;
  },
): Promise<{ success: boolean; message: string }> {
  const fromStage = meta.currentStage;

  // 193 Phase 3 (task 5): SINGLE executor-level barrier — consulted BEFORE
  // any state touch (invalidate / updateMeta / onStageChanged) and against
  // the AUTHORITATIVE re-read. The first menu, a re-prompt, shortcut keys,
  // replay and --force-resume all funnel through this one guard, so no entry
  // can smuggle a skip/forward-jump past an unfinished design-review loop —
  // and a stale menu snapshot cannot override fresher shared state.
  const authoritative = (ctx.session.getMeta() as SessionMeta | undefined) ?? meta;
  const guardVerdict = guardGenericFlowDecision({
    decision,
    meta: authoritative,
    config,
    ...(opts?.targetStage !== undefined ? { targetStage: opts.targetStage } : {}),
  });
  if (!guardVerdict.ok) {
    await safeWriteAuditLog("design_review_flow_decision_guard", {
      pipelineId: authoritative.pipelineId ?? "unknown",
      stage: authoritative.currentStage,
      decision,
      ...(opts?.targetStage !== undefined ? { targetStage: opts.targetStage } : {}),
      code: guardVerdict.code,
      ...(opts?.source !== undefined ? { source: opts.source } : {}),
    }, "warn");
    return { success: false, message: guardVerdict.message };
  }

  switch (decision) {
    case "resume": {
      const toStage = meta.currentStage === "awaiting_human"
        ? (meta.previousStage ?? "clarify")
        : meta.currentStage;

      // 203_Bug Phase 1 (RC2): resolve the spawn-ledger residue target and
      // liveness evidence from the CALLER SNAPSHOT *before* updateMeta.
      // - The cleanup target is the stage the pipeline resumes INTO (`toStage`):
      //   resuming from `awaiting_human` goes back to `previousStage`, so
      //   cleaning `meta.currentStage` (awaiting_human) would leave the real
      //   stage's spawnedStages/pendingSpawns residue behind and
      //   duplicate_spawn_guarded would still block re-dispatch.
      // - Reading after updateMeta would depend on whether the session adapter
      //   mutates the snapshot in place (test mock) or replaces it (production).
      const spawn = meta.activeSpawns?.[toStage];
      const executorAgentId = spawn?.agentId ?? spawn?.agentName;
      const executorLive = (() => {
        if (!executorAgentId) return false;
        try {
          return probeAgentState(executorAgentId) === "live";
        } catch {
          return false;
        }
      })();

      // 203_Bug Phase 1: single-source continue-reset checklist replaces the
      // hardcoded patch — all cyclic counters (loopCycleCount / budget
      // extensions / rewinds / warned flag / escalation + wake one-shots)
      // return to initial values so the next threshold can freeze again.
      ctx.session.updateMeta({
        ...buildContinueResetFields(meta, config),
        ...(meta.currentStage === "awaiting_human"
          ? {
              currentStage: meta.previousStage ?? "clarify",
              previousStage: undefined,
              // Phase 1 (180): a stage change ends the confirm-gate deferral
              // window; clear the stamp. Same-stage resume keeps it (continuity).
              confirmGateDeferredAt: undefined,
            }
          : {}),
      });

      // 203_Bug Phase 1 (RC2): clear the resumed stage's spawn ledger residue
      // (activeSpawns/spawnedStages/pendingSpawns) so a re-dispatch after
      // unfreeze is not blocked by duplicate_spawn_guarded. Live-protect:
      // when the stage executor is still actually live, keep the record.
      if (!executorLive) {
        clearStageSpawnResidue(ctx.session, toStage);
      } else {
        ctx.ui?.notify?.(
          `Stage "${toStage}" executor still live — spawn residue kept.`,
        );
      }

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

      // Phase 4 (191): invalidate design-review authorization on skip
      await invalidateDesignReviewAuthorization(ctx, "decision_skip");

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
        precheckBlocked: undefined, // 189 Bug 3: clear hard-stop flag on decision
        transientRetryCount: undefined, // 189 Phase 2: clear retry counter on decision
        // Phase 1 (180): new stage visit — clear any stale confirm-gate deferral stamp.
        confirmGateDeferredAt: undefined,
        ...summariesPatch,
      });

      await safeWriteAuditLog("pipeline_decision", {
        pipelineId: meta.pipelineId,
        decision,
        fromStage: prevStage,
        toStage,
        reason: meta.blockedReason ?? "",
        // Phase 3 (173) §3.3-④: unified source field across all executeDecision branches
        ...(opts?.source ? { source: opts.source } : {}),
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

      // Phase 4 (191): invalidate design-review authorization on rollback
      // 193 Phase 3 (task 6): rollback is an upstream exit — the same strict
      // transaction leaves the RECHECK marker armed; forward release stays
      // refused until a NEW review authorization takes over and clears it.
      await invalidateDesignReviewAuthorization(ctx, "decision_rollback", { leaveRecheck: true });

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
        precheckBlocked: undefined, // 189 Bug 3: clear hard-stop flag on decision
        transientRetryCount: undefined, // 189 Phase 2: clear retry counter on decision
        // Phase 1 (180): new stage visit — clear any stale confirm-gate deferral stamp.
        confirmGateDeferredAt: undefined,
        ...summariesPatch,
      });

      await safeWriteAuditLog("pipeline_decision", {
        pipelineId: meta.pipelineId,
        decision,
        fromStage: prevStage,
        toStage,
        reason: meta.blockedReason ?? "",
        // Phase 3 (173) §3.3-④: unified source field across all executeDecision branches
        ...(opts?.source ? { source: opts.source } : {}),
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

      // 203_Bug Phase 1: single-source new-period reset checklist replaces the
      // handwritten clears — 补齐 loop-budget counters (loopCycleCount /
      // loopBudgetExtensionCount / loopRewindCount / loopBudgetWarned / maxLoopCycles
      // → config default), dismiss/confirm counters, escalation + wake one-shots,
      // lastVerifyResult, designReview authorization. No cross-period residue.
      ctx.session.updateMeta({
        ...buildNewPeriodResetFields(meta, config),
        pipelineId: newPipelineId,
        currentStage: "clarify",
      });

      // Phase 1 (197): bind audit routing to new pipeline identity (3rd birth point)
      await prepareAuditPipelineLog(newPipelineId);

      await safeWriteAuditLog("pipeline_decision", {
        pipelineId: newPipelineId,
        decision,
        // Phase 3 (173) C10④: fromStage is the actual frozen stage, not hardcoded "restart"
        fromStage: fromStage,
        toStage: "clarify",
        newPipelineId,
        reason: meta.blockedReason ?? "",
        ...(opts?.source ? { source: opts.source } : {}),
      }, undefined, newPipelineId);

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

      // Phase 3 (173) §3.3-④: restart result message includes old pipeline id
      // and hint that previous progress is not inherited (use Choose stage for resume).
      return {
        success: true,
        message:
          `Pipeline restarted as "${newPipelineId}" at stage "clarify". ` +
          `Previous pipeline "${oldPipelineId}" progress is not inherited — use Choose stage for resume.`,
      };
    }

    case "abort": {
      // Phase 4 (191): invalidate design-review authorization on abort
      await invalidateDesignReviewAuthorization(ctx, "decision_abort");

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
        // Phase 3 (173) §3.3-④: unified source field across all executeDecision branches
        ...(opts?.source ? { source: opts.source } : {}),
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

      // Phase 4 (191) + 192 Phase 4 (task 1/F05): human direct entry ALWAYS
      // runs the owner gate. A pre-existing authorization — even a "valid"
      // one — is FIRST invalidated: manual re-entry must not silently reuse
      // an earlier closed loop (the old loop keeps its takeover duties).
      if (target === "design-review") {
        if (meta.designReview && isAuthorizationValid(meta.designReview)) {
          await invalidateDesignReviewAuthorization(ctx, "decision_choose_stage_reentry");
        }
        const refreshedMeta = (ctx.session.getMeta() as SessionMeta | undefined) ?? meta;
        const gateResult = await designReviewAuthorisationGate(
          buildRoleCtxForGate(ctx),
          config,
          refreshedMeta,
        );
        if (gateResult.ok) {
          // Authorization granted - persist the new state.
          // 192 fix (issue 7, plan Phase 4 task 3): RELIABLE commit — if the
          // strict path conflicts or is unavailable, entry FAILS closed with
          // the new authorization unpersisted; the loop never runs on a
          // silently-dropped write.
          const authCommit = strictCommitMeta(
            ctx.session,
            // 193 Phase 3 (task 6): a NEW review authorization takes over the
            // loop — the recheck barrier clears in the SAME atomic commit.
            { designReview: gateResult.state, designReviewRecheck: undefined },
            expectedFromCurrent(refreshedMeta),
          );
          if (authCommit.status !== "persisted") {
            await safeWriteAuditLog("design_review_authorisation", {
              pipelineId: refreshedMeta.pipelineId,
              action: "gate_commit_failed",
              status: authCommit.status,
              reason: authCommit.reason,
              authorizationId: gateResult.state.authorizationId,
              source: "choose_stage",
            }, "error");
            return {
              success: false,
              message:
                `Design-review authorization commit failed: ${authCommit.status} (${authCommit.reason}). ` +
                `The pipeline stays frozen; no authorization was persisted.`,
            };
          }
          await safeWriteAuditLog("design_review_authorisation", {
            pipelineId: refreshedMeta.pipelineId,
            action: "gate_passed",
            authorizationId: gateResult.state.authorizationId,
            source: "choose_stage",
          });
        } else {
          // Authorization denied - don't proceed
          return { success: false, message: `Design-review authorization failed: ${gateResult.reason}` };
        }
      } else {
        // Phase 4 (191): invalidate design-review authorization when choosing a non-design-review stage.
        // Choosing any other stage clears stale authorization to prevent reuse attacks.
        // 193 Phase 3 (task 6): a jump to an UPSTREAM stage (before design-review)
        // is an upstream rollback with the loop UNFINISHED — the SAME strict
        // transaction that clears the authorization arms the RECHECK barrier so
        // no ordinary forward release can bypass the owed re-review. Any other
        // target keeps the plain clear (marker dropped too).
        const upstreamTarget =
          CANONICAL_STAGE_ORDER.indexOf(target) !== -1 &&
          CANONICAL_STAGE_ORDER.indexOf(target) < CANONICAL_STAGE_ORDER.indexOf("design-review");
        await invalidateDesignReviewAuthorization(
          ctx,
          "decision_choose_stage",
          upstreamTarget ? { leaveRecheck: true } : undefined,
        );
      }

      // 194 Phase 3 (task 7, review issue 3): a manual stage jump is a
      // boundary — the executor run belongs to the ABANDONED stage visit and
      // must be invalidated BEFORE the new-stage meta is written (a plain
      // merge would otherwise carry the stale binding into the new visit).
      // Loaded dynamically: stage-executor/recovery statically depends on
      // this module, and a static import here would form a cycle.
      const { invalidateExecutorRunOnBoundary } = await import("./stage-executor/recovery");
      await invalidateExecutorRunOnBoundary({
        session: ctx.session,
        reason: "decision_choose_stage",
      });

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
        // Phase 1 (180): new stage visit — clear any stale confirm-gate deferral stamp.
        confirmGateDeferredAt: undefined,
        // Phase 1 (190) Fix-B: reset dismiss count on manual stage selection
        dismissCount: 0,
        // Phase 3 (190) Fix-F: reset cycle count on manual stage selection
        loopCycleCount: 0,
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

      // Phase 0 (182): sync status bar immediately after choose_stage so the TUI
      // reflects the new stage → nextStage pointer without waiting for the next
      // stageEntry call. Uses the shared syncStageStatusBar helper (same format
      // as pipeline-start / pipeline-resume).
      syncStageStatusBar(createPipelineUI(config), ctx);

      // Phase 0 (182): invoke the DI callback (if provided) so the caller can
      // dispatch the stage executor agent. The callback receives the freshest
      // meta snapshot (post-updateMeta) to avoid stale-stage dispatch.
      const freshMetaForCallback = ctx.session.getMeta();
      if (freshMetaForCallback && opts?.onStageChanged) {
        try {
          await opts.onStageChanged(freshMetaForCallback);
        } catch (err) {
          // Fail-open: dispatch failure must not break the choose_stage result
          const errMsg = err instanceof Error ? err.message : String(err);
          await safeWriteAuditLog("on_stage_changed_error", {
            pipelineId: meta.pipelineId,
            stage: target,
            error: errMsg,
          }, "error");
        }
      }

      return { success: true, message: `Pipeline resumed at stage "${target}" (chosen from "${frozenStage}").` };
    }

    case "set_budget": {
      if (!isFrozen(meta)) {
        return { success: false, message: "Cannot set budget: pipeline is not frozen." };
      }

      const budgetValue = opts?.budgetValue;
      if (budgetValue === undefined || budgetValue === null) {
        return { success: false, message: "Cannot set budget: budgetValue is required." };
      }

      // 208 (F2): numeric legality lives in the shared helper (menu input and
      // executeDecision both validate through validateBudgetValue).
      const verdict = validateBudgetValue(budgetValue, meta.loopCycleCount ?? 0);
      if (!verdict.ok) return { success: false, message: verdict.message };

      // 203_Bug Phase 1: one-shot "already extended once" guard removed —
      // the budget gate is no longer capped; a later set_budget simply
      // overwrites maxLoopCycles (value must exceed current cycles).

      ctx.session.updateMeta({
        maxLoopCycles: budgetValue,
        loopBudgetExtensionCount: (meta.loopBudgetExtensionCount ?? 0) + 1,
        flowState: "running",
        blockedReason: undefined,
      });

      await safeWriteAuditLog("pipeline_decision", {
        pipelineId: meta.pipelineId,
        decision,
        fromStage,
        toStage: meta.currentStage,
        reason: meta.blockedReason ?? "",
        budgetValue: String(budgetValue),
        previousMaxLoopCycles: String(meta.maxLoopCycles ?? 0),
        ...(opts?.source ? { source: opts.source } : {}),
      });

      return { success: true, message: `Budget extended to ${budgetValue} cycles.` };
    }

    case "rewind_last_round": {
      if (!isFrozen(meta)) {
        return { success: false, message: "Cannot rewind: pipeline is not frozen." };
      }

      // 203_Bug Phase 1: one-shot "already rewound once" guard removed —
      // repeated rewinds are permitted (calculator reset via continue does
      // restore the guard anyway); rewind itself keeps baseline continuity.

      const gate = deriveReworkLoopGate(meta, config);
      
      if (gate === null) {
        await safeWriteAuditLog("rewind_target_unresolved", {
          pipelineId: meta.pipelineId,
          decision,
          stage: meta.currentStage,
          reason: "No valid rework loop gate found in stageVisitOrder",
          ...(opts?.source ? { source: opts.source } : {}),
        });
        return { success: false, message: "未能定位上一轮返工起点" };
      }

      if (gate === "completed" || gate === "awaiting_human") {
        return { success: false, message: `Cannot rewind to terminal/non-rework stage: ${gate}` };
      }

      const prevStage = meta.currentStage;
      const visitOrder = [...(meta.stageVisitOrder ?? []), gate];

      ctx.session.updateMeta({
        currentStage: gate,
        previousStage: prevStage,
        loopCycleCount: 0,
        loopRewindCount: (meta.loopRewindCount ?? 0) + 1,
        flowState: "running",
        blockedReason: undefined,
        stageVisitOrder: visitOrder,
      });

      await safeWriteAuditLog("pipeline_decision", {
        pipelineId: meta.pipelineId,
        decision,
        fromStage: prevStage,
        toStage: gate,
        reason: meta.blockedReason ?? "",
        rewindGate: gate,
        ...(opts?.source ? { source: opts.source } : {}),
      });

      return { success: true, message: `Rewound from "${prevStage}" to rework loop gate "${gate}".` };
    }

    default:
      return { success: false, message: `Unknown decision: "${String(decision)}".` };
  }
}

// ─── invalidateDesignReviewAuthorization ────────────────────────────────────

/**
 * Phase 4 (191): Invalidates design-review authorization on quit/shutdown/stage change.
 *
 * Clears the designReview field from SessionMeta to ensure stale authorization
 * does not pollute new runs or stage transitions. This is a safety measure to
 * prevent authorization reuse attacks and ensure each design-review session
 * requires fresh owner authorization.
 *
 * Called by:
 * - pipeline-quit (on explicit quit)
 * - session-shutdown (on session end)
 * - executeDecision (on skip/rollback/abort/choose_stage to non-design-review)
 *
 * @param ctx - FlowStateCtx with session access
 * @param reason - Machine-readable reason for audit (e.g., "user_quit", "session_shutdown")
 * @param opts - 193 Phase 3 (task 6): `leaveRecheck` ARM the RECHECK barrier —
 *   the marker is written in the SAME exclusive strict transaction that clears
 *   the authorization (never a separate clear-then-write step), so an upstream
 *   rollback can never leave a half-state that releases develop/review/fix
 *   forward. Without it, any existing marker is cleared too (abort/quit/new
 *   runs are explicit exits; old markers never survive into a new pipeline).
 */
export async function invalidateDesignReviewAuthorization(
  ctx: FlowStateCtx,
  reason: string,
  opts?: { leaveRecheck?: boolean },
): Promise<void> {
  const meta = ctx.session.getMeta();
  if (!meta?.designReview) {
    return; // No authorization to invalidate
  }

  const authorizationId = meta.designReview.authorizationId;
  const phase = meta.designReview.phase;

  // Build the clear patch for ONE strict commit: either arm the recheck
  // marker from the state being dropped (upstream rollback), or clear both
  // the authorization and any stale marker (explicit exits).
  const clearPatch = (base: SessionMeta): Partial<SessionMeta> => {
    if (opts?.leaveRecheck && base.designReview) {
      return {
        designReview: undefined,
        designReviewRecheck: {
          pipelineId: base.pipelineId ?? "unknown",
          planDoc: base.designReview.planDoc,
        },
      };
    }
    return { designReview: undefined, designReviewRecheck: undefined };
  };

  // 193 Phase 2 (task 2): an authorization CLEAR is a protected-field patch
  // and must go through the exclusive strict commit with an expectation —
  // never a plain whole-object overwrite that could race a newer shared
  // state (e.g. a just-committed human decision). One fresh retry on
  // conflict; adapters WITHOUT the strict interface keep the legacy plain
  // write (existing fallback, no new authority).
  const attemptClear = (base: SessionMeta): "persisted" | "retry" | "legacy" => {
    const expected = expectedFromCurrent(base);
    const res = strictCommitMeta(ctx.session, clearPatch(base), expected);
    if (res.status === "persisted") return "persisted";
    if (res.status === "conflict") return "retry";
    if (res.reason === "adapter_lacks_strict_interface") return "legacy";
    return "retry";
  };

  const outcome = attemptClear(meta);
  if (outcome === "retry") {
    const fresh = ctx.session.getMeta();
    if (fresh?.designReview) {
      const second = attemptClear(fresh);
      if (second === "retry") {
        // Fail-closed honesty: a commit that cannot be confirmed leaves the
        // authorization in place and is audited — the user can retry quit.
        await safeWriteAuditLog("design_review_authorization_invalidate_failed", {
          pipelineId: fresh.pipelineId ?? "unknown",
          authorizationId,
          reason,
        }, "error");
        return;
      }
    }
  }
  if (outcome === "legacy") {
    ctx.session.updateMeta(clearPatch(meta));
  }

  await safeWriteAuditLog("design_review_authorization_invalidated", {
    pipelineId: meta.pipelineId ?? "unknown",
    stage: meta.currentStage ?? "unknown",
    authorizationId,
    phase,
    reason,
    // 193 Phase 3 (task 6): honest barrier bookkeeping for audits.
    recheck: opts?.leaveRecheck ? "armed" : "cleared",
  });
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
    pendingSpawns: {},
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
 * Formats a hint message directing the user to the /pipeline-resume command
 * for opening the decision menu or bypassing it with --force-resume.
 * Single source for all consumers: frozen notify, prompt-injector, and pipeline_blocked audit.
 *
 * @returns Human-readable hint string
 */
export function formatDecisionMenuHint(): string {
  return "Run /pipeline-resume to open the decision menu, or /pipeline-resume --force-resume to resume directly.";
}

// (208: PromptDecisionOutcome type moved to decision-menu-runtime.ts and
// re-exported near the imports above — no inline definition here anymore.)

/**
 * 208 (J1/J3): collect an absolute loop budget from the host input dialog.
 * Cancel → cancelled (respect Esc, never retried); invalid → invalid (retried
 * by the caller as `interrupted`); throw → error (no retry, capability drops).
 *
 * Discretionary resolution (Design_Review_1 #5): an EMPTY input string is
 * treated as a cancel (per requirement J1), not as an invalid value.
 */
async function promptBudgetValue(
  ui: NonNullable<FlowStateCtx["ui"]>,
  meta: SessionMeta,
  config: PipelineConfig,
): Promise<BudgetInputResult> {
  if (typeof ui.input !== "function") return { kind: "unavailable" };
  const current = meta.loopCycleCount ?? 0;
  const configured = effectiveMax(meta, config);
  try {
    const raw = await ui.input(
      `Set loop budget (current cycle ${current}, configured max ${configured}; enter an absolute value > ${current}):`,
    );
    if (raw === undefined || raw.trim().length === 0) return { kind: "cancelled" };
    const parsed = Number(raw.trim());
    const verdict = validateBudgetValue(parsed, current);
    if (!verdict.ok) return { kind: "invalid", reason: verdict.message };
    return { kind: "value", value: parsed };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await safeWriteAuditLog(
      "pipeline_decision_error",
      { pipelineId: meta.pipelineId, stage: meta.currentStage, context: "input", error: reason },
      "error",
    );
    return { kind: "error", reason };
  }
}

/** Result of one host-input dialog collection for `set_budget`. */
type BudgetInputResult =
  | { kind: "value"; value: number }
  | { kind: "cancelled" }
  | { kind: "invalid"; reason: string }
  | { kind: "unavailable" }
  | { kind: "error"; reason: string };

/**
 * Phase 3 (173) C9: Secondary stage-selection menu helper (208 detailed form).
 *
 * Extracted so that shortcut/start/replay/re-popup entries can bypass the
 * first-level 6-item menu when the user's intent is already "choose stage"
 * (e.g. shortcut → Choose stage… should go straight to the stage list
 * instead of re-prompting the entire first-level menu).
 *
 * 208 (F1/F2): returns a full {@link MenuAttemptDetail} instead of a bare
 * outcome — `interrupted` carries `interruptedStage: "secondary"`, a missed
 * target stage carries `failureReason: "stage_not_found"`, and the
 * `executeDecision` success flag is propagated as `applied`.
 */
async function promptStageSelectionDetailed(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  config: PipelineConfig,
  opts: {
    ui: NonNullable<FlowStateCtx["ui"]>;
    source: string;
    tuiEnabled: boolean;
    /** Phase 0 (182): forwarded to executeDecision for choose_stage aftermath. */
    onStageChanged?: (freshMeta: SessionMeta) => Promise<void>;
    /** Phase 5 (195): forwarded to executeDecision (208 F3: no longer dropped). */
    budgetValue?: number;
    /** 208 G5: presentation attempt index for the `decision_menu_presented` audit. */
    attempt?: number;
  },
): Promise<MenuAttemptDetail> {
  const { ui, source, tuiEnabled } = opts;
  const inferenceResult = inferResumeStage(meta, config);
  const inferred = inferenceResult.stage;
  const inferenceBasis = inferenceResult.basis;
  // Phase 0 (182) R-c: when frozen at fix, filter out "completed" from the
  // secondary stage menu — fix must route through review before reaching terminal.
  // awaiting_human is not in the list by default (existing behavior at line 838).
  const baseChoices: PipelineStage[] = ["clarify", "plan", "develop", "review", "fix", "completed"];
  const stageChoices: PipelineStage[] = meta.currentStage === "fix"
    ? baseChoices.filter(s => s !== "completed")
    : baseChoices;
  // Also filter inferred default if it happens to be completed while at fix
  const effectiveInferred = (meta.currentStage === "fix" && inferred === "completed") ? null : inferred;

  // Build secondary menu items with inferred stage first (if available)
  const menuItems: string[] = [];
  const orderedChoices: PipelineStage[] = [];
  if (effectiveInferred) {
    menuItems.push(`${effectiveInferred} (default)`);
    orderedChoices.push(effectiveInferred);
  }
  for (const s of stageChoices) {
    if (s !== effectiveInferred) {
      menuItems.push(s);
      orderedChoices.push(s);
    }
  }

  // 208 G5: the secondary dialog counts as a real presentation — write the
  // audit BEFORE `ui.select` so secondary appearances pair with retry events.
  // Direct retry entries (directStageSelect, e.g. post-secondary interrupt)
  // hit this write on their first call (menuKind is "secondary" there too).
  await safeWriteAuditLog("decision_menu_presented", {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    source,
    attempt: String(opts.attempt ?? 1),
    blockedReason: meta.blockedReason ?? "unknown",
    menuSize: String(menuItems.length),
    menuKind: "secondary",
  });

  const attemptAt = Date.now();
  const stageSelection = await ui.select!(
    effectiveInferred
      ? `Choose stage to resume from (inferred: ${effectiveInferred}):`
      : "Choose stage to resume from (cannot infer — select manually):",
    menuItems,
  );

  if (stageSelection === undefined) {
    // Phase 3 (173) §3.2 + 172-G5 precedent: distinguish streaming dismiss (<1500ms)
    // from real user Esc. Fast dismiss = system interrupt → return "interrupted" so
    // the scheduler arms a directly targeted secondary retry. Slow dismiss = user Esc
    // → audit cancelled and return "cancelled".
    const elapsed = Date.now() - attemptAt;
    if (elapsed < DECISION_DISMISS_INTERRUPT_MS) {
      await safeWriteAuditLog("pipeline_decision_interrupted", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        elapsedMs: String(elapsed),
        context: "choose_stage_secondary",
      });
      return { outcome: "interrupted", applied: false, interruptedStage: "secondary" };
    }

    // User pressed Esc in secondary menu: audit + notify, consistent with primary Esc path.
    clearDecisionTimer(meta.pipelineId);
    await safeWriteAuditLog("pipeline_decision_cancelled", {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
      context: "choose_stage_secondary",
    });
    if (tuiEnabled) {
      ui.notify?.(
        `Pipeline frozen: ${formatFrozenReason(meta)}. ${formatDecisionMenuHint()}`,
      );
    }
    return { outcome: "cancelled", applied: false };
  }

  // Find the selected stage
  const selectedIdx = menuItems.indexOf(stageSelection);
  const targetStage = orderedChoices[selectedIdx];
  if (!targetStage) {
    // 208 (F4): a picked label that resolves to no stage is a real failure —
    // surface it instead of silently reporting "decided".
    const message = `Selected stage not found: ${stageSelection}`;
    ui.notify?.(message);
    return {
      outcome: "decided",
      applied: false,
      decision: "choose_stage",
      message,
      failureReason: "stage_not_found",
    };
  }
  const res = await executeDecision(ctx, meta, "choose_stage", config, {
    source,
    targetStage,
    basis: inferenceBasis,
    onStageChanged: opts.onStageChanged,
    budgetValue: opts.budgetValue,
  });
  if (res.success) {
    return { outcome: "decided", applied: true, decision: "choose_stage", message: res.message };
  }
  return {
    outcome: "decided",
    applied: false,
    decision: "choose_stage",
    message: res.message,
    failureReason: "guard_rejected",
  };
}

/**
 * 208: single presentation implementation. Keeps the legacy
 * `promptDecisionMenu` behaviour and adds outcome/attribution detail:
 * - unavailable reasons (`aborted` / `child_session` / `no_ui` / `select_error`)
 * - `applied` propagation from `executeDecision` (F1/F2)
 * - capability-aware menu composition (no `ui.input` → no `set_budget` item)
 * - `decision_menu_presented` audit before every `ui.select` (G5)
 * - `notifyOnUnavailable: false` suppresses the no-UI notify (commands own the message)
 */
async function presentDecisionMenuCore(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  config: PipelineConfig,
  opts: EnsureDecisionMenuOpts & { ui?: FlowStateCtx["ui"] },
  attempt: number,
): Promise<MenuAttemptDetail> {
  const ui = opts.ui ?? ctx.ui;
  const tuiEnabled = config.output?.pipelineStage !== false;
  const source = opts.source ?? "menu";

  // 208: capability-aware menu build — `set_budget` disappears when the host
  // has no usable `ui.input` (or the capability was dropped after a thrown dialog).
  const capabilities: DecisionMenuCapabilities = {
    input: typeof ui?.input === "function" && !isInputUnavailable(meta.pipelineId),
  };
  const menu = buildDecisionMenu(meta, meta.blockedReason, config, capabilities);

  if (!menu) {
    // aborted → do not prompt
    // Phase 6 (195) Task 4: audit no-menu exit for aborted state
    await safeWriteAuditLog("pipeline_decision_interrupted", {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
      context: "aborted",
    });
    return { outcome: "no-menu", applied: false, unavailableReason: "aborted" };
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
        ...(opts.source ? { source: opts.source } : {}),
      });
      return { outcome: "no-menu", applied: false, unavailableReason: "child_session" };
    }
  } catch {
    // Fail-open: role detection error → treat as owner (conservative, same as session-role.ts:14-15)
  }

  // Phase 6 (195): Owner session checks for pending escalation from child (15-B/C)
  // If menuEscalationPending is true, clear it and proceed to show menu (one-time)
  // Moved after !menu and child session gates: aborted and child sessions must not consume the flag
  if (meta.menuEscalationPending) {
    ctx.session.updateMeta({ menuEscalationPending: false });
    await safeWriteAuditLog("menu_escalation_consumed", {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
    });
  }

  if (ui?.select) {
    try {
      // Phase 3 (173) C9 fix (review round 2): directStageSelect bypasses the
      // first-level 6-item menu and goes straight to the secondary stage list.
      // Used by shortcut routing and post-secondary-interrupt retries (208 G5).
      if (opts.directStageSelect) {
        const freshMeta = ctx.session.getMeta() ?? meta;
        return await promptStageSelectionDetailed(ctx, freshMeta, config, {
          ui,
          source,
          tuiEnabled,
          onStageChanged: opts.onStageChanged,
          budgetValue: opts.budgetValue,
          attempt,
        });
      }

      const reason = meta.blockedReason ?? meta.terminateReason ?? "unknown";
      // 208 G5: audit BEFORE the real `ui.select` so primary appearances pair
      // with `decision_menu_retry_*` sequences.
      await safeWriteAuditLog("decision_menu_presented", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        source,
        attempt: String(attempt),
        blockedReason: reason,
        menuSize: String(menu.length),
        menuKind: "primary",
      });
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
          return { outcome: "interrupted", applied: false, interruptedStage: "primary" };
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
            `Pipeline frozen: ${formatFrozenReason(freshMeta)}. ${formatDecisionMenuHint()}`,
          );
        }
        return { outcome: "cancelled", applied: false };
      }

      const decision = labelToDecision(selection);
      if (decision) {
        // Re-read meta after potential UI delay
        const freshMeta = ctx.session.getMeta() ?? meta;

        // Phase 3 (173) C9: choose_stage → secondary menu (via shared helper)
        if (decision === "choose_stage") {
          return await promptStageSelectionDetailed(ctx, freshMeta, config, {
            ui,
            source,
            tuiEnabled,
            onStageChanged: opts.onStageChanged,
            budgetValue: opts.budgetValue,
            attempt,
          });
        }

        // 208 (J1/J3): set_budget collects the absolute value through `ui.input`.
        if (decision === "set_budget") {
          const input = await promptBudgetValue(ui, freshMeta, config);
          if (input.kind === "cancelled") {
            return { outcome: "cancelled", applied: false, decision };
          }
          if (input.kind === "unavailable") {
            markInputUnavailable(meta.pipelineId);
            return { outcome: "interrupted", applied: false, decision, message: "ui.input unavailable" };
          }
          if (input.kind === "invalid") {
            // Retryable invalid input: notify the concrete legality failure and
            // let the scheduler re-prompt. Not audited (input_invalid is
            // deliberately absent from the audit code table).
            ui.notify?.(input.reason);
            return {
              outcome: "interrupted",
              applied: false,
              decision,
              message: input.reason,
              failureReason: "input_invalid",
            };
          }
          if (input.kind === "error") {
            // Non-recoverable: the input dialog itself threw — drop capability
            // and stop retrying for this presentation chain (J3/D2).
            markInputUnavailable(meta.pipelineId);
            ui.notify?.(input.reason);
            return {
              outcome: "decided",
              applied: false,
              decision,
              retryable: false,
              message: input.reason,
              failureReason: "input_error",
            };
          }
          const res = await executeDecision(ctx, freshMeta, decision, config, {
            source,
            budgetValue: input.value,
          });
          if (res.success) {
            return { outcome: "decided", applied: true, decision, message: res.message };
          }
          return {
            outcome: "decided",
            applied: false,
            decision,
            message: res.message,
            failureReason: "guard_rejected",
          };
        }

        // 208 (F2): propagate the actual application result — "user picked" no
        // longer implies "state changed".
        const res = await executeDecision(ctx, freshMeta, decision, config, { source });
        if (res.success) {
          return { outcome: "decided", applied: true, decision, message: res.message };
        }
        return {
          outcome: "decided",
          applied: false,
          decision,
          message: res.message,
          failureReason: "guard_rejected",
        };
      }

      // 208 (F4): unknown labels were previously swallowed as decided.
      const message = `Unrecognized menu option: ${selection}`;
      ui.notify?.(message);
      return {
        outcome: "decided",
        applied: false,
        message,
        failureReason: "unknown_option",
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await safeWriteAuditLog("pipeline_decision_error", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        error: errMsg,
      }, "error");
      // 208: the interrupted audit gains a machine-readable context so the
      // no-menu event can be attributed (select/execute threw).
      await safeWriteAuditLog("pipeline_decision_interrupted", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        context: "select_error",
        error: errMsg,
      });
      return { outcome: "no-menu", applied: false, unavailableReason: "select_error" };
    }
  } else {
    // No UI available — notify via available channel (gated by pipelineStage).
    // 208: command entries pass `notifyOnUnavailable: false` and own the single
    // user-facing message.
    if (tuiEnabled && opts.notifyOnUnavailable !== false) {
      const frozenMeta = ctx.session.getMeta() ?? meta;
      ui?.notify?.(
        `Pipeline frozen: ${formatFrozenReason(frozenMeta)} ${formatDecisionMenuHint()}`,
      );
    }
    // Phase 6 (195) Task 4: audit no-menu exit for no-UI scenario
    await safeWriteAuditLog("pipeline_decision_interrupted", {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
      context: "no_ui",
    });
    return { outcome: "no-menu", applied: false, unavailableReason: "no_ui" };
  }
}

/**
 * 208: the original `promptDecisionMenu` entry keeps its legacy signature and
 * `PromptDecisionOutcome` return type (all existing call sites/tests intact),
 * while the audit-attributed detailed result is routed through
 * {@link presentDecisionMenuCore} plus the `decision_not_applied` audit.
 */
export async function promptDecisionMenu(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  config: PipelineConfig,
  opts?: {
    ui?: FlowStateCtx["ui"];
    source?: string;
    directStageSelect?: boolean;
    /** Phase 0 (182): forwarded to executeDecision via promptStageSelection for choose_stage aftermath. */
    onStageChanged?: (freshMeta: SessionMeta) => Promise<void>;
    /** Phase 5 (195): Budget value for set_budget decision (new maxLoopCycles absolute value) */
    budgetValue?: number;
  },
): Promise<PromptDecisionOutcome> {
  return (await promptDecisionMenuDetailed(ctx, meta, config, opts ?? {}, 1)).outcome;
}

/**
 * 208: detailed presentation core. Writes the `decision_not_applied` audit
 * for every `decided && !applied` result (cancelled / interrupted / no-menu
 * are deliberately NOT audited as failures).
 */
export async function promptDecisionMenuDetailed(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  config: PipelineConfig,
  opts: EnsureDecisionMenuOpts & { ui?: FlowStateCtx["ui"] } = {},
  attempt = 1,
): Promise<MenuAttemptDetail> {
  const detail = await presentDecisionMenuCore(ctx, meta, config, opts, attempt);
  if (detail.outcome === "decided" && detail.applied === false) {
    await safeWriteAuditLog("decision_not_applied", {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
      decision: detail.decision ?? "unknown",
      source: opts.source ?? "menu",
      attempt: String(attempt),
      reason: detail.failureReason ?? "guard_rejected",
      ...(detail.message !== undefined ? { message: detail.message } : {}),
    });
  }
  return detail;
}

// ─── 208 Phase 1: ensureDecisionMenu binding + legacy scheduler wrapper ──────

// Explicit imports create LOCAL bindings: `export { … } from "…"` alone would
// not make these names visible inside this module (used below by the legacy
// wrapper and the re-export surface).
import {
  runDecisionMenu,
  scheduleMenuRetry,
  clearDecisionTimer,
  clearAllDecisionTimers,
  __decisionTimerCount,
  __hasDecisionTimer,
} from "./decision-menu-runtime";

// Re-export the runtime surface (callers keep importing from flow-state).
export {
  clearDecisionTimer,
  clearAllDecisionTimers,
  __decisionTimerCount,
  __hasDecisionTimer,
};

/** 208: runtime deps closure — the presentation implementation stays local. */
function buildDeps(
  ctx: FlowStateCtx,
  config: PipelineConfig,
): DecisionMenuRuntimeDeps {
  return {
    readMeta: () => ctx.session.getMeta() as SessionMeta | undefined,
    isFrozen,
    present: (live, presentOpts, attempt) =>
      promptDecisionMenuDetailed(ctx, live, config, presentOpts, attempt),
  };
}

/** 208: single entry for every decision-menu presentation. */
export async function ensureDecisionMenu(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  config: PipelineConfig,
  opts: EnsureDecisionMenuOpts = {},
): Promise<EnsureDecisionMenuResult> {
  return runDecisionMenu(buildDeps(ctx, config), meta.pipelineId, opts);
}

/**
 * Legacy signature preserved (tests + `freezeAndPrompt` extras): arms a
 * direct backoff retry without an immediate presentation.
 */
export function scheduleDecisionRetry(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  config: PipelineConfig,
  attempt: number = 1,
  opts?: {
    /** Phase 0 (182): forwarded to the presentation for choose_stage aftermath. */
    onStageChanged?: (freshMeta: SessionMeta) => Promise<void>;
    /** Phase 5 (195) / 208 F3: budget value survives the retry (was dropped before). */
    budgetValue?: number;
  },
): void {
  scheduleMenuRetry(buildDeps(ctx, config), meta.pipelineId, attempt, {
    onStageChanged: opts?.onStageChanged,
    budgetValue: opts?.budgetValue,
  });
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
 * Phase 0 (195_Bug): blockedNextStage (line 1472) is display-only — it reads
 * config.stages[currentStage].nextStage for audit/UI context, but does NOT
 * influence stage transitions (flowState=blocked is the single source of truth).
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
  opts?: {
    ui?: FlowStateCtx["ui"];
    /** Phase 0 (182): forwarded to promptDecisionMenu for choose_stage aftermath. */
    onStageChanged?: (freshMeta: SessionMeta) => Promise<void>;
    /** Phase 5 (195): Budget value for set_budget decision (new maxLoopCycles absolute value) */
    budgetValue?: number;
  },
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
    nextAction: formatDecisionMenuHint(),
    hostRole,
    loopCycleCount: String(meta.loopCycleCount ?? 0),
    maxLoopCycles: String(effectiveMax(meta, config)),
    remainingRounds: String(remainingRoundsOf(meta, config)),
  }, "warn");

  // Phase 4 (189): Notify regardless of hostRole — child TUI shows the block,
  // owner TUI shows both notify and menu (notify complements the menu).
  // Zero token cost, no prompt channel.
  // Respect output.pipelineStage setting (default true, explicit false disables TUI output)
  if (config.output?.pipelineStage !== false) {
    const notifyMsg = `Pipeline blocked: ${reason} at stage '${meta.currentStage}'. ${formatDecisionMenuHint()}`;
    ctx.ui?.notify?.(notifyMsg);
  }

  // Phase 1 (173) C7: Child sessions skip menu prompt and retry scheduling.
  // The freeze state is recorded (owner will see it on next settle/shortcut/replay).
  if (hostRole === "child") {
    // Phase 6 (195): Flag owner to show menu once on next interaction (15-B/C)
    ctx.session.updateMeta({ menuEscalationPending: true });
    await safeWriteAuditLog("menu_escalation_armed", {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
      reason,
    });

    // 203_Bug Phase 0 (RC1): Broadcast the freeze escalation on the event bus
    // so the owner instance can wake immediately (followUp), instead of
    // waiting for its next settle/shortcut/replay — freezes previously sat
    // silent for tens of hours. Wake ≠ popup: promptDecisionMenu remains the
    // single popup entry (owner consumes menuEscalationPending at end of turn).
    // Fail-safe: broadcastEscalation never throws.
    const escalationPayload: EscalationPayload = {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
      reason,
      at: Date.now(),
    };
    broadcastEscalation(ctx.pi, escalationPayload);
    await safeWriteAuditLog("menu_escalation_broadcast", {
      pipelineId: meta.pipelineId,
      stage: meta.currentStage,
      reason,
    });
    return;
  }

  // Delegate to promptDecisionMenu for the UI interaction
  const frozenMeta = { ...meta, flowState: "blocked" as const, blockedReason: reason };
  // Fix: do NOT pre-schedule timer here — it would fire during the awaited first
  // prompt, creating a concurrent second select (stacking violation per review #1b).
  // Instead, if the first prompt returns "interrupted" (streaming dismiss < 1500ms),
  // arm the retry scheduler AFTER the prompt returns. This prevents stacking while
  // still ensuring the menu re-appears after streaming settles.
  const outcome = await promptDecisionMenu(ctx, frozenMeta, config, {
    ...opts,
    onStageChanged: opts?.onStageChanged,
  });
  if (outcome === "interrupted") {
    scheduleDecisionRetry(ctx, frozenMeta, config, 1, {
      onStageChanged: opts?.onStageChanged,
    });
  }
}
