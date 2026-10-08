/**
 * @module design-review/decision-display
 * 193 Phase 3 (task 8): ONE read-only display view for a design-review that is
 * paused on a pending HUMAN plan-revision decision.
 *
 * Plan requirement: `pipeline-state.ts`, `pipeline-ui.ts`,
 * `pipeline-status.ts` and the prompt dynamic context must show ONLY the
 * pending status, the pinned decision mode, the bound report and the explicit
 * `/pipeline-resume` recovery instruction — never an automatic next stage, a
 * writable-report advertisement, or any wording that encourages the model to
 * self-execute while `decision-guard` enforces the read-only tool chain.
 *
 * Boundaries (intentionally narrow):
 * - Pure view over caller-provided meta: no I/O, no meta writes, no verdicts.
 * - Re-uses the single pending predicate (`isDesignReviewDecisionPending`) so
 *   every display surface speaks with exactly the same voice as the permission
 *   guard that blocks mutations.
 * - Defensive on malformed state: a decision-pending pause WITHOUT a readable
 *   decision record still renders an honest pending view (mode falls back to
 *   the operation-pinned `reviewConfirmMode`, then to "unknown") — a missing
 *   record never fabricates a choice and never unlocks the write path.
 */

import type { SessionMeta } from "../../types";
import { isDesignReviewDecisionPending } from "./decision-guard";
import { HUMAN_DECISION_OPTIONS, HUMAN_DECISION_TITLE } from "./human-decision";

/**
 * Status-bar token shown while the human decision awaits a choice. It replaces
 * any next-stage hint so the bar never advertises an automatic step
 * (the decision executor already rejects every dangerous action).
 */
export const DESIGN_REVIEW_PENDING_TARGET = "awaiting-decision";

/** One-line READ-ONLY statement shared by every status surface (English). */
export const DESIGN_REVIEW_PENDING_READONLY_NOTICE =
  "PAUSED — awaiting a HUMAN plan-revision decision (session is READ-ONLY).";

/** Recovery instruction shared by every status surface (English). */
export const DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION =
  `A human must run /pipeline-resume in the owner session to present the ` +
  `"${HUMAN_DECISION_TITLE}" menu (${HUMAN_DECISION_OPTIONS.join(" / ")}). ` +
  `The pipeline continues only after that choice is recorded.`;

/** Bounded read-only view of the pending human decision for display surfaces. */
export interface DesignReviewPendingDecisionView {
  /** `pending` (no choice yet) or `chosen` (persisted, action not yet finished) */
  state: "pending" | "chosen";
  /** Persisted choice token when `state === "chosen"`, else null */
  choice: string | null;
  /** Confirmation mode PINNED on the decision record (fallbacks, never invented) */
  mode: string;
  /** Canonical FAIL report path bound to the decision */
  reportDoc: string;
  /** Bound issue count carried by the decision record (0 when absent) */
  issueCount: number;
}

/**
 * Build the display view when THIS meta is paused on a decision-pending human
 * review. Returns `null` whenever the pipeline is NOT in that state — the
 * regular (pre-193) displays then apply unchanged.
 */
export function buildDesignReviewPendingDecisionView(
  meta: SessionMeta | undefined,
): DesignReviewPendingDecisionView | null {
  if (meta === undefined || !isDesignReviewDecisionPending(meta)) return null;
  const dr = meta.designReview;
  if (dr === undefined) return null;
  const decision = dr.decision;
  return {
    state: decision?.state ?? "pending",
    choice: decision?.state === "chosen" ? decision.choice : null,
    mode: decision?.mode ?? dr.operation?.reviewConfirmMode ?? "unknown",
    reportDoc: decision?.reportDoc ?? dr.reportDoc ?? "the design review report",
    issueCount: decision?.issues.length ?? 0,
  };
}

/**
 * One-line human-readable decision summary (state + optional choice + mode +
 * bound report/issues) used verbatim by the status surfaces.
 */
export function formatDesignReviewPendingDecision(
  view: DesignReviewPendingDecisionView,
): string {
  const choicePart = view.choice !== null ? ` (choice: ${view.choice})` : "";
  return (
    `${view.state}${choicePart} — mode: ${view.mode}; ` +
    `report: ${view.reportDoc}; issues: ${view.issueCount}`
  );
}
