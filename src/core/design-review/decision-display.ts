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
import {
  resolveDecisionOwnerFile,
  resolveOwnerSessionFile,
} from "./owner-evidence";
import type { DesignReviewActorInput } from "./decision-types";

/**
 * Status-bar token shown while the human decision awaits a choice. It replaces
 * any next-stage hint so the bar never advertises an automatic step
 * (the decision executor already rejects every dangerous action).
 */
export const DESIGN_REVIEW_PENDING_TARGET = "awaiting-decision";

/** One-line READ-ONLY statement shared by every status surface (English). */
export const DESIGN_REVIEW_PENDING_READONLY_NOTICE =
  "PAUSED — awaiting a HUMAN plan-revision decision (session is READ-ONLY).";

/** Recovery instruction shared by every status surface (English).
 * 212 Phase 3: STATE- and CONFIG-neutral single fact — true in all three
 * real states ("once": at most once; "off": 0 ≤ once; `chosen`: no further
 * auto pop). NEVER promises "will open" / "on its next turn" (review #8):
 * the automatic menu may already be spent, and an unanswerable owner-evidence
 * gap is surfaced separately via the `ownerEvidence` view field. */
export const DESIGN_REVIEW_PENDING_RESUME_INSTRUCTION =
  `A human decision is pending. The "${HUMAN_DECISION_TITLE}" menu ` +
  `(${HUMAN_DECISION_OPTIONS.join(" / ")}) opens at most once automatically in the owner ` +
  `session; /pipeline-resume always re-opens it. The pipeline continues only after a recorded choice.`;

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
  /**
   * 212 Phase 3 (review #2) + 213 Phase 0 (D17-③): read-only fact about the
   * recorded owner evidence, judged TOGETHER WITH the caller's identity when
   * one is available:
   * - `"missing"` — no owner evidence recorded at all;
   * - `"recorded"` — recorded; the caller can prove it (owner), OR the caller
   *   identity is unknown / a child (a child never gets the third state: D8
   *   forbids child takeovers, so advertising an unprovable record as
   *   "takeover-able here" would promise an exit that does not exist);
   * - `"recorded_unprovable"` (213, non-child only) — evidence is recorded at
   *   a session file DIFFERENT from this provable non-child caller: not
   *   answerable passively, but the resume channel's EXPLICIT takeover
   *   (Phase 1) is a real exit here.
   * Display only — never an authority itself.
   */
  ownerEvidence: "missing" | "recorded" | "recorded_unprovable";
  /**
   * 213 Phase 0 (round-8 review issue 9): read-only echo of the system-
   * recorded owner session file (verbatim, participates in NO verdict).
   * Absent key when no evidence is recorded.
   */
  ownerSessionFile?: string;
  /**
   * 213 Phase 0 (round-8 review issue 5): read-only display fact — is the
   * CALLER a child session (decides whether "take over in this session" may
   * appear in the copy at all). Key ABSENT when no actor evidence was passed
   * (equivalent to "unknown identity").
   */
  actorIsChild?: boolean;
}

/**
 * Build the display view when THIS meta is paused on a decision-pending human
 * review. Returns `null` whenever the pipeline is NOT in that state — the
 * regular (pre-193) displays then apply unchanged.
 *
 * 213 Phase 0 (D17-③): an OPTIONAL read-only caller identity (`actor`) turns
 * the two-state evidence into the honest three-state one; WITHOUT it the view
 * stays two-state (every surface that has no identity evidence keeps its
 * pre-213 shape, e.g. the prompt injection).
 */
export function buildDesignReviewPendingDecisionView(
  meta: SessionMeta | undefined,
  /** Read-only caller identity evidence (child ⇒ its parent file speaks);
   *  absent ⇒ the view keeps the honest two-state shape. */
  actor?: DesignReviewActorInput,
): DesignReviewPendingDecisionView | null {
  if (meta === undefined || !isDesignReviewDecisionPending(meta)) return null;
  const dr = meta.designReview;
  if (dr === undefined) return null;
  const decision = dr.decision;
  // 212 Phase 3: the SAME read-side normalization the coordinator uses —
  // a missing/blank owner on BOTH fields is the honest "missing" fact.
  const recordedOwner = resolveDecisionOwnerFile(dr.ownerSessionFile, decision?.ownerSessionFile);
  // 213 Phase 0 three-state resolution (order-locked, D8: a child NEVER
  // reaches `recorded_unprovable`):
  // 1. no recorded owner evidence → "missing";
  // 2. no caller identity → "recorded" (two-state, unchanged behavior);
  // 3. child caller → "recorded" (no takeover exit exists for it);
  // 4. the caller's provable owner file DIFFERS from the recorded one →
  //    "recorded_unprovable" (the resume takeover is the honest exit);
  // 5. otherwise (the caller IS the provable owner, or the caller has no
  //    provable file to compare — blank ⇒ absent, two-state) → "recorded".
  const actorFile = actor === undefined ? undefined : resolveOwnerSessionFile(actor);
  const ownerEvidence: DesignReviewPendingDecisionView["ownerEvidence"] =
    recordedOwner === undefined
      ? "missing"
      : actor === undefined || actor.isChild === true || actorFile === undefined || actorFile === recordedOwner
        ? "recorded"
        : "recorded_unprovable";
  return {
    state: decision?.state ?? "pending",
    choice: decision?.state === "chosen" ? decision.choice : null,
    mode: decision?.mode ?? dr.operation?.reviewConfirmMode ?? "unknown",
    reportDoc: decision?.reportDoc ?? dr.reportDoc ?? "the design review report",
    issueCount: decision?.issues.length ?? 0,
    ownerEvidence,
    // Read-only echoes (display facts, never verdicts): keys appear ONLY when
    // the underlying fact exists — absent ≠ false for the unknown identity.
    ...(recordedOwner !== undefined ? { ownerSessionFile: recordedOwner } : {}),
    ...(actor !== undefined ? { actorIsChild: actor.isChild === true } : {}),
  };
}

/**
 * 213 Phase 0 (D17-③, round-8 review issues 5/9): the owner-evidence exit
 * sentence — THREE states × caller identity, every sentence true for its
 * reader. The unknown-identity variant (`actorIsChild` key absent) uses
 * "an interactive session" wording because the prompt-injector assembles
 * prompts INSIDE child sessions too: a reader-agnostic phrasing must never
 * write "this session" where a takeover may not exist.
 */
function ownerEvidenceSuffix(view: DesignReviewPendingDecisionView): string {
  const at = view.ownerSessionFile !== undefined
    ? ` at ${view.ownerSessionFile}`
    : "";
  if (view.ownerEvidence === "missing") {
    if (view.actorIsChild === true) {
      return (
        "; owner evidence: missing — a subagent session cannot take over; " +
        "re-authorize this design-review round from the parent session or use /pipeline-quit"
      );
    }
    if (view.actorIsChild === false) {
      return (
        "; owner evidence: missing — re-authorize this design-review round, " +
        "run /pipeline-resume to take over, or use /pipeline-quit"
      );
    }
    return (
      "; owner evidence: missing — re-authorize this design-review round, " +
      "take over from an interactive session, or use /pipeline-quit"
    );
  }
  if (view.ownerEvidence === "recorded_unprovable") {
    // Reachable ONLY for a provable non-child caller (order rule 4), so the
    // "here" in the takeover hint is always true.
    return (
      `; owner evidence recorded${at}, not this session — run /pipeline-resume here ` +
      "to take over, re-authorize this design-review round, or use /pipeline-quit"
    );
  }
  // "recorded": a child (D8: no takeover, no answer) vs an owner/unknown caller.
  if (view.actorIsChild === true) {
    return (
      `; owner evidence recorded${at} — a subagent session cannot answer or ` +
      "take over; ask the parent session"
    );
  }
  return `; owner evidence recorded${at} — answerable only in that session, or by an explicit takeover in an interactive session`;
}

/**
 * One-line human-readable decision summary (state + optional choice + mode +
 * bound report/issues) used verbatim by the status surfaces.
 *
 * 213 Phase 0: the owner-evidence sentence ALWAYS trails the summary (all
 * three states × three identities give a truthful exit, see
 * {@link ownerEvidenceSuffix}); the recorded state now echoes the recorded
 * file (round-8 review issue 9) instead of appending nothing.
 */
export function formatDesignReviewPendingDecision(
  view: DesignReviewPendingDecisionView,
): string {
  const choicePart = view.choice !== null ? ` (choice: ${view.choice})` : "";
  return (
    `${view.state}${choicePart} — mode: ${view.mode}; ` +
    `report: ${view.reportDoc}; issues: ${view.issueCount}${ownerEvidenceSuffix(view)}`
  );
}
