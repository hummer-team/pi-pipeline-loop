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
 */

import type { DesignReviewActorInput } from "./decision-types";

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
