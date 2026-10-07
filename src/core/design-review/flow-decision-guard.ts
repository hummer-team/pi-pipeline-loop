/**
 * @module design-review/flow-decision-guard
 * 193 Phase 3 (tasks 5/6): the SINGLE executor-level barrier for the generic
 * decision menu and for ordinary forward releases while a design-review flow
 * owns (or still owes) the pipeline.
 *
 * Why the coordinator checks are not enough: every frozen-pipeline escape —
 * the first menu, a re-prompt, shortcut keys, replay, `--force-resume` —
 * funnels into `executeDecision`, which historically let `skip` clear the
 * authorization and `choose_stage` jump anywhere. Acceptance requires that
 * while the domain is NOT legitimately ended (active or identity-blocked
 * loop), `skip` and jumps to develop/review/fix/awaiting_human/completed are
 * refused, and that an upstream rollback keeps a RECHECK barrier until a NEW
 * review authorization atomically clears it.
 *
 * Design:
 * - consult BEFORE any state touch inside `executeDecision` (re-reading the
 *   authoritative meta at the call site), so no invalidate/onStageChanged
 *   side effect can happen for a refused decision;
 * - the same recheck predicate is exported for the ordinary advance/verify/
 *   handoff commit sites (`isRecheckForwardReleaseBlocked`);
 * - rollback (upstream), abort, quit, restart and re-review entry are NOT
 *   blocked here — they are the legitimate escapes;
 * - other features' frozen decisions (no designReview, no marker) keep their
 *   original semantics unchanged (verdict ok).
 */

import type { PipelineConfig, PipelineStage, SessionMeta } from "../../types";
import type { PipelineDecision } from "../flow-state";
import { classifyDesignReviewFlow } from "./state";

/**
 * Forward-release targets that may never be reached by a generic decision
 * while the design-review domain owns the pipeline or owes a recheck.
 * (clarify/plan stay open: upstream rework is a legitimate escape and is
 * exactly what arms the recheck barrier.)
 */
export const DESIGN_REVIEW_BLOCKED_FORWARD_STAGES: readonly PipelineStage[] = [
  "develop",
  "review",
  "fix",
  "awaiting_human",
  "completed",
];

/** True when the stage is a forward release that the domain guards. */
export function isBlockedForwardStage(target: PipelineStage | undefined): boolean {
  return target !== undefined && DESIGN_REVIEW_BLOCKED_FORWARD_STAGES.indexOf(target) !== -1;
}

/**
 * True while a RECHECK barrier is armed for the CURRENT pipeline: the marker
 * exists, belongs to this pipelineId, and no ACTIVE design-review state exists
 * (an active loop governs itself through the coordinator; a new authorization
 * clears the marker in its own strict commit). A `finished` state next to a
 * marker is an anomaly — the conservative read (keep blocking) holds.
 */
export function isDesignReviewRecheckBarrierActive(meta: SessionMeta | undefined): boolean {
  if (!meta) return false;
  const marker = meta.designReviewRecheck;
  if (!marker) return false;
  // Old markers never cross pipelines (restart/new pipeline drops them).
  if (marker.pipelineId !== meta.pipelineId) return false;
  const cls = classifyDesignReviewFlow(meta);
  return cls.kind === "ordinary";
}

/** Concrete guidance for a recheck-blocked forward release. */
export function formatRecheckGuidance(meta: SessionMeta): string {
  const marker = meta.designReviewRecheck;
  const planDoc = marker ? marker.planDoc : "the plan";
  return (
    `Design-review RECHECK barrier: "${planDoc}" was rolled back upstream before its review ` +
    `loop ended legitimately. Forward release to develop/review/fix/awaiting_human/completed is ` +
    `blocked — run the design review again (choose stage "design-review", which re-authorizes and ` +
    `clears this barrier) or continue upstream work.`
  );
}

export type FlowDecisionGuardVerdict =
  | { ok: true }
  | {
      ok: false;
      /** Machine-readable refusal code (audit). */
      code:
        | "domain_active_skip_blocked"
        | "domain_active_forward_jump_blocked"
        | "recheck_skip_blocked"
        | "recheck_forward_jump_blocked";
      message: string;
    };

export interface FlowDecisionGuardInput {
  decision: PipelineDecision;
  /** choose_stage target (ignored for other decisions). */
  targetStage?: PipelineStage;
  /** The AUTHORITATIVE fresh meta — never a stale menu snapshot. */
  meta: SessionMeta;
  config: PipelineConfig;
}

/**
 * Guard a generic decision BEFORE it can touch any state.
 * Refusals (domain not legitimately ended):
 * - `skip` in any form (it clears the authorization and jumps to nextStage);
 * - `choose_stage` toward develop/review/fix/awaiting_human/completed.
 * Refusals (recheck barrier armed, state already cleared upstream):
 * - the same forward releases — via choose_stage target or, for `skip`, via
 *   the computed stage-chain target of the CURRENT stage.
 */
export function guardGenericFlowDecision(input: FlowDecisionGuardInput): FlowDecisionGuardVerdict {
  const { decision, targetStage, meta, config } = input;
  const cls = classifyDesignReviewFlow(meta);
  const domainActive = cls.kind === "authorized" || cls.kind === "blocked";

  if (domainActive) {
    if (decision === "skip") {
      return {
        ok: false,
        code: "domain_active_skip_blocked",
        message:
          `Design-review loop is active and has NOT ended legitimately — "skip" is refused ` +
          `(it would drop the authorization). Use re-review (choose stage "design-review"), ` +
          `rollback to an upstream stage (a RECHECK barrier then blocks forward release until ` +
          `a new review re-authorizes), or abort/quit to leave the pipeline.`,
      };
    }
    if (decision === "choose_stage" && isBlockedForwardStage(targetStage)) {
      return {
        ok: false,
        code: "domain_active_forward_jump_blocked",
        message:
          `Design-review loop is active and has NOT ended legitimately — jumping to ` +
          `"${String(targetStage)}" is refused. A valid PASS releases develop ONLY through the ` +
          `coordinator handoff; a valid FAIL acts ONLY on the persisted human decision. Use ` +
          `re-review, upstream rollback, or abort/quit.`,
      };
    }
  }

  // 193 Phase 3 (task 6): upstream rollback cleared the state but left the
  // marker — ordinary forward release must point back to re-review.
  if (isDesignReviewRecheckBarrierActive(meta)) {
    if (decision === "choose_stage" && isBlockedForwardStage(targetStage)) {
      return { ok: false, code: "recheck_forward_jump_blocked", message: formatRecheckGuidance(meta) };
    }
    if (decision === "skip") {
      // Skip's release target is the stage-chain nextStage (same lookup the
      // executor uses). Skipping UPSTREAM or INTO design-review is fine;
      // anything toward develop/review/fix/awaiting_human/completed is not.
      const toStage: PipelineStage = config.stages[meta.currentStage]?.nextStage ?? "completed";
      if (isBlockedForwardStage(toStage)) {
        return { ok: false, code: "recheck_skip_blocked", message: formatRecheckGuidance(meta) };
      }
    }
  }

  return { ok: true };
}

/**
 * 193 Phase 3 (task 6): the barrier consulted by the ORDINARY commit sites
 * (stage advance / verify pass-advance / handoff) before they release the
 * pipeline forward. An active domain is already intercepted by the
 * coordinator at those entries; this predicate covers the marker window
 * (state cleared by upstream rollback) and returns the refusal guidance.
 */
export function checkRecheckForwardRelease(
  meta: SessionMeta | undefined,
  targetStage: PipelineStage | undefined,
): { blocked: false } | { blocked: true; reason: string } {
  if (!meta || !isBlockedForwardStage(targetStage)) {
    return { blocked: false };
  }
  if (!isDesignReviewRecheckBarrierActive(meta)) {
    return { blocked: false };
  }
  return { blocked: true, reason: formatRecheckGuidance(meta) };
}
