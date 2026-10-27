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
 * - a ZERO-WRITE stamp (212 round-3 review fix #4): `session.updateMeta`
 *   answers honestly with `undefined` when nothing was persisted (meta lock
 *   busy / patch barrier rejected); `markDecisionRePresented` reports that
 *   back and the presenter turns it into ONE error-level audit
 *   (`decision_auto_reprompt_stamp_failed`) — the charge point stays single,
 *   the failure is never silent;
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
 *
 * 212 round-3 review fix #4: returns whether the write was ACCEPTED.
 * `updateMeta` answers a zero-write honestly with `undefined` (meta lock
 * busy / patch barrier rejected); the caller MUST make that failure
 * observable (error-level audit) — a lost charge must never stay silent.
 * The channel's inherent fail-open (the budget may effectively re-arm) is
 * the same semantics as 211's `confirmGateDeferredAt`, now auditable.
 */
export function markDecisionRePresented(
  session: Pick<SessionState, "updateMeta">,
  decisionId: string,
): boolean {
  return session.updateMeta({ designReviewDecisionReprompt: { decisionId, at: Date.now() } }) !== undefined;
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
 * 212 Phase 1/3 + review fix #1 + round-2 review fix #1 + round-3 review
 * fixes #1/#2/#3: waiting-notice copy keyed by the refusal reason AND the
 * read-side FACTS. The user-visible promise must never exceed what the
 * SINGLE AUTHORITY can actually deliver in the current state — "the menu
 * opens at most once automatically; /pipeline-resume re-opens it" — never
 * "will open on the next turn".
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
 * - `not_owner` with evidence recorded (212 round-3 review fix #1, Plan
 *   Phase 0 task 11): the RECORDED value cannot be proven by this session.
 *   The plugin has no cross-session header API, so "the record points at a
 *   dead child file" (unanswerable — the persisted incident shape) and "the
 *   record points at another live owner session" (answerable THERE) are
 *   INDISTINGUISHABLE here; the notice therefore never promises a bare
 *   resume (never pretend an unavailable path works): resume is qualified
 *   to the recorded owner session
 *   and BOTH Plan exits (re-authorize this round / /pipeline-quit) are given
 *   — whatever this session's UI looks like;
 * - `hasSelect` FACT false with evidence recorded (212 round-3 review fix
 *   #2): this session has no interactive UI — the presenter rejects resume
 *   here too, so every remaining resume hint (`no_select` / `not_settle` /
 *   `disabled` / `already_presented`) is conditioned on an interactive owner
 *   session instead of promising availability;
 * - `not_settle` with evidence recorded and an interactive session: the
 *   neutral base hint is HONEST there — /pipeline-resume in the owner
 *   session re-opens the menu through the shared present-and-act flow (193
 *   single authority);
 * - `already_presented` / `disabled` with evidence recorded and an
 *   interactive session: the once-promise copy (reachable via resume, which
 *   never consumes the budget).
 * 212 round-3 review fix #3 (type hygiene): `reason` accepts only REFUSALS
 * (`presented` is excluded — a success verdict must never render a
 * suggestion), and both facts are REQUIRED fields — a new call site can
 * never silently degrade to the optimistic default copy.
 */

/** Read-side facts the waiting notice needs from the caller (round-3 #3:
 *  no defaults — the caller MUST state what it actually resolved). */
export interface DecisionWaitNoticeFacts {
  /** Read-side normalization result: NO recorded owner evidence at all. */
  ownerEvidenceMissing: boolean;
  /** This session exposes an interactive `select` control. */
  hasSelect: boolean;
  /**
   * 213 Phase 0 (D8/D11/D17): the caller is a CHILD (subagent) session.
   * REQUIRED and default-less — a new call site can never silently degrade to
   * the optimistic copy: a child has NO takeover exit (D8), so every sentence
   * that promises "take over in this session" must be withheld from it.
   */
  isChild: boolean;
}

export function formatDecisionWaitNotice(
  reportDoc: string,
  /** A refusal only — `presented` never reaches the copy layer. */
  reason: Exclude<DecisionAutoRepromptReason, "presented">,
  facts: DecisionWaitNoticeFacts,
): string {
  const base =
    `Design review FAILED and awaits a human plan-revision decision (report: ${reportDoc}).`;
  // Fact 1 (round-2 fix #1) outranks EVERY reason: without recorded owner
  // evidence settle AND resume were both unanswerable (193 single authority).
  // 213 Phase 0 (D8/D11): a NON-child session now has ONE more honest exit —
  // the explicit, audited resume-channel takeover — so the missing-evidence
  // copy gains it. A CHILD keeps the 212 copy VERBATIM (it can neither answer
  // nor take over; advertising those paths to it would be a lie, per the
  // 213 plan "child 保持 212 原文逐字不变").
  if (reason === "no_owner_evidence" || facts.ownerEvidenceMissing) {
    if (facts.isChild) {
      return (
        `${base} Owner evidence is missing — neither the automatic menu nor ` +
        `/pipeline-resume can answer this decision. ` +
        `Re-authorize this design-review round or use /pipeline-quit.`
      );
    }
    return (
      `${base} Owner evidence is missing — re-authorize this design-review ` +
      `round, run /pipeline-resume to take over the decision (explicit ` +
      `confirmation, audited), or use /pipeline-quit.`
    );
  }
  // An in-flight menu owns the answer RIGHT NOW — stated before any
  // future-path hint (round-2 fix #1).
  if (reason === "in_flight") {
    return (
      `${base} A decision menu for this decision is already open — answer it ` +
      `there; /pipeline-resume opens no second menu while one is in flight.`
    );
  }
  // Fact 2 (round-3 fix #1, Plan Phase 0 task 11): evidence RECORDED but this
  // session cannot prove it holds the owner — the persisted incident shape.
  // Indistinguishable from a legit foreign-owner record (no cross-session
  // header API), so BOTH exits are always given, never a bare resume promise.
  // 213 Phase 0 (D8/D11): a NON-child session additionally owns the explicit
  // takeover exit (resume channel, one confirmation + one strict commit + one
  // audit — P1). The CHILD copy stays the 212 text VERBATIM (no takeover
  // exists for a subagent, so promising one would be a false exit).
  if (reason === "not_owner") {
    const legacy =
      `${base} Owner evidence is recorded but this session cannot prove it — ` +
      `run /pipeline-resume in the recorded owner session; if that session no ` +
      `longer exists, re-authorize this design-review round or use /pipeline-quit.`;
    if (facts.isChild) return legacy;
    return (
      `${legacy} Or run /pipeline-resume here to take over this decision ` +
      `(explicit confirmation, audited).`
    );
  }
  // Fact 3 (round-3 fix #2): no interactive UI here — resume is rejected by
  // the presenter in THIS session (the `no_select` reason is the same fact
  // seen through the decider's first-match lens).
  if (!facts.hasSelect || reason === "no_select") {
    return (
      `${base} This session has no interactive UI to present the decision menu ` +
      `— /pipeline-resume opens it only in an interactive owner session.`
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
  // not_settle (owner evidence recorded, interactive session): resume shares
  // the single authority and CAN present — the neutral hint is honest here.
  // 213 Phase 0 (D8/D11): for a NON-child session the resume menu may first
  // demand an explicit takeover when the recorded owner is not this session —
  // the hint says so honestly. A CHILD keeps the 212 text verbatim (it has no
  // takeover path, so the qualified wording would promise an exit it lacks).
  if (facts.isChild) {
    return `${base} Use /pipeline-resume to present the decision menu.`;
  }
  return (
    `${base} Use /pipeline-resume to present the decision menu ` +
    `(you may be asked to take over this decision first).`
  );
}
