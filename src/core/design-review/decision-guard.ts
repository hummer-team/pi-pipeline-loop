/**
 * @module design-review/decision-guard
 * 193 Phase 3 (task 8): read-only enforcement for the tool permission chain
 * while a design-review HUMAN PLAN-REVISION DECISION is pending.
 *
 * Semantics: a valid FAIL in manual/smart mode parks the loop in
 * `paused(decision-pending)` awaiting a human choice. During that window the
 * model must not mutate anything: write/edit tools and bash commands with
 * file-mutation targets are refused, while pure reads keep working. This is
 * deliberately NARROW — the corrective window of an INVALID report (phase
 * still `review_running`/`update_running`) stays writable (the Phase-0
 * correction opening), and every non-design-review pipeline is untouched.
 *
 * The bash decision reuses the EXISTING command classification
 * (`extractBashFileTargets` + canonical path handling + git default block)
 * inside tool-guard — no new shell parser is introduced here.
 */

import type { SessionMeta } from "../../types";

/** True while the design-review loop is paused for a PENDING human decision. */
export function isDesignReviewDecisionPending(meta: SessionMeta | undefined): boolean {
  const dr = meta?.designReview;
  return !!dr && dr.phase === "paused" && dr.pauseReason === "decision-pending";
}

/**
 * Returns the block reason when THIS meta puts the session in read-only
 * (pending human decision) mode for a mutating tool; `undefined` means the
 * regular permission chain decides.
 */
export function designReviewPendingWriteBlockReason(meta: SessionMeta | undefined): string | undefined {
  if (!isDesignReviewDecisionPending(meta)) {
    return undefined;
  }
  const reportDoc = meta?.designReview?.reportDoc ?? "the design review report";
  return (
    `FORBIDDEN: design-review awaits a human plan-revision decision (report: ${reportDoc}) — ` +
    `the session is READ-ONLY until the decision is made. write/edit and bash file mutations ` +
    `are blocked; reads still work. Run /pipeline-resume (owner session) to present the ` +
    `decision menu.`
  );
}
