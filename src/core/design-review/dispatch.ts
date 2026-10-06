/**
 * @module design-review/dispatch
 * Phase 2 / 191: Operation-aware dispatch logic for design review stage.
 *
 * Extracted from subagent-rpc.ts to provide design-review-specific spawn context
 * and lifecycle condition handling. This module ensures:
 * - Same operation recovery/retry does not duplicate dispatch
 * - Old operations cannot affect new rounds
 * - Dispatch sequence: reliably save intent → RPC → writeback or conditional cleanup
 * - Report consumption and active/pending cleanup bound to operation identity
 * - Retry attempts don't increment round
 * - Old operations/queues cannot overwrite new rounds
 *
 * Dependencies:
 * - state (this directory): pure functions for state transitions and validation
 * - subagent-rpc: existing RPC mechanism (reused, not duplicated)
 * - spawn-cleanup: existing cleanup helpers (extended for operation awareness)
 */

import crypto from "node:crypto";
import type {
  PipelineConfig,
  SessionMeta,
  DesignReviewState,
  DesignReviewOperation,
  DesignReviewOperationKind,
  DesignReviewPhase,
} from "../../types";
import type { SessionState, StrictCommitSession, MetaCommitExpectation } from "../session-state";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeWriteAuditLog } from "../../utils/auditLog";
import { commitDesignReviewState, strictCommitMeta } from "../session-state";
import {
  isValidTransition,
  updateDispatchState,
  createOperation,
  isAuthorizationValid,
  computeHash,
  generateUUID,
} from "./state";

/**
 * Dispatch context for design review operations.
 * Captures all information needed to perform an operation-aware dispatch.
 */
export interface DesignReviewDispatchContext {
  /** Current design review state */
  state: DesignReviewState;
  /** Operation kind: "review" or "update" */
  kind: "review" | "update";
  /** Plan document path (for review) or report path (for update) */
  inputPath: string;
  /** Round number */
  round: number;
  /** Stage visit ID (stageStartTime) for idempotency */
  stageVisitId: number;
  /** Attempt number within this round */
  attempt: number;
}

/**
 * Result of a design review dispatch attempt.
 */
export interface DesignReviewDispatchResult {
  /** Whether dispatch succeeded */
  ok: boolean;
  /** Operation ID if created */
  operationId?: string;
  /** Agent ID if spawned */
  agentId?: string;
  /** Error message if failed */
  error?: string;
  /** Whether this was a duplicate dispatch (same operation already in progress) */
  duplicate?: boolean;
  /** Whether this dispatch was skipped due to stale operation */
  skipped?: boolean;
}

/**
 * Session interface required for dispatch operations.
 * Compatible with both RuntimeCtx.session and test mocks.
 */
interface DispatchSessionLike {
  getMeta: () => SessionMeta | undefined;
  updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
}

/**
 * Map an operation kind to the phase its dispatch moves the loop into.
 * 192 Phase 1: develop-handoff is recorded while the loop is pass_ready, so
 * its "running" phase is pass_ready itself (the handoff op is bound to the
 * pass_ready commit; finalization to "finished" happens ONLY after the
 * trusted dispatch receipt is persisted — DR192-01).
 */
export function kindToDispatchPhase(kind: DesignReviewOperationKind): DesignReviewPhase {
  if (kind === "review") return "review_running";
  if (kind === "update") return "update_running";
  return "pass_ready";
}

/**
 * 192 Phase 1 (F01): true ONLY when `existing` is the exact same operation
 * the request re-issues (same kind, same round, same stage visit) AND it has
 * not yet been confirmed dispatched with a trusted id. Anything else — a new
 * kind, a new round, or a different visit — MUST become a new operationId.
 * Retrying a confirmed-not-sent or intent-only operation increments attempt,
 * never round.
 */
export function isConfirmedSameOperationRetry(
  existing: DesignReviewOperation | undefined,
  request: { kind: DesignReviewOperationKind; round: number; stageVisitId: number },
): boolean {
  if (!existing) return false;
  if (existing.kind !== request.kind) return false;
  // Older 191 operations may not carry round; when absent, fall back to
  // requiring the same stageVisitId AND same kind only if the persisted
  // state's round matches the operation's recorded visit context. A missing
  // round means we cannot prove the same round → do NOT reuse (conservative).
  if (existing.round === undefined) return false;
  if (existing.round !== request.round) return false;
  if (existing.stageVisitId !== request.stageVisitId) return false;
  if (existing.dispatchState === "dispatched" || existing.dispatchState === "completed") {
    return false;
  }
  return true;
}

/**
 * Prepares a design review operation for dispatch.
 * Creates a new operation record and validates the state transition.
 *
 * 192 Phase 1 key invariants (F01):
 * - Identity is the tuple (authorizationId, round, kind, stageVisitId).
 *   A new kind or a new round ALWAYS creates a new operationId.
 * - Retry only for the exact same operation (isConfirmedSameOperationRetry):
 *   attempt increments, round does not.
 * - Same-millisecond visits with a different kind/round never reuse.
 *
 * @param state - Current design review state
 * @param kind - Operation kind (review or update)
 * @param stageVisitId - Stage visit ID for the CURRENT stage visit
 * @param inputHash - Optional operation input hash (bound into identity)
 * @returns New/retried operation, or undefined if transition is invalid
 */
export function prepareDesignReviewOperation(
  state: DesignReviewState,
  kind: DesignReviewOperationKind,
  stageVisitId: number,
  inputHash?: string,
): DesignReviewOperation | undefined {
  // Validate authorization is still valid
  if (!isAuthorizationValid(state)) {
    safeWriteAuditLog("design_review_dispatch", {
      reason: "authorization_invalid",
      phase: state.phase,
    }, "warn");
    return undefined;
  }

  // Determine target phase based on operation kind
  const targetPhase = kindToDispatchPhase(kind);

  // Validate state transition
  if (!isValidTransition(state.phase, targetPhase)) {
    safeWriteAuditLog("design_review_dispatch", {
      reason: "invalid_transition",
      fromPhase: state.phase,
      toPhase: targetPhase,
    }, "warn");
    return undefined;
  }

  const existingOp = state.operation;

  // Confirmed same-operation retry: increment attempt, keep identity.
  if (isConfirmedSameOperationRetry(existingOp, { kind, round: state.round, stageVisitId })) {
    const retryAttempt = (existingOp!.attempt || 1) + 1;
    safeWriteAuditLog("design_review_dispatch", {
      action: "retry_existing_operation",
      operationId: existingOp!.operationId,
      attempt: String(retryAttempt),
      round: String(state.round),
      kind,
    });
    return {
      ...existingOp!,
      attempt: retryAttempt,
      ...(inputHash !== undefined ? { inputHash } : {}),
      updatedAt: Date.now(),
    };
  }

  // Any other situation is a NEW operation (new kind / new round / new visit).
  if (existingOp && (existingOp.kind !== kind || existingOp.stageVisitId !== stageVisitId)) {
    safeWriteAuditLog("design_review_dispatch", {
      action: "supersede_stale_operation",
      oldOperationId: existingOp.operationId,
      oldKind: existingOp.kind,
      newKind: kind,
      oldStageVisitId: String(existingOp.stageVisitId),
      newStageVisitId: String(stageVisitId),
    }, "warn");
  }

  // Create new operation — new operationId, attempt 1, bound round.
  return createOperation(kind, stageVisitId, 1, inputHash, state.round);
}

/**
 * Commits design review operation state to session meta via the STRICT path.
 * This is the "reliably save intent" step in the dispatch sequence: the
 * operation (phase + record) is persisted through commitDesignReviewState —
 * local AND shared writes with read-back verification — before any RPC.
 *
 * 192 Phase 1 (F01/F04):
 * - Expectation is derived from the PRE-commit state (auth/round/operation/
 *   phase/revision), so a stale concurrent callback with the same auth and
 *   round conflicts instead of overwriting.
 * - Adapters without the strict interface return undefined (fail-closed).
 *
 * @param session - Strict-commit-capable session
 * @param operation - Operation to commit
 * @param state - Current (pre-commit) design review state
 * @returns Updated state or undefined if commit failed
 */
export function commitDesignReviewOperation(
  session: StrictCommitSession,
  operation: DesignReviewOperation,
  state: DesignReviewState,
): DesignReviewState | undefined {
  const meta = session.getMeta();
  if (!meta) {
    safeWriteAuditLog("design_review_dispatch", {
      reason: "no_meta",
    }, "error");
    return undefined;
  }

  // Determine target phase from the operation kind (identity-aware)
  const targetPhase = kindToDispatchPhase(operation.kind);

  // Validate transition from the CURRENT (pre-commit) phase
  if (!isValidTransition(state.phase, targetPhase)) {
    safeWriteAuditLog("design_review_dispatch", {
      reason: "invalid_transition_at_commit",
      fromPhase: state.phase,
      toPhase: targetPhase,
    }, "error");
    return undefined;
  }

  // Build the new state (same phase target but with the operation record)
  const updatedState: DesignReviewState = {
    ...state,
    phase: targetPhase,
    operation,
    updatedAt: Date.now(),
  };

  // Expectation against the pre-commit state; operationId may already have
  // moved if a concurrent writer replaced it → conflict.
  const expected: MetaCommitExpectation = {
    pipelineId: meta.pipelineId ?? "unknown",
    authorizationId: state.authorizationId,
    round: state.round,
    operationId: state.operation?.operationId ?? null,
    phase: state.phase,
    stateUpdatedAt: state.updatedAt,
  };

  const result = commitDesignReviewState(session, updatedState, expected);
  if (!result.ok) {
    safeWriteAuditLog("design_review_dispatch", {
      reason: "operation_commit_failed",
      operationId: operation.operationId,
      commitReason: result.reason,
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    }, "error");
    return undefined;
  }

  safeWriteAuditLog("design_review_dispatch", {
    action: "operation_committed",
    operationId: operation.operationId,
    kind: operation.kind,
    round: String(state.round),
    attempt: String(operation.attempt),
  });

  return result.state;
}

/**
 * Writes back RPC result to design review state via the STRICT path.
 * This is the "writeback or conditional cleanup" step.
 *
 * 192 Phase 1 key invariants (F01/F04):
 * - Only writes back if the CURRENT operation identity matches (prevents stale
 *   writes from late callbacks of superseded operations).
 * - "dispatched" REQUIRES a trusted agentId; a fallback send without a real id
 *   must be recorded as evidence "unknown" (status kept pending for
 *   verification) — never a fabricated dispatched receipt.
 * - Round and authorization are preserved across retries.
 * - A failed strict writeback aborts the caller: no finished, no routed
 *   success.
 *
 * @param session - Strict-commit-capable session
 * @param operationId - Operation ID to match
 * @param agentId - Trusted agent ID from the RPC reply (dispatched only)
 * @param status - Dispatch status (dispatched, completed, failed)
 * @param evidence - Optional dispatch evidence; defaults trusted_id when a
 *   real agentId is provided for "dispatched"
 * @returns Updated state or undefined if writeback failed
 */
export function writebackDesignReviewResult(
  session: StrictCommitSession,
  operationId: string,
  agentId: string | undefined,
  status: "dispatched" | "completed" | "failed",
  evidence?: DesignReviewOperation["dispatchEvidence"],
): DesignReviewState | undefined {
  const meta = session.getMeta();
  if (!meta?.designReview) {
    safeWriteAuditLog("design_review_dispatch", {
      reason: "no_design_review_state",
    }, "warn");
    return undefined;
  }

  const state = meta.designReview;
  const currentOp = state.operation;

  // Validate operation identity matches
  if (!currentOp || currentOp.operationId !== operationId) {
    safeWriteAuditLog("design_review_dispatch", {
      reason: "operation_identity_mismatch",
      expectedOperationId: operationId,
      actualOperationId: currentOp?.operationId ?? "none",
    }, "warn");
    return undefined;
  }

  let resolvedEvidence = evidence;
  if (status === "dispatched") {
    if (!agentId) {
      safeWriteAuditLog("design_review_dispatch", {
        reason: "dispatched_without_agent_id",
        operationId,
      }, "error");
      return undefined;
    }
    // A trusted id from the RPC reply is the "trusted_id" evidence.
    if (!resolvedEvidence) resolvedEvidence = "trusted_id";
  }

  // Update operation dispatch state
  let updatedState: DesignReviewState;

  if (status === "dispatched") {
    updatedState = {
      ...state,
      operation: {
        ...currentOp,
        dispatchState: "dispatched",
        agentId,
        dispatchEvidence: resolvedEvidence ?? "trusted_id",
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    };
  } else {
    // completed or failed - terminal evidence but preserve state for recovery
    updatedState = {
      ...state,
      operation: {
        ...currentOp,
        dispatchState: status,
        settledAt: Date.now(),
        ...(agentId ? { agentId } : {}),
        ...(resolvedEvidence ? { dispatchEvidence: resolvedEvidence } : {}),
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    };
  }

  // Strict commit with the pre-writeback expectation (single-writer revision
  // anchor: same auth/round/operation/revision, else conflict).
  const expected: MetaCommitExpectation = {
    pipelineId: meta.pipelineId ?? "unknown",
    authorizationId: state.authorizationId,
    round: state.round,
    operationId: currentOp.operationId,
    phase: state.phase,
    stateUpdatedAt: state.updatedAt,
  };
  const result = commitDesignReviewState(session, updatedState, expected);
  if (!result.ok) {
    safeWriteAuditLog("design_review_dispatch", {
      reason: "writeback_failed",
      operationId,
      status,
      commitReason: result.reason,
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    }, "error");
    return undefined;
  }

  safeWriteAuditLog("design_review_dispatch", {
    action: "writeback_completed",
    operationId,
    status,
    agentId: agentId || "none",
  });

  return result.state;
}

/**
 * Validates that a dispatch request is for the current operation.
 * Prevents old operations from affecting new rounds.
 *
 * @param state - Current design review state
 * @param operationId - Operation ID to validate
 * @param round - Round number to validate
 * @returns true if the request is for the current operation
 */
export function isCurrentOperation(
  state: DesignReviewState,
  operationId: string,
  round: number,
): boolean {
  const currentOp = state.operation;
  if (!currentOp) return false;

  // Check operation identity
  if (currentOp.operationId !== operationId) {
    safeWriteAuditLog("design_review_dispatch", {
      reason: "stale_operation_callback",
      callbackOperationId: operationId,
      currentOperationId: currentOp.operationId,
    }, "warn");
    return false;
  }

  // Check round identity
  if (state.round !== round) {
    safeWriteAuditLog("design_review_dispatch", {
      reason: "stale_round_callback",
      callbackRound: String(round),
      currentRound: String(state.round),
    }, "warn");
    return false;
  }

  return true;
}

/**
 * Generates a spawn description for design review operations.
 * Includes operation context for audit correlation.
 *
 * @param kind - Operation kind (review or update)
 * @param inputPath - Plan path (review) or report path (update)
 * @param round - Round number
 * @param operationId - Operation ID for correlation
 * @returns Spawn description string
 */
export function formatDesignReviewSpawnDescription(
  kind: "review" | "update",
  inputPath: string,
  round: number,
  operationId: string,
): string {
  const kindLabel = kind === "review" ? "design review" : "plan update";
  return `${kindLabel} round ${round} (${operationId.substring(0, 8)})`;
}

/**
 * Generates a spawn prompt for design review operations.
 * For review: passes plan path and round.
 * For update: passes report path and round.
 *
 * @param kind - Operation kind (review or update)
 * @param inputPath - Plan path (review) or report path (update)
 * @param round - Round number
 * @returns Spawn prompt string
 */
export function formatDesignReviewSpawnPrompt(
  kind: "review" | "update",
  inputPath: string,
  round: number,
): string {
  // Encode path to handle spaces
  const encodedPath = inputPath.replace(/ /g, "\\ ");
  return `${encodedPath} ${round}`;
}
