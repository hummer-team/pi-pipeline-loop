/**
 * @module design-review/decision-types
 * 193 Phase 1: shared DECISION data types for the design-review domain.
 *
 * This file is deliberately import-free (pure type/value declarations) so
 * `src/types.ts` can bridge these types into the persisted meta/outcome shapes
 * without creating a module cycle. Business policy (which decision is valid
 * when) lives in `smart-decision.ts` / the verifier, never here.
 *
 * Later phases append their records here (193: human decision record/basis)
 * — one file is the canonical home for design-review decision payloads.
 */

/** The ONLY two actions a smart-mode FAIL decision may select. */
export const SMART_PLAN_REVISION_ACTIONS = ["revise-plan", "request-human"] as const;

export type SmartPlanRevisionAction = (typeof SMART_PLAN_REVISION_ACTIONS)[number];

/**
 * 193 Phase 1: the machine-readable plan-revision decision a FAIL report must
 * carry when the design-review stage runs in SMART confirmation mode.
 *
 * - `revise-plan` — the plan may be revised autonomously from the listed
 *   issues (routes to the authorized plan-update dispatch).
 * - `request-human` — the issues need a human call; smart mode NEVER releases
 *   FAIL itself, so this parks the loop for the (Phase 2) manual decision menu.
 *
 * `proceed-develop` is intentionally NOT expressible here: a FAIL verdict can
 * never ask to enter development.
 */
export interface SmartPlanRevisionDecision {
  /** Binary action token (exact lowercase form is part of the machine protocol) */
  action: SmartPlanRevisionAction;
  /** Non-empty, non-placeholder justification line captured from the report */
  reason: string;
}
