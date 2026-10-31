/**
 * @module auto-pipeline/round-budget
 * 219 Phase 3 §7c: an INDEPENDENT design-review round budget.
 *
 * Facts (B2 round 2):
 * - `checkBudget` is NOT reused: 4 of its 5 call sites consume an ALREADY
 *   dispatched round's result, and freezing there would throw away the last
 *   legitimate PASS.
 * - The predicate is consulted ONLY at the two PRE-DISPATCH points
 *   (`handleReviewReady` / `handleFail`). `handleReviewRunning` /
 *   `handleUpdateReady` / `handleUpdateRunning` never freeze for this budget.
 * - Counting is monotonic: a rewind (report deleted, plan rolled back) does
 *   NOT refund a counted round, otherwise "delete the report → re-review"
 *   would bypass the budget entirely.
 * - Human mode is untouched: without `meta.autoJob` both helpers are inert.
 */

import type { PipelineStage, SessionMeta } from "../../types";

/**
 * TRUE only when an auto job set a threshold AND this doc already used it up.
 * `designReviewMaxRounds` missing ⇒ budget not configured ⇒ never exhausted
 * (human mode and auto jobs that never set the field).
 */
export function isDesignReviewRoundBudgetExhausted(meta: SessionMeta): boolean {
  const auto = meta.autoJob;
  if (!auto) return false;
  const max = auto.designReviewMaxRounds;
  if (max === undefined || max <= 0) return false;
  return (auto.designReviewRounds ?? 0) >= max;
}

/**
 * Count one dispatched review round, deduped by round number.
 *
 * @returns the meta patch to commit, or `null` when nothing changes (human
 *   mode, no round number, or an already counted / rewound round).
 */
export function noteDesignReviewDispatch(
  meta: SessionMeta,
  round: number | undefined,
): Partial<SessionMeta> | null {
  const auto = meta.autoJob;
  if (!auto) return null;
  if (round === undefined || !Number.isFinite(round)) return null;
  const lastCounted = auto.lastCountedDesignReviewRound ?? 0;
  // Dedupe + monotonic: `round <= lastCounted` is either the same dispatch seen
  // again or a rewind — neither may refund budget.
  if (round <= lastCounted) return null;
  return {
    autoJob: {
      ...auto,
      designReviewRounds: (auto.designReviewRounds ?? 0) + 1,
      lastCountedDesignReviewRound: round,
    },
  };
}

/**
 * Stage the budget applies to. Exported so the coordinator comment / tests can
 * assert the scope without duplicating the literal.
 */
export const DESIGN_REVIEW_BUDGET_STAGE: PipelineStage = "design-review";
