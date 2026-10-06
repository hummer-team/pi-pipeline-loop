/**
 * @module design-review/verification-context
 * 192 Phase 0: functions that narrow trusted review/update contexts from
 * session meta ONLY. No rule scheduling, no file reading, no dispatching —
 * the shared verification engine (runVerification) and the domain consumer
 * remain separate. Context derived here is the single trustworthy source for
 * "which operation does the current run own"; tool args or override paths
 * must never fabricate this context.
 */

import type {
  SessionMeta,
  DesignReviewState,
  DesignReviewOperation,
  DesignReviewIdentity,
  DesignReviewOperationKind,
} from "../../types";
import { hasCompleteDesignReviewIdentity, buildDesignReviewIdentity } from "./state";

/**
 * Narrowed read-only context for the current design-review operation.
 * Produced exclusively from persisted meta — never from tool arguments.
 */
export interface DesignReviewOperationContext {
  /** The narrowed, identity-complete state */
  state: DesignReviewState;
  /** The current operation record */
  operation: DesignReviewOperation;
  /** Full identity of the current operation */
  identity: DesignReviewIdentity;
}

export type NarrowContextResult =
  | { ok: true; ctx: DesignReviewOperationContext }
  | { ok: false; reason: "absent" | "identity_incomplete" | "no_operation" };

/**
 * Narrow the CURRENT design-review operation context from meta.
 *
 * Runtime validation is field-based: the state must be identity-complete and
 * carry a current operation; the optional kind check lets callers assert the
 * expected operation kind (e.g. "review") without trusting it blindly.
 */
export function narrowDesignReviewOperationContext(
  meta: SessionMeta | undefined,
  expectedKind?: DesignReviewOperationKind,
): NarrowContextResult {
  const state = meta?.designReview;
  if (!state) {
    return { ok: false, reason: "absent" };
  }
  if (!hasCompleteDesignReviewIdentity(state)) {
    return { ok: false, reason: "identity_incomplete" };
  }
  const operation = state.operation;
  if (!operation) {
    return { ok: false, reason: "no_operation" };
  }
  if (expectedKind && operation.kind !== expectedKind) {
    return { ok: false, reason: "no_operation" };
  }
  const identity = buildDesignReviewIdentity(meta as SessionMeta, state, operation);
  if (!identity) {
    return { ok: false, reason: "no_operation" };
  }
  return { ok: true, ctx: { state, operation, identity } };
}

/**
 * Narrow just the identity-complete design-review state from meta (no
 * operation requirement). Used by lifecycle/classification consumers that
 * must distinguish "not this feature" from "invalid identity".
 */
export function narrowDesignReviewState(
  meta: SessionMeta | undefined,
): { ok: true; state: DesignReviewState } | { ok: false; reason: "absent" | "identity_incomplete" } {
  const state = meta?.designReview;
  if (!state) {
    return { ok: false, reason: "absent" };
  }
  if (!hasCompleteDesignReviewIdentity(state)) {
    return { ok: false, reason: "identity_incomplete" };
  }
  return { ok: true, state };
}
