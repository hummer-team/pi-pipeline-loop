/**
 * @module confirm-gate-owner-reprompt
 * 211_Bug Phase 0: owner-side re-presentation entry for a confirm gate that a
 * child session suppressed (181). Wake ≠ popup: this is the ONLY popup entry
 * for the settle path; the escalation channel (211 Phase 1) only wakes the
 * owner.
 *
 * Entry contract (211_Bug.md Round-1 Q1-A + Round-2 Q1-A): the hook calls this
 * from the NON-pipeline-turn branch of `agent_settled` — before the
 * `agent_settled_non_pipeline_turn` audit — so a presented gate is never
 * mislabelled as ordinary chat. Pipeline turns keep their verify → gate
 * order (180) untouched.
 *
 * Fail-open: every refusal path returns `consumed:false` so the caller falls
 * back to the pre-existing non-pipeline-turn behaviour, and every skip is
 * audited with a stable reason (see {@link OwnerRepromptSkipReason}).
 */

import type { PipelineConfig, PipelineStage, SessionMeta } from "../types";
import type { RuntimeCtx } from "./runtime-ctx";
import { CONFIRM_GATE_REASK_MAX } from "../constants";
import { writeAuditLog } from "../utils/auditLog";
import { detectSessionRole } from "./session-role";
import {
  detectPendingConfirmGate,
  formatConfirmGatePendingCopy,
  maybeHandleConfirmGate,
  recordConfirmGateOutcome,
} from "./stage-advancer";

/**
 * Why the owner entry refused to present the gate (audit-only values).
 * Consumed by the internal `auditOwnerSkip` helper — the union is the single
 * source of truth for the four literals (review observation 2: no orphan
 * export, no spelling drift).
 */
export type OwnerRepromptSkipReason =
  | "child"
  | "not_bound"
  | "predicate_mismatch"
  | "reask_exhausted";

/** Stable outcome for the caller — no UI/state types leak into agent-settled. */
export interface OwnerRepromptOutcome {
  /** true ⇒ caller must return (gate handed over or notify-only terminal state). */
  consumed: boolean;
  action?: "advanced" | "routed" | "pending" | "aborted" | "reask_exhausted";
  toStage?: PipelineStage;
  /** Re-ask count AFTER accounting (0 when not applicable). */
  reask: number;
}

/**
 * Writes the skip audit. `reason` is typed by {@link OwnerRepromptSkipReason}
 * so the audit vocabulary can never drift from the module contract (review
 * observation 2). Audit-only values: payloads persist as `string | boolean`.
 */
async function auditOwnerSkip(
  meta: SessionMeta,
  reason: OwnerRepromptSkipReason,
): Promise<void> {
  await writeAuditLog("confirm_gate_owner_reprompt_skipped", {
    pipelineId: meta.pipelineId ?? "unknown",
    stage: meta.currentStage,
    reason: reason,
  });
}

/**
 * Re-presents a child-suppressed confirm gate on the owner settle path.
 *
 * Implementation order mirrors 211_Bug.md §1.2 exactly — the first hit
 * returns:
 * 1. `child`        → skip audit, fall back to the non-pipeline turn.
 * 2. `not_bound`    → module-level defence branch (hook callers are already
 *                     covered by the `isDormant` guard, so this stays
 *                     unreachable at hook level by design — review #6).
 * 3. predicate miss → `predicate_mismatch` audit when a deferral trace exists
 *                     (a stamp that detectPendingConfirmGate cannot act on),
 *                     silent otherwise (no-trace noise is avoided).
 * 4. gate hit       → bounded re-ask budget check, then reuse the existing
 *                     `maybeHandleConfirmGate` dialog with 177/179/180
 *                     accounting untouched.
 *
 * @param ctx - Runtime context (session + pi evidence for child detection)
 * @param config - Pipeline configuration
 * @param meta - Current session metadata snapshot
 * @param ui - Owner UI wrapper (ctx-bound notify)
 */
export async function maybeRepromptOwnerConfirmGate(
  ctx: RuntimeCtx,
  config: PipelineConfig,
  meta: SessionMeta,
  ui: { notify: (ctx: unknown, msg: string) => void },
): Promise<OwnerRepromptOutcome> {
  // Step 1: child sessions must never present the gate (181 contract).
  // Known acceptable audit volume (review observation 3): a child's pipeline
  // turn never reaches this branch (PIPELINE_TURN_SIGNATURES), only a child
  // chat turn writes one extra line — no throttling needed.
  const { isChild, sessionFile } = detectSessionRole(ctx);
  if (isChild) {
    await auditOwnerSkip(meta, "child");
    return { consumed: false, reask: 0 };
  }

  // Step 2: module-level defence for direct (non-hook) callers. At hook level
  // `isDormant` already returned on a missing meta/pipelineId, so this branch
  // stays unreachable there — do NOT relax `isDormant` to reach it (review #6).
  if (!meta.pipelineId) {
    await auditOwnerSkip(meta, "not_bound");
    return { consumed: false, reask: 0 };
  }

  // Step 3: a deferral trace exists but the pending-gate predicate refuses —
  // audit the mismatch so "stamp present, no gate" stays diagnosable; a
  // settle with NO trace stays silent (avoid audit noise).
  if (!(await detectPendingConfirmGate(config, meta))) {
    if (meta.confirmGateDeferredAt) {
      await auditOwnerSkip(meta, "predicate_mismatch");
    }
    return { consumed: false, reask: 0 };
  }

  // Step 4: recompute the re-ask budget with the same formula as the
  // pipeline-turn path (agent-settled.ts:850). The budget deliberately drives
  // the entry here (the predicate itself is budget-free — a 180 decision).
  const reask = meta.confirmGateReask;
  const reaskExhausted =
    reask?.stage === meta.currentStage && reask.count >= CONFIRM_GATE_REASK_MAX;
  if (reaskExhausted) {
    ui.notify(ctx, formatConfirmGatePendingCopy(config, meta.currentStage));
    await auditOwnerSkip(meta, "reask_exhausted");
    return { consumed: true, action: "reask_exhausted", reask: reask?.count ?? 0 };
  }

  // Capture the stage BEFORE the gate may advance (the outcome audit and the
  // caller's terminal-compact decision both need the original stage).
  const stage = meta.currentStage;
  // Review #5: the pipeline turn passes `defaultReject` built from the review
  // report parse (agent-settled.ts:578-636), which flips the REVIEW option
  // order (stage-advancer.ts:1113-1115). The chat/settle entry must not
  // silently invert that: for review we keep the conservative default (no
  // freshly parsed report ⇒ reject first), so an unverified "pass" can never
  // land on top of the first position.
  const defaultReject = stage === "review" ? true : undefined;
  const gate = await maybeHandleConfirmGate(config, ctx, meta, ui, {
    mode: "manual",
    isChild: false,
    sessionFile,
    source: "owner_reprompt",
    ...(defaultReject !== undefined ? { defaultReject } : {}),
  });
  if (gate.result !== "handled") {
    // no-gate (e.g. marker already present) → fall back to the original branch.
    return { consumed: false, reask: 0 };
  }

  // Reuse the shared 180 accounting (isChild=false; deferrals never count).
  recordConfirmGateOutcome(ctx.session, meta, gate, false, ctx);
  const fresh = ctx.session.getMeta();
  await writeAuditLog("confirm_gate_owner_reprompt", {
    pipelineId: meta.pipelineId ?? "unknown",
    stage,
    action: gate.action,
    toStage: gate.toStage ?? "",
    reask: String(fresh?.confirmGateReask?.count ?? 0),
    deferred: gate.deferred === true,
    source: "settle",
  });
  return {
    consumed: true,
    action: gate.action,
    toStage: gate.toStage,
    reask: fresh?.confirmGateReask?.count ?? 0,
  };
}
