/**
 * @module core/design-review/owner-takeover
 * 213_Bug Phase 1 (D8/D10/D11): the ONE explicit, audited owner-takeover path
 * on the resume channel.
 *
 * Why: a pending decision may record owner evidence pointing at a session that
 * no longer exists (the 212 incident shape). Before 213 such decisions were
 * permanently unanswerable. 213 opens exactly ONE honest exit: the CURRENT
 * non-child session may take ownership through `/pipeline-resume` — one
 * explicit confirmation, ONE strict commit, ONE audit line per takeover.
 *
 * Hard boundaries (locked by the 213 plan):
 * - resume channel ONLY (`interactionSource === "resume"`): settle / tool /
 *   startup / advance keep the 212 behaviour byte-for-byte (D8's single
 *   exception rule);
 * - a CHILD session can never take over (D8) — not even offered;
 * - the takeover NEVER touches the automatic-presentation budget (D11): no
 *   `consumeBudget`, no `markDecisionRePresented` from this module;
 * - the confirmation rides the SAME `ui.select` control (D18 — no new UI
 *   capability is invented here);
 * - success rebinds BOTH owner fields through ONE strict commit whose CAS
 *   anchors include `stateUpdatedAt` + `decisionId` + `decisionState:"pending"`.
 */

import type {
  DesignReviewState,
  HumanDecision,
  SessionMeta,
} from "../../types";
import type { CoordinatorContext } from "./coordinator";
import type {
  DesignReviewActorInput,
  DesignReviewInteractionSource,
} from "./decision-types";
import type { HumanDecisionSelectFn } from "./human-decision";
import { normalizeSessionFile, resolveDecisionOwnerFile } from "./owner-evidence";
import { strictCommitMeta } from "../session-state";
import { safeWriteAuditLog } from "../../utils/auditLog";

/** Verdict of the PURE takeover-offer decision (zero writes, zero UI). */
export type TakeoverVerdict =
  | { offer: true }
  | {
      offer: false;
      reason:
        | "not_resume_channel"
        | "child_session"
        | "no_actor_identity"
        | "no_ui"
        | "owner_provable";
    };

/**
 * Pure decision: may the presenter OFFER a takeover right now?
 * Order-locked (plan P1 task 1): channel → child → identity → capability →
 * ownership. The first failing condition names itself — later conditions are
 * never evaluated for a session that does not reach them.
 */
export function evaluateTakeoverOffer(input: {
  interactionSource: DesignReviewInteractionSource | undefined;
  actor: DesignReviewActorInput | undefined;
  /** Normalized recorded owner file (`undefined` = no evidence recorded). */
  ownerFile: string | undefined;
  hasUI: boolean;
}): TakeoverVerdict {
  // D8: the resume channel is the ONE takeover channel. Every automatic
  // surface (settle / tool / startup / advance) keeps the 212 refusals.
  if (input.interactionSource !== "resume") {
    return { offer: false, reason: "not_resume_channel" };
  }
  // D8: a subagent can neither answer nor take over — not even an offer.
  if (input.actor?.isChild === true) {
    return { offer: false, reason: "child_session" };
  }
  // Without a non-blank session file there is NO identity to bind as the new
  // owner — a takeover would write a lie into both owner fields.
  const actorFile = normalizeSessionFile(input.actor?.sessionFile);
  if (actorFile === undefined) {
    return { offer: false, reason: "no_actor_identity" };
  }
  // D18: the confirmation rides the declared interactive capability.
  if (input.hasUI !== true) {
    return { offer: false, reason: "no_ui" };
  }
  // The recorded owner IS this session — nothing to take over (settle/resume
  // can already answer through the normal ownership proof).
  if (input.ownerFile !== undefined && input.ownerFile === actorFile) {
    return { offer: false, reason: "owner_provable" };
  }
  // D8 explicitly includes "owner evidence missing": `ownerFile === undefined`
  // reaching this point is offer-able (the commit records this session).
  return { offer: true };
}

/** The two fixed confirmation options (order = verdict order, no parsing). */
export const OWNER_TAKEOVER_CONFIRM_OPTION = "Take over this decision in the current session";
export const OWNER_TAKEOVER_CANCEL_OPTION = "Cancel";

/**
 * Explicit confirmation through the SAME select control (D10: no new UI
 * capability). The copy MUST echo the original owner so the user sees what is
 * being replaced: `Original owner: <file>` or `Original owner: not recorded`.
 * Any exception / cancel / unrecognized answer ⇒ false (stay pending).
 *
 * Boundary (round-8 note): a host may DECLARE interactive UI (D18) without
 * exposing the select control — confirmation is then impossible, which is
 * honestly answered as a refusal (fail closed), never as a silent takeover.
 */
export async function confirmOwnerTakeover(
  select: HumanDecisionSelectFn | undefined,
  facts: { ownerLabel: string; decisionId: string; round: number },
): Promise<boolean> {
  if (!select) {
    // No control to ask through ⇒ no consent can exist (D10).
    return false;
  }
  try {
    const title =
      `Owner takeover required — decision ${facts.decisionId} (round ${facts.round}). ` +
      `Original owner: ${facts.ownerLabel}. ` +
      `Taking over binds this session as the recorded owner (audited).`;
    const answer = await select(title, [
      OWNER_TAKEOVER_CONFIRM_OPTION,
      OWNER_TAKEOVER_CANCEL_OPTION,
    ]);
    return answer === OWNER_TAKEOVER_CONFIRM_OPTION;
  } catch {
    // Fail closed: an unanswerable confirmation is a refusal, never a takeover.
    return false;
  }
}

/** Result of the ONE strict takeover commit (persisted triple or refusal). */
export type OwnerTakeoverCommitResult =
  | {
      status: "persisted";
      meta: SessionMeta;
      drState: DesignReviewState;
      decision: HumanDecision;
    }
  | { status: "failed"; reason: string };

/**
 * ONE strict commit writing BOTH owner fields (`drState.ownerSessionFile` and
 * `decision.ownerSessionFile`), leaving `armedBySessionFile` byte-identical
 * (it records WHO armed the round — an unrelated provenance fact).
 *
 * CAS anchors (plan P1): pipelineId / authorizationId / round / operationId /
 * phase / stateUpdatedAt / decisionId / decisionState:"pending". A concurrent
 * takeover by a second session must fail with `conflict` — only ONE winner.
 * Boundary: a legacy record without `updatedAt` leaves `stateUpdatedAt`
 * undefined, and the revision anchor degrades to "both explicit takeovers may
 * succeed, each leaving its own audit trail" — documented here, NOT worked
 * around (the `MetaCommitExpectation` structure stays untouched).
 *
 * Audits exactly ONE `decision_owner_takeover` line on success; on failure it
 * audits NOTHING (the presenter's step-5 `decision_menu_skipped` is the
 * truthful record there).
 */
export async function commitOwnerTakeover(
  ctx: CoordinatorContext,
  input: {
    meta: SessionMeta;
    drState: DesignReviewState;
    decision: HumanDecision;
    actorSessionFile: string;
  },
): Promise<OwnerTakeoverCommitResult> {
  const ownerFileBefore = resolveDecisionOwnerFile(
    input.drState.ownerSessionFile,
    input.decision.ownerSessionFile,
  );
  const patchState: DesignReviewState = {
    ...input.drState,
    ownerSessionFile: input.actorSessionFile,
    // CAS anchor: a concurrent takeover by another session bumps this and the
    // second commit lands as `conflict` — never a silent double-rebind.
    updatedAt: Date.now(),
    // BOTH owner fields move together (write-once invariant of the read side:
    // `resolveDecisionOwnerFile` prefers the state field, the decision field
    // must not keep pointing at the gone session).
    decision: { ...input.decision, ownerSessionFile: input.actorSessionFile },
  };
  const commit = strictCommitMeta(ctx.session, { designReview: patchState }, {
    pipelineId: input.meta.pipelineId ?? "unknown",
    authorizationId: input.drState.authorizationId,
    round: input.drState.round,
    operationId: input.drState.operation?.operationId ?? null,
    phase: input.drState.phase,
    stateUpdatedAt: input.drState.updatedAt,
    decisionId: input.decision.decisionId,
    decisionState: "pending",
  });
  if (commit.status !== "persisted") {
    // Honest composite reason keeps the strict-commit vocabulary observable.
    return { status: "failed", reason: `${commit.status}:${commit.reason}` };
  }
  await safeWriteAuditLog("design_review_coordinator", {
    action: "decision_owner_takeover",
    decisionId: input.decision.decisionId,
    round: String(input.drState.round),
    from: ownerFileBefore ?? "not_recorded",
    to: input.actorSessionFile,
    actor: input.actorSessionFile,
    previousEvidence: ownerFileBefore === undefined ? "missing" : "recorded",
    pipelineId: input.meta.pipelineId ?? "unknown",
  });
  return {
    status: "persisted",
    meta: commit.meta,
    drState: patchState,
    decision: patchState.decision ?? input.decision,
  };
}
