/**
 * @module confirm-gate-escalation
 * 211_Bug Phase 1: one-shot arm/clear/summary single source for the
 * child-suppressed confirm gate wake channel.
 *
 * Wake ≠ popup (203 principle): arming only produces an owner wake on the
 * `pipeline:escalation-armed` bus; the TUI dialog stays owned by the settle
 * side re-presentation entry (211 Phase 0). The reason constant and the
 * visit-identity helper are shared by `stage-advancer` (child side) and
 * `owner-escalation` (wake side) so the string can never drift.
 *
 * Fail-open: a missing `pi` (non-hook callers have no bus context) arms
 * nothing — the stamp alone keeps the gate discoverable via
 * `/pipeline-resume`; broadcast/audit errors are absorbed downstream.
 */

import type { PipelineStage, SessionMeta } from "../types";
import type { SessionState } from "./session-state";
import { broadcastEscalation } from "../utils/escalation-bus";
import { safeWriteAuditLog } from "../utils/auditLog";

/** Escalation reason broadcast when a child suppresses a real confirm gate. */
export const CONFIRM_GATE_ESCALATION_REASON = "confirm_gate_pending";

/**
 * Visit identity used to scope the one-shot arm. `stageVisitOrder.length` is
 * the same dedup key the owner-wake terminal channel uses, and grows on every
 * rework re-entry, letting the arm re-fire once per stage visit.
 */
export function currentStageVisitOrder(meta: SessionMeta): number {
  return meta.stageVisitOrder?.length ?? 0;
}

/**
 * Arms the confirm-gate escalation exactly once per (stage, visitOrder).
 *
 * Semantics:
 * - `!pi` ⇒ pure no-op (`false`): non-hook callers have no bus context, so
 *   fail-open without writing meta.
 * - same stage AND same visitOrder already armed ⇒ idempotent `false`: no
 *   repeated `updateMeta`, no repeated broadcast (anti wake-storm).
 * - otherwise: write the credential → broadcast → audit → `true`.
 *
 * @returns true when a real arm happened (credential written + broadcast)
 */
export async function armConfirmGateEscalation(input: {
  pi: unknown;
  session: Pick<SessionState, "updateMeta">;
  meta: SessionMeta;
  stage: PipelineStage;
}): Promise<boolean> {
  if (!input.pi) return false;
  const visitOrder = currentStageVisitOrder(input.meta);
  const existing = input.meta.confirmGateEscalation;
  if (existing && existing.stage === input.stage && existing.visitOrder === visitOrder) {
    return false;
  }
  const at = Date.now();
  input.session.updateMeta({ confirmGateEscalation: { stage: input.stage, visitOrder, at } });
  // Fail-safe bus (never throws); reuses the single 203 bus event name.
  broadcastEscalation(input.pi, {
    pipelineId: input.meta.pipelineId ?? "",
    stage: input.stage,
    reason: CONFIRM_GATE_ESCALATION_REASON,
    at,
  });
  await safeWriteAuditLog("confirm_gate_escalation_armed", {
    pipelineId: input.meta.pipelineId ?? "unknown",
    stage: input.stage,
    visitOrder: String(visitOrder),
  });
  return true;
}

/**
 * Clears the arm credential. Idempotent: writes only when a credential is
 * present ("presentation consumes the wake; resolution clears everything").
 */
export function clearConfirmGateEscalation(
  session: Pick<SessionState, "updateMeta">,
  meta: SessionMeta,
): void {
  if (!meta.confirmGateEscalation) return;
  session.updateMeta({ confirmGateEscalation: undefined });
}

/**
 * Wake summary for the confirm-gate escalation.
 *
 * MUST NOT look like a pipeline turn (asserted by a unit test): the owner's
 * settle classifies turns via PIPELINE_TURN_SIGNATURES / bare-doc matching,
 * and the wake must fall into the NON-pipeline branch so the Phase 0 entry
 * presents the gate.
 */
export function buildConfirmGatePendingWakeSummary(stage: PipelineStage): string {
  return `Pipeline notice: stage "${stage}" is waiting for human confirmation. ` +
    `The confirmation dialog opens when this turn ends. ` +
    `If no dialog appears, run /pipeline-resume.`;
}
