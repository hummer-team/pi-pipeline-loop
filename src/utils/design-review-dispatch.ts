/**
 * @module design-review-dispatch
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
 * - design-review-state: pure functions for state transitions and validation
 * - subagent-rpc: existing RPC mechanism (reused, not duplicated)
 * - spawn-cleanup: existing cleanup helpers (extended for operation awareness)
 */

import crypto from "node:crypto";
import type { PipelineConfig, SessionMeta, DesignReviewState, DesignReviewOperation } from "../types";
import type { SessionState } from "../core/session-state";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeWriteAuditLog } from "./auditLog";
import {
  isValidTransition,
  updateDispatchState,
  createOperation,
  isAuthorizationValid,
  computeHash,
  generateUUID,
} from "../core/design-review-state";

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
 * Prepares a design review operation for dispatch.
 * Creates a new operation record and validates the state transition.
 *
 * Key invariants:
 * - Operation identity is bound to (authorizationId, round, stageVisitId)
 * - Retry attempts within same round share operation identity
 * - New round = new operation identity
 *
 * @param state - Current design review state
 * @param kind - Operation kind (review or update)
 * @param stageVisitId - Stage visit ID for idempotency
 * @returns New operation or undefined if transition is invalid
 */
export function prepareDesignReviewOperation(
  state: DesignReviewState,
  kind: "review" | "update",
  stageVisitId: number,
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
  const targetPhase = kind === "review" ? "review_running" : "update_running";

  // Validate state transition
  if (!isValidTransition(state.phase, targetPhase)) {
    safeWriteAuditLog("design_review_dispatch", {
      reason: "invalid_transition",
      fromPhase: state.phase,
      toPhase: targetPhase,
    }, "warn");
    return undefined;
  }

  // Check if there's an existing operation for this round and stage visit
  const existingOp = state.operation;
  if (existingOp) {
    // Same stage visit = retry, reuse operation identity
    // Note: stageVisitId uniquely identifies the round context, so no separate round check needed
    if (existingOp.stageVisitId === stageVisitId) {
      // Increment attempt counter
      const retryAttempt = (existingOp.attempt || 1) + 1;
      safeWriteAuditLog("design_review_dispatch", {
        action: "retry_existing_operation",
        operationId: existingOp.operationId,
        attempt: String(retryAttempt),
        round: String(state.round),
      });
      return {
        ...existingOp,
        attempt: retryAttempt,
        updatedAt: Date.now(),
      };
    }

    // Different stage visit = new operation, old one is stale
    if (existingOp.stageVisitId !== stageVisitId) {
      safeWriteAuditLog("design_review_dispatch", {
        action: "supersede_stale_operation",
        oldOperationId: existingOp.operationId,
        oldStageVisitId: String(existingOp.stageVisitId),
        newStageVisitId: String(stageVisitId),
      }, "warn");
    }
  }

  // Create new operation
  return createOperation(kind, stageVisitId, 1);
}

/**
 * Commits design review operation state to session meta.
 * This is the "reliably save intent" step in the dispatch sequence.
 *
 * Key invariants:
 * - Operation state is written before RPC call
 * - If write fails, dispatch is aborted (no orphaned RPC)
 * - Operation identity is preserved across retries
 *
 * @param session - Session with getMeta/updateMeta interface
 * @param operation - Operation to commit
 * @param state - Current design review state
 * @returns Updated state or undefined if commit failed
 */
export function commitDesignReviewOperation(
  session: DispatchSessionLike,
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

  // Determine target phase
  const targetPhase = operation.kind === "review" ? "review_running" : "update_running";

  // Validate transition
  if (!isValidTransition(state.phase, targetPhase)) {
    safeWriteAuditLog("design_review_dispatch", {
      reason: "invalid_transition_at_commit",
      fromPhase: state.phase,
      toPhase: targetPhase,
    }, "error");
    return undefined;
  }

  // Update state with new operation
  const updatedState: DesignReviewState = {
    ...state,
    phase: targetPhase,
    operation,
    updatedAt: Date.now(),
  };

  // Write to session meta
  const updatedMeta = session.updateMeta({
    designReview: updatedState,
  });

  if (!updatedMeta) {
    safeWriteAuditLog("design_review_dispatch", {
      reason: "meta_write_failed",
      operationId: operation.operationId,
    }, "error");
    return undefined;
  }

  // Verify write succeeded by reading back
  const verifyMeta = session.getMeta();
  if (!verifyMeta?.designReview || verifyMeta.designReview.operation?.operationId !== operation.operationId) {
    safeWriteAuditLog("design_review_dispatch", {
      reason: "meta_write_verification_failed",
      operationId: operation.operationId,
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

  return updatedState;
}

/**
 * Writes back RPC result to design review state.
 * This is the "writeback or conditional cleanup" step.
 *
 * Key invariants:
 * - Only writes back if operation identity matches (prevents stale writes)
 * - Clears operation on completion/failure
 * - Preserves round and authorization across retries
 *
 * @param session - Session with getMeta/updateMeta interface
 * @param operationId - Operation ID to match
 * @param agentId - Agent ID if spawned successfully
 * @param status - Dispatch status (dispatched, completed, failed)
 * @returns Updated state or undefined if writeback failed
 */
export function writebackDesignReviewResult(
  session: DispatchSessionLike,
  operationId: string,
  agentId: string | undefined,
  status: "dispatched" | "completed" | "failed",
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

  // Update operation dispatch state
  let updatedState: DesignReviewState;

  if (status === "dispatched") {
    if (!agentId) {
      safeWriteAuditLog("design_review_dispatch", {
        reason: "dispatched_without_agent_id",
        operationId,
      }, "error");
      return undefined;
    }

    updatedState = {
      ...state,
      operation: {
        ...currentOp,
        dispatchState: "dispatched",
        agentId,
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    };
  } else {
    // completed or failed - clear operation but preserve state
    updatedState = {
      ...state,
      operation: {
        ...currentOp,
        dispatchState: status,
        settledAt: Date.now(),
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    };
  }

  // Write to session meta
  const updatedMeta = session.updateMeta({
    designReview: updatedState,
  });

  if (!updatedMeta) {
    safeWriteAuditLog("design_review_dispatch", {
      reason: "writeback_failed",
      operationId,
      status,
    }, "error");
    return undefined;
  }

  safeWriteAuditLog("design_review_dispatch", {
    action: "writeback_completed",
    operationId,
    status,
    agentId: agentId || "none",
  });

  return updatedState;
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
