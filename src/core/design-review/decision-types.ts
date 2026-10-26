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

// ─── 193 Phase 2: human plan-revision decision records ──────────────────────

/** The ONLY two choices the human decision menu may persist. */
export const HUMAN_DECISION_CHOICES = ["revise-plan", "proceed-develop"] as const;

export type HumanDecisionChoice = (typeof HUMAN_DECISION_CHOICES)[number];

/**
 * Full review-identity binding of the FAIL a human decision belongs to.
 * Declared structurally here (this file must stay import-free so `types.ts`
 * can bridge it without a module cycle) and kept field-compatible with
 * `DesignReviewIdentity`.
 */
export interface HumanDecisionReviewIdentity {
  pipelineId: string;
  planDoc: string;
  authorizationId: string;
  round: number;
  operationId: string;
  stageVisitId: number;
}

/** One bounded issue carried by the decision (same snapshot as the verdict). */
export interface HumanDecisionIssue {
  issueId: string;
  text: string;
}

/** Fields shared by every decision state (immutable once created). */
export interface HumanDecisionRecordBase {
  /** Fresh UUID bound 1:1 to the pending FAIL the menu was created for */
  decisionId: string;
  /** Trusted identity of the consumed review operation */
  reviewIdentity: HumanDecisionReviewIdentity;
  /** Canonical FAIL report path (the exact snapshot the decision binds) */
  reportDoc: string;
  /** Content hash of that report snapshot */
  reportHash: string;
  /** Plan hash the reviewed round was bound to */
  planHash: string;
  /** Bounded, finite issue list from the SAME verified snapshot */
  issues: readonly HumanDecisionIssue[];
  /** Confirmation mode PINNED for this review (never re-resolved later) */
  mode: "manual" | "smart";
  /** Session file of the owner that created the pending decision */
  ownerSessionFile?: string;
  /**
   * 212 Phase 0: session file of the actor that CREATED this pending record
   * (audit + copy only). It grants NO present/persist authority — 193 keeps
   * `ownerSessionFile` as the single authority source.
   *
   * Lifecycle: this field lives ONLY inside the `HumanDecision` record — it
   * is cleared with `designReview` itself (`meta-reset` clears the whole
   * state) and traveling through `canonicalJson` round-trips needs no extra
   * normalization (optional field reads back identically). Do NOT add a
   * `DesignReviewState` top-level mirror or a dedicated reset entry.
   */
  armedBySessionFile?: string;
  /** Creation timestamp of the pending record */
  createdAt: number;
}

/**
 * 193 Phase 2: the discriminated human decision record persisted inside the
 * design-review state. A `pending` record has NO choice; a `chosen` record
 * is the ONLY human authority that can release a FAIL into develop, and it
 * must carry the exact selection, source and timestamp.
 */
export type HumanDecision =
  | (HumanDecisionRecordBase & { state: "pending" })
  | (HumanDecisionRecordBase & {
      state: "chosen";
      choice: HumanDecisionChoice;
      source: "human";
      decidedAt: number;
    });

/**
 * 193 Phase 2: approval basis extending `DesignReviewApproval`.
 * - `report-pass` — the classic verified-PASS certification.
 * - `human-override` — a persisted human `proceed-develop` choice releasing a
 *   REAL FAIL; bound to the decision, its issue ids and the choice time.
 * Legacy approvals without `basis` pre-date this feature and are compatible
 * ONLY as PASS certifications; they must never authorize a new FAIL release.
 */
export type DesignReviewApprovalBasis =
  | { kind: "report-pass" }
  | {
      kind: "human-override";
      decisionId: string;
      issueIds: readonly string[];
      decidedAt: number;
    };

/**
 * 193 Phase 2: role evidence for design-review interactions (menu display,
 * choice persistence). Phase 3 consumes this interface; Phase 2 resolves it
 * conservatively: anything but a verified non-child owner stays `pending`.
 */
export type DesignReviewActorRole = "owner" | "child" | "unknown";

export interface DesignReviewActorEvidence {
  role: DesignReviewActorRole;
  /** Where the evidence came from (audit honesty: never a guessed owner) */
  source: "session-file" | "child-flag" | "absent";
  sessionFile?: string;
  reason?: string;
}

/** Raw actor input the coordinator receives from entry points (may be absent). */
export interface DesignReviewActorInput {
  isChild: boolean;
  sessionFile?: string;
  /** 212 Phase 0: direct parent session (child role only) — the nearest
   *  non-child ancestor the plugin can prove. Never used as a child's own
   *  identity. */
  parentSessionFile?: string;
}

/**
 * 193 Phase 3 (task 1): which entry produced a coordinator interaction.
 * Assigned by the PLUGIN ENTRIES only (never a model tool argument):
 * - "auto"    — hooks / automatic advance (agent-settled, stage-advancer auto);
 * - "tool"    — model-invoked tools (stage_advance, pipeline_verify, pipeline_handoff);
 * - "resume"  — explicit human commands (/pipeline-resume, /pipeline-start re-dispatch);
 * - "startup" — session_start recovery (session-starter).
 * Only "resume" may re-present a pending decision menu (task 4); every other
 * source keeps the pending pause read-only.
 */
export type DesignReviewInteractionSource = "auto" | "tool" | "resume" | "startup";

/**
 * 193 Phase 3 (task 6): the RECHECK barrier left behind when an upstream
 * rollback clears an unfinished design-review authorization. Written in the
 * SAME strict transaction that clears `designReview` (never a separate step),
 * and cleared atomically when a NEW review authorization is created. While
 * the marker belongs to the CURRENT pipeline and no active design-review
 * state exists, every ordinary forward release toward develop/review/fix/
 * awaiting_human/completed is refused — the loop must be re-reviewed.
 */
export interface DesignReviewRecheckMarker {
  /** Pipeline the barrier was set for (old markers never cross pipelines) */
  pipelineId: string;
  /** Plan document that must be re-reviewed before any forward release */
  planDoc: string;
}
