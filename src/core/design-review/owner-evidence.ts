/**
 * @module design-review/owner-evidence
 * 212_Bug Phase 0: ONE place that turns raw actor evidence into a PROVABLE
 * owner session file. A child session never owns a decision — its nearest
 * known ancestor (parentSession) speaks for it. Missing evidence stays
 * missing: never a guessed authority, never an empty string.
 *
 * Boundaries (locked):
 * - Empty / blank / whitespace-only strings are ABSENT evidence, never a
 *   session identity. This is the read-side normalization that used to be
 *   masked by `??` fallbacks (`""` is neither null nor undefined).
 * - A child's owner is its DIRECT parent session (the nearest ancestor the
 *   plugin can observe via `sessionManager.getHeader().parentSession`). The
 *   plugin has NO cross-session header API, so deeper ancestors are not
 *   walked (depth ≥ 2 nests record the direct parent only and fail closed
 *   downstream if that cannot be proven).
 * - Every consumer treats `undefined` as "no provable owner" and fails
 *   closed (193 single authority untouched: eligibility stays
 *   non-child + matching session file).
 * - In addition to this resolution single point the module hosts ONE pure
 *   audit thin wrapper for the settle channel
 *   ({@link auditMissingOwnerEvidenceOnSettle}): read-only facts, no state
 *   change, no eligibility granted or removed.
 * - The settle-channel self-check ({@link auditMissingOwnerEvidenceOnSettle},
 *   Phase 0 task 11, moved here by review fix #5) is PURE AUDIT: throttled,
 *   read-only facts, no state change, no menu, no authority granted or
 *   removed — it keeps `handleDecisionPending` inside the plan's
 *   single-function line budget.
 */

import { safeWriteAuditLog } from "../../utils/auditLog";
import { shouldEmitWithinWindow } from "../../utils/audit-throttle";
import type { DesignReviewActorInput } from "./decision-types";
import { resolveDesignReviewActorEvidence } from "./human-decision";

/** Actor-shaped subset the resolver needs (mirrors `DesignReviewActorInput`). */
export interface OwnerEvidenceActor {
  isChild: boolean;
  sessionFile?: string;
  parentSessionFile?: string;
}

/** Empty / blank strings are ABSENT evidence, never a session identity. */
export function normalizeSessionFile(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The owner session file this actor may SPEAK FOR.
 * - non-child → its own session file;
 * - child     → its DIRECT parent session (the nearest ancestor observable
 *               through `sessionManager.getHeader()`), never its own file;
 * - anything missing/degraded → undefined (callers fail closed).
 */
export function resolveOwnerSessionFile(
  actor: OwnerEvidenceActor | undefined,
): string | undefined {
  if (!actor) return undefined;
  return actor.isChild
    ? normalizeSessionFile(actor.parentSessionFile)
    : normalizeSessionFile(actor.sessionFile);
}

/** Read-side normalization of the two recorded owner fields (`""` ⇒ absent). */
export function resolveDecisionOwnerFile(
  stateOwner: string | undefined,
  decisionOwner: string | undefined,
): string | undefined {
  return normalizeSessionFile(stateOwner) ?? normalizeSessionFile(decisionOwner);
}

/**
 * The ONLY provably-unauthorized actor: a child with no observable ancestor.
 * Absent actor / non-child without a file keep the pre-212 behaviour (the
 * plugin has no owner source to substitute) — documented boundary, 212
 * Phase 2 blocks on this predicate alone.
 */
export function isBlockedChildWithoutOwnerEvidence(
  actor: DesignReviewActorInput | undefined,
): boolean {
  return actor?.isChild === true && resolveOwnerSessionFile(actor) === undefined;
}

/** Throttle window for the settle-channel owner-evidence self-check. */
const SETTLE_OWNER_EVIDENCE_WINDOW_MS = 5000;

/**
 * 212 Phase 0 (task 11), extracted by review fix #5: on the settle channel
 * of `handleDecisionPending`, a pending decision WITHOUT provable owner
 * evidence must stay auditable — "still unanswerable after the upgrade" is
 * the exact refusal vocabulary the resume path logs, so operators can tell
 * why `ui.select` never fires. PURE AUDIT: throttled (the same 5s window
 * and the same `decision_owner_evidence` key the inline block used),
 * read-only, no state change, no menu.
 *
 * 212 round-2 review fix #5: the caller guard is ENFORCED by the type — the
 * `ownerFile` slot only accepts `undefined` (the coordinator passes it inside
 * `trigger === "settle" && ownerFile === undefined`, where TS narrows the
 * value), so an accidental non-undefined call site is a compile error, not a
 * comment-only invariant.
 */
export async function auditMissingOwnerEvidenceOnSettle(input: {
  /** Raw meta pipelineId — the throttle key normalizes a missing one to "unknown". */
  pipelineId: string | undefined;
  decisionId: string;
  round: number;
  actor: DesignReviewActorInput | undefined;
  /** Compile-time enforced ABSENT evidence (caller guard, review fix #5). */
  ownerFile?: undefined;
}): Promise<void> {
  const evidenceKey = `${input.pipelineId ?? "unknown"}:decision_owner_evidence`;
  if (!shouldEmitWithinWindow(evidenceKey, SETTLE_OWNER_EVIDENCE_WINDOW_MS)) {
    return;
  }
  const settleEvidence = resolveDesignReviewActorEvidence(input.actor, input.ownerFile);
  await safeWriteAuditLog("design_review_coordinator", {
    action: "decision_menu_skipped",
    decisionId: input.decisionId,
    role: settleEvidence.role,
    source: settleEvidence.source,
    reason: settleEvidence.reason ?? "role not verified",
  }, "warn");
  await safeWriteAuditLog("design_review_coordinator", {
    action: "decision_owner_evidence_insufficient",
    stage: "settle",
    decisionId: input.decisionId,
    round: String(input.round),
  }, "warn");
}
