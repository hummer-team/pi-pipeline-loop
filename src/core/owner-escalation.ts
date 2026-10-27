/**
 * @module owner-escalation
 * 203_Bug Phase 0 (RC1): Owner-side wake listener for child freeze escalations.
 *
 * When a child session freezes (threshold hit) it broadcasts on the pi event
 * bus (`pipeline:escalation-armed`, see escalation-bus). This module subscribes
 * on the owner instance and wakes the owner via `followUp` so the decision
 * menu is presented as soon as the owner's turn ends
 * (`promptDecisionMenu` consumes `menuEscalationPending`).
 *
 * Design rules (from the plan):
 * - wake ≠ popup: this listener must NOT call `promptDecisionMenu`; the
 *   followUp唤醒 lets agent-settled render the menu through the existing
 *   consumption point (唯一弹窗入口不变).
 * - Idempotent by `menuEscalationPending`: the child only arms the flag on the
 *   first running→blocked transition; owner consumption clears it, so repeated
 *   broadcasts will not re-wake.
 * - Refresh-only state bar: `syncStatusBar` mirrors owner-wake's fallback.
 *
 * The module-level deps accessor follows the owner-wake pattern: deps are
 * refreshed on every hook invocation (SDK limitation: global events carry no
 * session context).
 */

import type { SessionMeta, PipelineStage } from "../types";
import { getFlowState, isFrozen } from "./flow-state";
import { registerEscalationObserver, type EscalationPayload } from "../utils/escalation-bus";
// 211 Phase 1: distinct reason for the child-supplied confirm-gate wake channel
import {
  CONFIRM_GATE_ESCALATION_REASON,
  buildConfirmGatePendingWakeSummary,
  currentStageVisitOrder,
} from "./confirm-gate-escalation";
// 216 P3 (R5-Q2-A): running-state stage-exit refusal channel (no frozen state,
// credential = `stageExitRefusal.escalatedAt` matched against payload.at)
import { STAGE_EXIT_REFUSED_ESCALATION_REASON } from "../constants";

/**
 * Owner escalation observer dependencies.
 */
export interface OwnerEscalationDeps {
  /** Read current SessionMeta (owner session) */
  getMeta: () => SessionMeta | undefined;
  /**
   * Send followUp message to owner (wake channel, deliverAs: "followUp").
   * 211 Phase 1: returns `true` = delivered, `false` = delivery failed
   * (requires a visible fallback hint); `void`-returning callers from 203
   * remain assignable (their `true` is simply ignored downstream via truthy
   * default handling in the bridge).
   */
  sendFollowUp: (summary: string) => boolean;
  /** Immediate status-bar refresh at escalation event */
  syncStatusBar: () => void;
  /** Audit log writer */
  audit: (event: string, payload: Record<string, unknown>) => void;
  /** 211 Phase 1: actionable fallback when the wake could not be delivered. */
  notifyHint?: (stage: PipelineStage) => void;
  /**
   * Role gate: `false` when these deps belong to a child session.
   * Owner/child share this module in-process, so the evaluation itself must
   * refuse to wake for child-bound deps (defense in depth — the index bridge
   * already avoids installing child deps). Defaults to `true` for callers
   * that predate the gate.
   */
  isOwner?: boolean;
}

/** Module-level deps accessor (refreshed on every hook invocation). */
let _ownerEscalationDeps: OwnerEscalationDeps | null = null;

/**
 * Sets (or clears) the owner escalation deps accessor.
 * Called on every hook invocation to keep deps fresh.
 *
 * @param deps - Owner escalation dependencies, or null to detach
 */
export function setOwnerEscalationDeps(deps: OwnerEscalationDeps | null): void {
  _ownerEscalationDeps = deps;
}

/**
 * Registers the owner escalation observer on the pi event bus.
 * Called once during plugin init (owner instance only).
 *
 * @param pi - Raw pi ExtensionAPI (structural)
 * @returns Cleanup function that removes the subscription
 */
export function registerOwnerEscalationObserver(pi: unknown): () => void {
  return registerEscalationObserver(pi, (payload: EscalationPayload) => {
    try {
      if (!_ownerEscalationDeps) return;
      evaluateEscalationWake(payload, _ownerEscalationDeps);
    } catch {
      // Fail-safe: observer errors must not crash the pipeline
    }
  });
}

/**
 * Evaluates whether the owner should be woken for an escalation event.
 *
 * Wake requires ALL of:
 * 1. Same pipelineId (session must own this pipeline)
 * 2. Pipeline currently blocked (freeze is a fact)
 * 3. `menuEscalationPending === true` (menu not yet shown — natural dedup)
 * 4. Same stage as the escalation payload
 *
 * Otherwise the event is skipped with an `owner_wake_escalation_skipped` audit.
 */
export function evaluateEscalationWake(
  payload: EscalationPayload,
  deps: OwnerEscalationDeps,
): void {
  // Role gate (203_Bug review fix): a child session shares this module with
  // the owner. If child-bound deps were ever installed (or an observer fires
  // in the child instance), the broadcast must NOT wake the child itself and
  // must never emit `owner_wake_escalation`.
  if (deps.isOwner === false) {
    deps.audit("owner_wake_escalation_skipped", {
      reason: "child_session",
      pipelineId: payload.pipelineId,
      stage: payload.stage,
    });
    return;
  }

  const meta = deps.getMeta();
  if (!meta) {
    deps.audit("owner_wake_escalation_skipped", {
      reason: "no_meta",
      pipelineId: payload.pipelineId,
      stage: payload.stage,
    });
    return;
  }

  // 211 Phase 1: reason dispatch. The 203 frozen predicate stays VERBATIM (a
  // relaxation would break the `menuEscalationPending` dedup semantics); the
  // confirm-gate pending channel matches on its own arm credential instead.
  // 216 P3 (R5-Q2-A): the stage-exit refusal channel is a THIRD such arm —
  // running state + `escalatedAt === payload.at` credential (no freeze fact).
  const confirmPending = payload.reason === CONFIRM_GATE_ESCALATION_REASON;
  const stageExitRefused = payload.reason === STAGE_EXIT_REFUSED_ESCALATION_REASON;
  const matched = confirmPending
    ? matchesConfirmPendingEscalation(payload, meta)
    : stageExitRefused
      ? matchesStageExitRefusedEscalation(payload, meta)
      : matchesFrozenEscalation(payload, meta);

  if (!matched) {
    deps.audit("owner_wake_escalation_skipped", {
      reason: "predicate_mismatch",
      pipelineId: payload.pipelineId,
      stage: payload.stage,
      localPipelineId: meta.pipelineId ?? "",
      localStage: meta.currentStage,
      flowState: getFlowState(meta),
      menuEscalationPending: meta.menuEscalationPending === true,
    });
    return;
  }

  // Refresh the status bar first (fail-open on UI errors, mirroring owner-wake)
  try {
    deps.syncStatusBar();
  } catch {
    // fail-open: UI errors must not block the wake logic
  }

  // Wake only — the sole popup entries run when the owner's turn ends: the
  // frozen decision menu (203 consumption) or the Phase 0 re-presentation
  // entry (211 consumption) consumes its own state itself.
  if (!deps.sendFollowUp(
    confirmPending
      ? buildConfirmGatePendingWakeSummary(payload.stage)
      : stageExitRefused
        ? buildStageExitRefusedWakeSummary(payload.stage)
        : buildEscalationWakeSummary(payload),
  )) {
    // 211 Phase 1: undelivered wake — register the skip AND give the user a
    // visible, actionable fallback (no retry, no timers, no popups).
    deps.audit("owner_wake_escalation_skipped", {
      reason: "delivery_failed",
      pipelineId: payload.pipelineId,
      stage: payload.stage,
    });
    try {
      deps.notifyHint?.(payload.stage);
    } catch {
      // fail-open: hint errors must not block the wake logic
    }
    return; // NOT delivered ⇒ no owner_wake_escalation audit
  }

  deps.audit("owner_wake_escalation", {
    pipelineId: payload.pipelineId,
    stage: payload.stage,
    reason: payload.reason,
    at: payload.at,
  });
}

/**
 * 211 Phase 1: predicate for the `confirm_gate_pending` wake channel.
 * Requires the owner to run the SAME pipeline at the SAME stage with a
 * FRESH arm credential (stage + visitOrder match the current visit) while
 * the flow is `running` and not frozen — a `blocked` state belongs to the
 * frozen 203 channel, never to the confirm-gate channel.
 */
function matchesConfirmPendingEscalation(
  payload: EscalationPayload,
  meta: SessionMeta,
): boolean {
  if (meta.pipelineId !== payload.pipelineId) return false;
  if (payload.stage !== meta.currentStage) return false;
  const arm = meta.confirmGateEscalation;
  if (!arm || arm.stage !== payload.stage) return false;
  if (arm.visitOrder !== currentStageVisitOrder(meta)) return false;
  return getFlowState(meta) === "running" && !isFrozen(meta);
}

/**
 * 216 P3: predicate for the RUNNING-state stage-exit refusal wake channel.
 * There is no frozen fact and no menuEscalationPending to dedup on — the arm
 * credential itself is the dedup: `meta.stageExitRefusal.escalatedAt` equals
 * the broadcast payload `at`, and the refusal is still the CURRENT stage's.
 * A `blocked` state belongs to the frozen 203 channel, never to this arm.
 */
function matchesStageExitRefusedEscalation(
  payload: EscalationPayload,
  meta: SessionMeta,
): boolean {
  if (meta.pipelineId !== payload.pipelineId) return false;
  if (payload.stage !== meta.currentStage) return false;
  if (getFlowState(meta) !== "running") return false;
  return meta.stageExitRefusal?.escalatedAt === payload.at;
}

/**
 * 216 P3: owner-readable summary for the running-state refusal wake. Mentions
 * `stage_advance` explicitly so the owner knows WHICH session runs the retry
 * (the child could not consume its owner-bound run).
 */
function buildStageExitRefusedWakeSummary(stage: PipelineStage): string {
  return `Stage "${stage}" advance was refused: an unconsumed owner-bound run still owns this stage. `
    + `Run stage_advance from the main (owner) session. If it is refused again the pipeline freezes into the decision menu.`;
}

/**
 * 203 verbatim frozen-wake predicate, extracted without behavioural change.
 * Wake requires ALL of:
 * 1. Same pipelineId (session must own this pipeline)
 * 2. Pipeline currently blocked (freeze is a fact)
 * 3. `menuEscalationPending === true` (menu not yet shown — natural dedup)
 * 4. Same stage as the escalation payload
 */
function matchesFrozenEscalation(payload: EscalationPayload, meta: SessionMeta): boolean {
  return (
    meta.pipelineId === payload.pipelineId &&
    getFlowState(meta) === "blocked" &&
    meta.menuEscalationPending === true &&
    payload.stage === meta.currentStage
  );
}

/**
 * Builds the followUp summary message for the owner.
 */
function buildEscalationWakeSummary(payload: EscalationPayload): string {
  const parts = [
    `Pipeline stage "${payload.stage}" is blocked (${payload.reason}) and awaiting your decision.`,
    "The decision menu will appear when this turn ends.",
  ];
  if (payload.pipelineId) {
    parts.push(`Pipeline: ${payload.pipelineId}`);
  }
  return parts.join(" ");
}
