/**
 * @module design-review/decision-policy
 * 193 Phase 2 (task 5): the PURE routing policy for a TRUSTED design-review
 * report outcome. No I/O, no state writes — the coordinator calls this and
 * then executes the returned route with its existing receipts/visits/dispatch
 * machinery (the FAIL revision route deliberately reuses `handleFail`, never
 * a copied closed loop).
 *
 * Locked semantics (requirement rounds 1-4):
 * - a TRUSTED, complete PASS auto-advances to develop in ALL modes;
 * - a VALID FAIL in auto mode routes to the authorized plan revision;
 * - a VALID FAIL in manual mode requires the human decision menu;
 * - a VALID FAIL in smart mode follows ONLY its binary decision field
 *   (`revise-plan` | `request-human`) — smart NEVER releases FAIL itself;
 * - any INVALID report is correction-only and never routed to develop;
 *   a smart FAIL without a usable decision field degrades to correction.
 */

import type { ConfirmMode } from "../../types";
import type { SmartPlanRevisionAction } from "./decision-types";

/** The exhaustive routes a trusted report outcome can receive. */
export const DESIGN_REVIEW_ROUTE_ACTIONS = [
  "pass-develop",
  "revise-plan",
  "request-human",
  "invalid",
] as const;

export type DesignReviewRouteAction = (typeof DESIGN_REVIEW_ROUTE_ACTIONS)[number];

export interface DesignReviewRouteInput {
  /** Confirmation mode PINNED at review-dispatch preparation. */
  mode: ConfirmMode;
  /** Verdict of the TRUSTED, contract-valid report snapshot. */
  verdict: "pass" | "fail" | "invalid";
  /**
   * Machine-readable FAIL decision parsed from the SAME snapshot. Required
   * only for smart-mode FAIL (the domain verifier enforces its presence);
   * auto/manual routing ignores it entirely.
   */
  smartAction?: SmartPlanRevisionAction;
}

/**
 * Decide the route for one trusted outcome. Returns `invalid` defensively
 * when a smart FAIL carries no usable binary action — such reports are
 * correction-only and must NEVER be routed to develop or silently revised.
 */
export function decideDesignReviewRoute(input: DesignReviewRouteInput): DesignReviewRouteAction {
  switch (input.verdict) {
    case "invalid":
      return "invalid";
    case "pass":
      // Trusted complete PASS: every mode advances without a new confirmation.
      return "pass-develop";
    case "fail":
      switch (input.mode) {
        case "auto":
          return "revise-plan";
        case "manual":
          return "request-human";
        case "smart":
          // Smart FAIL follows ONLY the report's binary decision field;
          // smart mode itself NEVER releases development.
          if (input.smartAction === "revise-plan") return "revise-plan";
          if (input.smartAction === "request-human") return "request-human";
          return "invalid";
        default:
          return "invalid";
      }
    default:
      return "invalid";
  }
}
