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

import type { SessionMeta } from "../types";
import { getFlowState } from "./flow-state";
import { registerEscalationObserver, type EscalationPayload } from "../utils/escalation-bus";

/**
 * Owner escalation observer dependencies.
 */
export interface OwnerEscalationDeps {
  /** Read current SessionMeta (owner session) */
  getMeta: () => SessionMeta | undefined;
  /** Send followUp message to owner (wake channel, deliverAs: "followUp") */
  sendFollowUp: (summary: string) => void;
  /** Immediate status-bar refresh at escalation event */
  syncStatusBar: () => void;
  /** Audit log writer */
  audit: (event: string, payload: Record<string, unknown>) => void;
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
  const meta = deps.getMeta();
  if (!meta) {
    deps.audit("owner_wake_escalation_skipped", {
      reason: "no_meta",
      pipelineId: payload.pipelineId,
      stage: payload.stage,
    });
    return;
  }

  const flow = getFlowState(meta);
  const matched =
    meta.pipelineId === payload.pipelineId &&
    flow === "blocked" &&
    meta.menuEscalationPending === true &&
    payload.stage === meta.currentStage;

  if (!matched) {
    deps.audit("owner_wake_escalation_skipped", {
      reason: "predicate_mismatch",
      pipelineId: payload.pipelineId,
      stage: payload.stage,
      localPipelineId: meta.pipelineId ?? "",
      localStage: meta.currentStage,
      flowState: flow,
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

  // Wake only — promptDecisionMenu (the sole popup entry) runs when the
  // owner's turn ends and consumes menuEscalationPending itself.
  deps.sendFollowUp(buildEscalationWakeSummary(payload));

  deps.audit("owner_wake_escalation", {
    pipelineId: payload.pipelineId,
    stage: payload.stage,
    reason: payload.reason,
    at: payload.at,
  });
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
