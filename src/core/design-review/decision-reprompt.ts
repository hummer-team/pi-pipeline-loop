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
 *   `no_select` / `not_owner` refusals NEVER write the stamp;
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
  | "not_owner";         // actor evidence is not the recorded owner

/** Read-only auto-reprompt verdict. Never carries side effects. */
export interface DecisionAutoRepromptDecision {
  reprompt: boolean;
  reason: DecisionAutoRepromptReason;
}

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
  //    not consume the budget.
  if (resolveDesignReviewActorEvidence(input.actor, input.ownerFile).role !== "owner") {
    return { reprompt: false, reason: "not_owner" };
  }
  // 7. the settle entry may open the present-and-act flow. The budget is
  //    charged inside the presenter ONLY after before-menu revalidation
  //    passes — a drift refusal therefore also never consumes it.
  return { reprompt: true, reason: "presented" };
}

/**
 * 212 Phase 1/3: waiting-notice copy keyed by the refusal reason. The
 * user-visible promise is exactly "the menu opens at most once
 * automatically; /pipeline-resume re-opens it" — never "will open on the
 * next turn". Base copy stays neutral for the non-promise refusals
 * (not_settle / in_flight / no_select / not_owner).
 */
export function formatDecisionWaitNotice(
  reportDoc: string,
  reason: DecisionAutoRepromptReason,
): string {
  const base =
    `Design review FAILED and awaits a human plan-revision decision (report: ${reportDoc}).`;
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
  return `${base} Use /pipeline-resume to present the decision menu.`;
}
