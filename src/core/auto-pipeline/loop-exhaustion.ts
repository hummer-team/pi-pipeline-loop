/**
 * @module auto-pipeline/loop-exhaustion
 * 229 Phase 5 (F5/B3/B16): loop-FIRST exhaustion routing — PURE policy.
 *
 * Facts (boundaries):
 * - Loop identity WINS over any stage guess (问题 2): a `no_progress_detected`
 *   freeze raised by the review/fix loop must never be routed into the
 *   design-review loop and vice versa. `design_review_budget_exhausted` only
 *   routes when the design-review domain is ACTIVE; unknown reasons route
 *   nowhere (they keep their historical freeze-autopilot treatment).
 * - `resolveExhaustionTarget` maps the loop exit (B3): design-review → its
 *   configured `nextStage` (canonical `develop`), review/fix → `fix`'s
 *   configured `nextStage` (canonical `completed`). Fix MUST NOT loop back
 *   into review.
 * - Runtime topology check: the resolved target must not be the loop's own
 *   ENTRY stage; a violation fail-closes with `exhaustion_target_loops_back`
 *   (called with an error audit by the freeze-autopilot).
 */

import type { PipelineConfig, PipelineStage, SessionMeta } from "../../types";
import type { AutoJobConfig } from "./job-schema";

/** The two loops the exhaustion policy distinguishes (never mixes data). */
export type ExhaustionLoop = "designReview" | "reviewFix";

/** A resolved-exhaustion target: a pipeline stage or the parking stage. */
export type ExhaustionTarget = PipelineStage | "awaiting_human";

/** The machine reasons that authorize the 229 exhaustion exit. */
export const EXHAUSTION_REASONS = new Set<string>([
  "no_progress_detected",
  "design_review_budget_exhausted",
  "max_loop_cycles",
  "review_loop_budget_exhausted",
]);

/** Reason → degraded-pass reason mapping (问题 19: max_loop_cycles family). */
export const EXHAUSTION_REASON_TO_DEGRADED_REASON: Record<string, string> = {
  max_loop_cycles: "review_loop_budget_exhausted",
  review_loop_budget_exhausted: "review_loop_budget_exhausted",
  no_progress_detected: "no_progress_detected",
  design_review_budget_exhausted: "design_review_budget_exhausted",
};

/** True when the design-review domain currently holds an ACTIVE loop. */
export function isDesignReviewDomainActive(meta: SessionMeta): boolean {
  const dr = meta.designReview;
  if (!dr) return false;
  return ["review_running", "update_running", "review_ready", "update_ready", "pass_ready"].includes(
    dr.phase,
  );
}

/** True when the running stage belongs to the review/fix loop. */
export function isReviewFixStage(meta: SessionMeta): boolean {
  return meta.currentStage === "review" || meta.currentStage === "fix";
}

/**
 * Loop-FIRST routing for an exhausted loop (问题 2). Returns the loop the
 * reason belongs to, or `null` when the reason must NOT take the exhaustion
 * exit (falls back to `byReason`/`onFreeze` semantics).
 */
export function resolveExhaustionLoop(input: {
  meta: SessionMeta;
  job: AutoJobConfig;
  reason: string;
  config: PipelineConfig;
}): ExhaustionLoop | null {
  void input.config;
  const { meta, job, reason } = input;
  if (!EXHAUSTION_REASONS.has(reason)) return null;

  switch (reason) {
    case "no_progress_detected": {
      // Loop identity first: the review/fix ledger NEVER routes here from the
      // design-review domain.
      if (meta.reviewLedger?.loop === "reviewFix" || isReviewFixStage(meta)) {
        return "reviewFix";
      }
      if (isDesignReviewDomainActive(meta)) {
        return "designReview";
      }
      return null;
    }
    case "design_review_budget_exhausted": {
      if (!isDesignReviewDomainActive(meta)) return null;
      return "designReview";
    }
    case "max_loop_cycles":
    case "review_loop_budget_exhausted": {
      if (isReviewFixStage(meta)) return "reviewFix";
      if (isDesignReviewDomainActive(meta)) return "designReview";
      return null;
    }
    default:
      return null;
  }
}

/**
 * B16: an explicitly configured `onExhausted` value is honoured by the
 * freeze-autopilot precedence; the loop ROUTING itself is independent of the
 * action the policy then picks (`advance`/`await-human`/`stop`).
 */

/** Canonical canonical loop exit before topological validation (B3). */
export function canonicalLoopExit(config: PipelineConfig, loop: ExhaustionLoop): ExhaustionTarget {
  if (loop === "designReview") {
    return config.stages["design-review"]?.nextStage ?? "develop";
  }
  return config.stages["fix"]?.nextStage ?? "completed";
}

/** The stage that OPENS this loop (the topological guard's anchor). */
function loopEntryStage(config: PipelineConfig, loop: ExhaustionLoop): ExhaustionTarget {
  void config;
  return loop === "designReview" ? "design-review" : "review";
}

/**
 * Resolve ONE exhaustion target for the loop from the job/defaults + the
 * explicit token; then run the TOPOLOGY check (B3/R4-Q5 B) — the target must
 * not be the loop's own entry stage, and the review/fix exit must never be
 * `review`.
 */
export function resolveExhaustionTarget(input: {
  loop: ExhaustionLoop;
  token: "nextStage" | "awaiting_human";
  config: PipelineConfig;
  job: AutoJobConfig;
}): { ok: true; target: ExhaustionTarget } | { ok: false; code: "exhaustion_target_loops_back"; detail: string } {
  const { config, job } = input;
  if (input.token === "awaiting_human") {
    return { ok: true, target: "awaiting_human" };
  }
  const explicit = input.loop === "designReview"
    ? job.onExhaustedTarget?.designReview
    : job.onExhaustedTarget?.reviewFix;
  const raw = explicit ?? "nextStage";
  if (raw === "awaiting_human") return { ok: true, target: "awaiting_human" };
  const target = canonicalLoopExit(config, input.loop);
  if (target === loopEntryStage(config, input.loop) || (input.loop === "reviewFix" && target === "review")) {
    return {
      ok: false,
      code: "exhaustion_target_loops_back",
      detail: `loop ${input.loop} resolved target "${target}" which loops back into the loop itself`,
    };
  }
  return { ok: true, target };
}

/**
 * The CREATIVE override the decision menu resolves (B16): `?? advance`.
 */
export function resolveExhaustedAction(
  job: AutoJobConfig,
  loop: ExhaustionLoop,
): "advance" | "await-human" {
  const configured = loop === "designReview" ? job.onExhausted?.designReview : job.onExhausted?.reviewFix;
  const token = configured === undefined ? "advance" : configured;
  if (token === "stop") return "advance"; // consumed upstream by the routing arm
  if (token === "await-human") return "await-human";
  // an explicit target of awaiting_human degrades an advance to await-human
  const explicitTarget = loop === "designReview" ? job.onExhaustedTarget?.designReview : job.onExhaustedTarget?.reviewFix;
  if (explicitTarget === "awaiting_human" && token === "advance") return "advance";
  return "advance";
}
