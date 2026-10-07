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
  PipelineConfig,
  ConfirmMode,
} from "../../types";
import { hasCompleteDesignReviewIdentity, buildDesignReviewIdentity, deriveReportPath } from "./state";

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

// ─── 192 Phase 3: trusted domain verification context (meta-narrowing only) ──

/**
 * Narrowed context under which the SHARED verification engine must produce a
 * trusted design-review outcome. Derived EXCLUSIVELY from persisted, meta-
 * narrowed state — never from tool args or overrideFile values (a verify
 * override may only affect ordinary overridable rules, not this binding).
 */
export type TrustedDomainVerificationContext =
  | {
      kind: "review";
      /** Canonical absolute path of the CURRENT report snapshot */
      reportPath: string;
      /** Canonical plan doc */
      planDoc: string;
      /** Pipeline id binding */
      pipelineId: string;
      /** Round binding */
      round: number;
      /** Review operation id binding (required in the report) */
      operationId: string;
      /** Review inputHash binding (authorized plan content hash) */
      inputHash: string;
    }
  | {
      kind: "update";
      /** Canonical plan doc (the updated deliverable) */
      planDoc: string;
      /** Current update operation id (disposition section must match) */
      updateOperationId: string;
      /** Consumed report path from the bounded input receipt */
      reportDoc: string;
      /** Consumed report hash from the receipt */
      reportHash: string;
      /** Baseline plan hash (pre-update) */
      baselinePlanHash: string;
      /** Round of the consumed report */
      round: number;
      /** Consumed review operation id */
      reviewOperationId: string;
      /** Issue ids of the consumed report */
      issueIds: readonly string[];
    };

/**
 * Derive the domain verification context from the CURRENT meta, when an
 * authorized review/update is RUNNING for the current stage. Returns null
 * when this feature is not the active context (ordinary flows never gain
 * domain semantics) — invalid identity is also null here: BLOCKED loops are
 * consumed by the domain consumer (never treated as ordinary and never
 * verified through this path).
 */
export function deriveDomainVerificationContext(
  meta: SessionMeta | undefined,
): TrustedDomainVerificationContext | null {
  const state = meta?.designReview;
  if (!state || !meta) return null;
  if (!hasCompleteDesignReviewIdentity(state)) return null;
  const op = state.operation;

  if (
    meta.currentStage === "design-review"
    && state.phase === "review_running"
    && op
    && op.kind === "review"
  ) {
    return {
      kind: "review",
      reportPath: state.reportDoc ?? deriveReportPath(state.planDoc, state.round),
      planDoc: state.planDoc,
      pipelineId: meta.pipelineId ?? "unknown",
      round: state.round,
      operationId: op.operationId,
      // Review inputHash is the authorized plan content hash; legacy ops may
      // lack the explicit field and fall back to the state binding.
      inputHash: op.inputHash ?? state.planHash ?? "",
    };
  }

  // 193 Phase 2 (task 9): a paused design-review WAITING ON A HUMAN DECISION
  // is the one extra LEGAL report context: same stage, same CURRENT review
  // operation, and a decision record FULLY bound to it (id + operation +
  // non-empty report hash). This lets the before/after-menu revalidation run
  // through the same shared-snapshot verification. Every OTHER paused/ready/
  // override combination stays context-free — they must never masquerade as
  // an approval-bearing review.
  if (
    meta.currentStage === "design-review"
    && state.phase === "paused"
    && state.pauseReason === "decision-pending"
    && op
    && op.kind === "review"
    && state.decision
    && state.decision.reviewIdentity.operationId === op.operationId
    && state.decision.reportHash !== ""
  ) {
    return {
      kind: "review",
      reportPath: state.decision.reportDoc,
      planDoc: state.planDoc,
      pipelineId: meta.pipelineId ?? "unknown",
      round: state.round,
      operationId: op.operationId,
      inputHash: op.inputHash ?? state.decision.planHash,
    };
  }

  if (
    meta.currentStage === "plan"
    && state.phase === "update_running"
    && op
    && op.kind === "update"
  ) {
    const receipt = state.reviewInputReceipt;
    return {
      kind: "update",
      planDoc: state.planDoc,
      updateOperationId: op.operationId,
      reportDoc: receipt?.reportDoc ?? deriveReportPath(state.planDoc, state.round),
      reportHash: receipt?.reportHash ?? "",
      baselinePlanHash: receipt?.inputPlanHash ?? state.planHash ?? "",
      round: state.round,
      reviewOperationId: receipt?.reviewIdentity.operationId ?? "unknown",
      issueIds: receipt?.issueIds ?? [],
    };
  }

  return null;
}

/**
 * 193 Phase 1 (task 6): resolve the confirmation mode that GOVERNS the
 * current design-review run.
 *
 * Order (fixed):
 * 1. the mode PINNED on the current operation at dispatch-preparation time
 *    (`reviewConfirmMode`) — the value the reviewer was actually told;
 * 2. the stage-resolved config value `stages["design-review"].confirm.mode`
 *    (json-config-loader already validates/normalizes it) for LEGACY
 *    operations that carry no pinned field;
 * 3. "auto" — the default, never a fabricated authority.
 *
 * The returned mode only selects REPORT-CONTRACT strictness (whether a valid
 * FAIL must carry a machine plan-revision decision); routing authority itself
 * stays with the coordinator + confirm gate.
 */
export function resolveDesignReviewConfirmMode(
  meta: SessionMeta | undefined,
  config: PipelineConfig | undefined,
): ConfirmMode {
  const pinned = meta?.designReview?.operation?.reviewConfirmMode;
  if (pinned === "auto" || pinned === "manual" || pinned === "smart") {
    return pinned;
  }
  const stageMode = config?.stages?.["design-review"]?.confirm?.mode;
  return stageMode === "smart" || stageMode === "manual" ? stageMode : "auto";
}
