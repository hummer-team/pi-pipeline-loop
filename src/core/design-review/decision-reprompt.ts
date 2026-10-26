/**
 * @module design-review/decision-reprompt
 * 212_Bug Phase 1: one-shot AUTO-presentation budget for a pending
 * design-review decision (mirrors 211's "present once, then notify" rule).
 * Charged only when a menu ACTUALLY OPENS (creation or settle path); a
 * refused / never-shown attempt never consumes it; `resume` ignores it.
 *
 * Wake ≠ popup: this module only decides WHETHER the settle entry may open
 * the existing present-and-act flow. Eligibility (non-child + matching
 * session file), single-flight, pre/post revalidation and the strict choice
 * commit all stay in the coordinator (193, untouched).
 *
 * Budget accounting (212 plan, locked):
 * - the single charge point is inside `presentHumanDecisionForPendingState`,
 *   immediately BEFORE `ui.select` — a crashed menu must never re-arm itself;
 * - `not_settle` / `disabled` / `already_presented` / `in_flight` /
 *   `no_select` / `not_owner` / `no_owner_evidence` refusals NEVER write
 *   the stamp;
 * - `resume` passes `consumeBudget: false` — never reads, never writes;
 * - the stamp lives on `SessionMeta.designReviewDecisionReprompt` WITH the
 *   decisionId: a bare timestamp would let "old stamp + new decision" be
 *   misread as already-presented (decisionId is the only reliable one-shot
 *   scope). Same shape as 211's `confirmGateEscalation`.
 */

import type { PipelineConfig, SessionMeta } from "../../types";
import type { SessionState } from "../session-state";
import type {
  DesignReviewActorInput,
  DesignReviewInteractionSource,
  HumanDecision,
} from "./decision-types";
import { resolveDesignReviewActorEvidence } from "./human-decision";

/** Why the settle entry may or may not open the menu (first match wins). */
export type DecisionAutoRepromptReason =
  | "presented"          // may present NOW
  | "not_settle"         // trigger/source outside the owner-settle channel
  | "disabled"           // designReview.decisionAutoReprompt === "off"
  | "already_presented"  // this decisionId already consumed the one shot
  | "in_flight"          // a menu for this decisionId is already open
  | "no_select"          // no UI control
  | "no_owner_evidence"  // 212 review fix #1: NO recorded owner evidence at
                         // all — settle AND resume are both unanswerable, so
                         // the notice must not advertise /pipeline-resume
  | "not_owner";         // actor evidence exists but is not the recorded owner

/**
 * Read-only auto-reprompt verdict. Never carries side effects.
 * 212 round-2 review fix #4: TYPE-level discrimination only (the decision
 * chain and first-match order are untouched) — a refusal can never carry
 * `presented`, so callers narrow `reason` without re-checking `reprompt`.
 */
export type DecisionAutoRepromptDecision =
  | { reprompt: true; reason: "presented" }
  | { reprompt: false; reason: Exclude<DecisionAutoRepromptReason, "presented"> };

/** Inputs for {@link decideAutoReprompt} (everything already resolved). */
export interface DecideAutoRepromptInput {
  config: PipelineConfig;
  meta: SessionMeta;
  decision: HumanDecision;
  /** Coordinator trigger ("settle" | "advance" | "tool" | ...). */
  trigger: string;
  /** Entry-assigned interaction provenance; absent ⇒ treated as "auto". */
  interactionSource: DesignReviewInteractionSource | undefined;
  actor: DesignReviewActorInput | undefined;
  /** Read-side normalized owner file (193 single authority). */
  ownerFile: string | undefined;
  hasSelect: boolean;
  menuInFlight: boolean;
}

/** Default ON: "once". An explicit "off" is the only rollback switch. */
export function resolveDecisionAutoRepromptMode(config: PipelineConfig): "once" | "off" {
  return config.designReview?.decisionAutoReprompt === "off" ? "off" : "once";
}

/** True when this decisionId already OPENED (and spent) its automatic menu. */
export function wasDecisionRePresented(meta: SessionMeta, decisionId: string): boolean {
  return meta.designReviewDecisionReprompt?.decisionId === decisionId;
}

/**
 * Called at the ONE presentation point, immediately BEFORE `ui.select`
 * (a crashed menu must never re-arm itself). Durable via
 * `session.updateMeta` (same channel as 211's `confirmGateDeferredAt`).
 * A UX stamp, not an authority: eligibility and strict commits never read
 * this field.
 */
export function markDecisionRePresented(
  session: Pick<SessionState, "updateMeta">,
  decisionId: string,
): void {
  session.updateMeta({ designReviewDecisionReprompt: { decisionId, at: Date.now() } });
}

/**
 * The complete settle-entry decision chain, FIRST match wins, ALL READ-ONLY
 * (this function never writes the stamp — charging is the presenter's sole
 * call site). Step order is contractual: channel before config, config
 * before budget, budget before capability, capability before eligibility —
 * so refusals that could still be answered later never pre-consume.
 */
export function decideAutoReprompt(input: DecideAutoRepromptInput): DecisionAutoRepromptDecision {
  // 1. ONLY the owner-settle automatic channel may re-present. tool /
  //    startup / advance triggers and any non-auto source stay wait-only
  //    (193 channel contract; absent source = "auto", see runtime-context).
  if (input.trigger !== "settle" || (input.interactionSource ?? "auto") !== "auto") {
    return { reprompt: false, reason: "not_settle" };
  }
  // 2. explicit rollback switch (212 requirement 4 = plan A).
  if (resolveDecisionAutoRepromptMode(input.config) === "off") {
    return { reprompt: false, reason: "disabled" };
  }
  // 3. one shot per decisionId — already spent (creation or earlier settle).
  if (wasDecisionRePresented(input.meta, input.decision.decisionId)) {
    return { reprompt: false, reason: "already_presented" };
  }
  // 4. single-flight overlap: the other presentation owns the menu; a
  //    refusal here must NOT consume the budget.
  if (input.menuInFlight) {
    return { reprompt: false, reason: "in_flight" };
  }
  // 5. no UI control → nothing could be shown (never charges).
  if (!input.hasSelect) {
    return { reprompt: false, reason: "no_select" };
  }
  // 6. presentation eligibility stays the 193 single authority: a verified
  //    non-child actor whose file EQUALS the recorded owner. Refusals do
  //    not consume the budget. 212 review fix #1: ABSENT owner evidence is
  //    its own refusal reason — the decision is unanswerable on EVERY
  //    channel (settle and resume share the single authority), so the
  //    waiting notice must state that fact instead of advertising a path
  //    that does not exist (the original 212 symptom).
  if (resolveDesignReviewActorEvidence(input.actor, input.ownerFile).role !== "owner") {
    return {
      reprompt: false,
      reason: input.ownerFile === undefined ? "no_owner_evidence" : "not_owner",
    };
  }
  // 7. the settle entry may open the present-and-act flow. The budget is
  //    charged inside the presenter ONLY after before-menu revalidation
  //    passes — a drift refusal therefore also never consumes it.
  return { reprompt: true, reason: "presented" };
}

/**
 * 212 Phase 1/3 + review fix #1 + round-2 review fix #1: waiting-notice copy
 * keyed by the refusal reason AND the owner-evidence FACT. The user-visible
 * promise must never exceed what the SINGLE AUTHORITY can actually deliver in
 * the current state — "the menu opens at most once automatically;
 * /pipeline-resume re-opens it" — never "will open on the next turn".
 * Copy-layer only: the decider chain (first-match order) and the charge
 * contract stay exactly as they are.
 * - `ownerEvidenceMissing` (or reason `no_owner_evidence`): the FACT outranks
 *   the reason. Resume shares the same single authority, so WITHOUT recorded
 *   owner evidence NO channel can answer (the original 212 symptom) — the
 *   notice mirrors the STATE face (`ownerEvidence: missing` in
 *   decision-display.ts) and gives the honest exit (re-authorize or
 *   /pipeline-quit), NEVER advertising /pipeline-resume, whatever refusal
 *   fired first (`not_settle` / `in_flight` / `no_select` / `not_owner` /
 *   `disabled` / `already_presented` all land here when evidence is absent);
 * - `in_flight` with evidence recorded: a menu for this decision is open
 *   RIGHT NOW — resume opens no second menu while one is in flight, so the
 *   copy says "answer it there" instead of promising a new menu;
 * - `no_select` with evidence recorded: this session has no interactive UI —
 *   the presenter rejects resume here too, so the copy conditions the resume
 *   hint on an interactive owner session instead of promising availability;
 * - `not_settle` / `not_owner` with evidence recorded: the neutral base hint
 *   is HONEST there — /pipeline-resume in the owner session re-opens the
 *   menu through the shared present-and-act flow (193 single authority);
 * - `already_presented` / `disabled` with evidence recorded: the once-promise
 *   copy (reachable via resume, which never consumes the budget).
 */
export function formatDecisionWaitNotice(
  reportDoc: string,
  reason: DecisionAutoRepromptReason,
  /** Read-side fact from the caller (`ownerFile === undefined`) — not a new
   *  decider verdict: the reason itself stays the first-match product. */
  ownerEvidenceMissing: boolean = false,
): string {
  const base =
    `Design review FAILED and awaits a human plan-revision decision (report: ${reportDoc}).`;
  // 212 round-2 review fix #1: fact over reason — the same honest copy for
  // EVERY refusal while owner evidence is missing (settle or not).
  if (reason === "no_owner_evidence" || ownerEvidenceMissing) {
    return (
      `${base} Owner evidence is missing — neither the automatic menu nor ` +
      `/pipeline-resume can answer this decision. ` +
      `Re-authorize this design-review round or use /pipeline-quit.`
    );
  }
  if (reason === "already_presented") {
    return (
      `${base} The decision menu opens at most once automatically and has already ` +
      `appeared — /pipeline-resume re-opens it.`
    );
  }
  if (reason === "disabled") {
    return (
      `${base} Automatic menu presentation is disabled ` +
      `(designReview.decisionAutoReprompt: "off") — use /pipeline-resume to open the decision menu.`
    );
  }
  if (reason === "in_flight") {
    return (
      `${base} A decision menu for this decision is already open — answer it ` +
      `there; /pipeline-resume opens no second menu while one is in flight.`
    );
  }
  if (reason === "no_select") {
    return (
      `${base} This session has no interactive UI to present the decision menu ` +
      `— /pipeline-resume opens it only in an interactive owner session.`
    );
  }
  // not_settle / not_owner (owner evidence recorded): resume shares the
  // single authority and CAN present — the neutral hint is honest here.
  return `${base} Use /pipeline-resume to present the decision menu.`;
}
