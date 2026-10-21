/**
 * @module decision-policy/policy-provider
 * 210 Phase 1: automatic decision application for the decision-provider
 * chain (requirement 5.3, I3).
 *
 * The provider has NO direct write capability of its own: all state changes
 * go through `flow-state.executeDecision` (dynamically imported here to avoid
 * the static flow-state ⇄ decision-policy cycle), so a policy decision
 * passes the exact same guards and audit channels as a human one.
 */
import type { PipelineConfig, PipelineDecision, SessionMeta } from "../../types";
import { resolveRule } from "./policy-config";
import { safeWriteAuditLog } from "../../utils/auditLog";
import type { FlowStateCtx } from "../flow-state";

/** Result of one policy application attempt. */
export interface PolicyApplyResult {
  /** A matching rule was applied successfully (state actually changed). */
  applied: boolean;
  /** A matched rule was rejected by a guard (B-3: single-shot abort follows). */
  rejected?: boolean;
  /** The decision the (matched) rule wanted, for audit attribution. */
  decision?: PipelineDecision;
}

/**
 * Applies the policy rule for the current freeze, if any.
 *
 * - No rule (policy off / no entry) → `{ applied: false }` — the caller owns
 *   the "provider absent" convergence.
 * - Matched rule → routed through `executeDecision` with
 *   `{ decisionSource: "policy" }` so `pipeline_decision` audit records WHO
 *   decided (I4).
 * - Guard rejection (`success === false`) → B-3: audit
 *   `policy_decision_rejected` (warn) and report `rejected: true` — the
 *   caller performs the single-shot abort; the policy is never retried.
 *
 * @param ctx - FlowStateCtx (session/ui access owned by the caller)
 * @param meta - FRESH meta snapshot re-read by the caller
 * @param config - PipelineConfig with the decisionPolicy block
 * @param reason - Current blockedReason (freeze cause)
 * @param trigger - What invoked this provider attempt ("timeout" | "no_ui")
 */
export async function tryApplyPolicy(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  config: PipelineConfig,
  reason: string,
  trigger: "timeout" | "no_ui",
): Promise<PolicyApplyResult> {
  const resolved = resolveRule(meta, config, reason);
  if (!resolved) return { applied: false };
  const { rule } = resolved;

  // Dynamic import: breaks the static flow-state ⇄ policy cycle
  // (same pattern as stage-advancer.ts:401).
  const { executeDecision } = await import("../flow-state");
  const res = await executeDecision(ctx, meta, rule.decision, config, {
    source: "freeze",
    decisionSource: "policy",
    trigger,
    ...(rule.targetStage !== undefined ? { targetStage: rule.targetStage } : {}),
    ...(rule.budgetValue !== undefined ? { budgetValue: rule.budgetValue } : {}),
  });

  if (res.success) {
    return { applied: true, decision: rule.decision };
  }

  // B-3 (single-shot): report the rejection ONCE; the caller aborts and the
  // chain never retries the policy.
  // Two audit records, one per vocabulary (Phase 1 acceptance):
  // - `decision_not_applied` is the canonical "a decision did not change the
  //   state" event (same event the human menu path writes);
  // - `policy_decision_rejected` carries the policy attribution and mirrors
  //   the `pipeline_session_aborted(reason=policy_decision_rejected)` the
  //   caller emits right after this returns.
  await safeWriteAuditLog("decision_not_applied", {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    decision: rule.decision,
    source: "freeze",
    decisionSource: "policy",
    trigger,
    reason: "guard_rejected",
    message: res.message,
  });
  await safeWriteAuditLog("policy_decision_rejected", {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    decision: rule.decision,
    reason,
    trigger,
    detail: res.message,
  }, "warn");
  return { applied: false, rejected: true, decision: rule.decision };
}
