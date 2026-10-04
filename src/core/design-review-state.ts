/**
 * @module design-review-state
 * Phase 0 / 191: Pure functions for design-review state management.
 * Handles report path derivation, round allocation, authorization validity,
 * and state transitions. No I/O or storage — all functions are pure.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import type {
  DesignReviewState,
  DesignReviewPhase,
  DesignReviewAuthorizationSource,
  DesignReviewOperationKind,
  DesignReviewDispatchState,
  DesignReviewOperation,
  DesignReviewPauseReason,
} from "../types";

/**
 * Generate a UUID v4 for operation/authorization IDs.
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Compute a SHA-256 hash of content (hex-encoded).
 * Used for plan/report hash tracking.
 */
export function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Derive the report document path for a given plan and round.
 * Format: {dirname(planDoc)}/review-design-{round}-{basename(planDoc)}
 *
 * @param planDoc - Absolute path to the plan document
 * @param round - Round number (1-based)
 * @returns Absolute path to the report document
 */
export function deriveReportPath(planDoc: string, round: number): string {
  const dir = path.dirname(planDoc);
  const base = path.basename(planDoc);
  return path.join(dir, `review-design-${round}-${base}`);
}

/**
 * Check if a report path matches the expected naming pattern for a given round.
 *
 * @param reportPath - Report path to check
 * @param planDoc - Plan document path
 * @param round - Expected round number
 * @returns true if the report path matches the pattern
 */
export function isReportForRound(reportPath: string, planDoc: string, round: number): boolean {
  const expected = deriveReportPath(planDoc, round);
  return path.resolve(reportPath) === path.resolve(expected);
}

/**
 * Allocate the next round number based on existing state.
 * Round 1 for first review; increments for subsequent reviews after update.
 *
 * @param currentState - Current design-review state (or undefined for first round)
 * @returns Next round number (1-based)
 */
export function allocateNextRound(currentState: DesignReviewState | undefined): number {
  if (!currentState) {
    return 1;
  }
  return currentState.round + 1;
}

/**
 * Check if an authorization is still valid.
 * Authorization is invalid when:
 * - Phase is "finished" (terminal state)
 * - Phase is "paused" with reason "authorization-lost"
 *
 * @param state - Design-review state to check
 * @returns true if authorization is valid
 */
export function isAuthorizationValid(state: DesignReviewState | undefined): boolean {
  if (!state) {
    return false;
  }
  if (state.phase === "finished") {
    return false;
  }
  if (state.phase === "paused" && state.pauseReason === "authorization-lost") {
    return false;
  }
  return true;
}

/**
 * Check if a state transition is valid.
 * Defines the allowed phase transitions for the design-review lifecycle.
 *
 * @param from - Current phase
 * @param to - Target phase
 * @returns true if the transition is allowed
 */
export function isValidTransition(from: DesignReviewPhase, to: DesignReviewPhase): boolean {
  const transitions: Record<DesignReviewPhase, DesignReviewPhase[]> = {
    review_ready: ["review_running", "paused", "finished"],
    review_running: ["update_ready", "pass_ready", "paused", "finished"],
    update_ready: ["update_running", "paused", "finished"],
    update_running: ["review_ready", "paused", "finished"],
    pass_ready: ["finished", "paused"],
    paused: ["review_ready", "update_ready", "pass_ready", "finished"],
    finished: [],
  };
  return transitions[from].includes(to);
}

/**
 * Create an initial design-review state with review_ready phase.
 *
 * @param planDoc - Absolute path to the plan document
 * @param authorizationSource - Source of authorization (menu or direct-entry)
 * @param planHash - Hash of the plan document at authorization time
 * @param ownerSessionFile - Optional owner session file path
 * @returns Initial design-review state
 */
export function createInitialState(
  planDoc: string,
  authorizationSource: DesignReviewAuthorizationSource,
  planHash: string,
  ownerSessionFile?: string,
): DesignReviewState {
  const now = Date.now();
  return {
    schemaVersion: 1,
    planDoc: path.resolve(planDoc),
    authorizationId: generateUUID(),
    authorizationSource,
    ownerSessionFile,
    round: 1,
    planHash,
    phase: "review_ready",
    authorizedAt: now,
    updatedAt: now,
  };
}

/**
 * Create a new operation record.
 *
 * @param kind - Operation kind (review, update, or develop-handoff)
 * @param stageVisitId - Stage visit ID for idempotency
 * @param attempt - Attempt number (1-based)
 * @param inputHash - Optional hash of operation inputs
 * @returns New operation record
 */
export function createOperation(
  kind: DesignReviewOperationKind,
  stageVisitId: number,
  attempt: number,
  inputHash?: string,
): DesignReviewOperation {
  const now = Date.now();
  return {
    operationId: generateUUID(),
    kind,
    stageVisitId,
    attempt,
    dispatchState: "pending",
    inputHash,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Transition to a new phase with optional operation and outcome.
 * Returns a new state object (immutable update).
 *
 * @param currentState - Current state
 * @param newPhase - Target phase
 * @param operation - Optional new operation
 * @param pauseReason - Optional pause reason (required when newPhase is "paused")
 * @returns New state with updated phase and timestamp
 * @throws Error if transition is invalid
 */
export function transitionPhase(
  currentState: DesignReviewState,
  newPhase: DesignReviewPhase,
  operation?: DesignReviewOperation,
  pauseReason?: DesignReviewPauseReason,
): DesignReviewState {
  if (!isValidTransition(currentState.phase, newPhase)) {
    throw new Error(
      `Invalid design-review transition: ${currentState.phase} → ${newPhase}`,
    );
  }
  if (newPhase === "paused" && !pauseReason) {
    throw new Error("Pause reason required when transitioning to paused phase");
  }

  const newState: DesignReviewState = {
    ...currentState,
    phase: newPhase,
    updatedAt: Date.now(),
  };

  if (operation) {
    newState.operation = operation;
  }

  if (newPhase === "paused") {
    newState.pauseReason = pauseReason;
  } else {
    // Clear pause reason when leaving paused state
    delete newState.pauseReason;
  }

  return newState;
}

/**
 * Update the dispatch state of the current operation.
 * Returns a new state object (immutable update).
 *
 * @param currentState - Current state
 * @param dispatchState - New dispatch state
 * @param agentId - Optional agent ID (required when dispatchState is "dispatched")
 * @returns New state with updated operation
 * @throws Error if no operation exists or agentId is missing
 */
export function updateDispatchState(
  currentState: DesignReviewState,
  dispatchState: DesignReviewDispatchState,
  agentId?: string,
): DesignReviewState {
  if (!currentState.operation) {
    throw new Error("Cannot update dispatch state: no operation exists");
  }
  if (dispatchState === "dispatched" && !agentId) {
    throw new Error("Agent ID required when dispatch state is 'dispatched'");
  }

  const updatedOperation: DesignReviewOperation = {
    ...currentState.operation,
    dispatchState,
    updatedAt: Date.now(),
  };

  if (agentId) {
    updatedOperation.agentId = agentId;
  }

  if (dispatchState === "completed" || dispatchState === "failed") {
    updatedOperation.settledAt = Date.now();
  }

  return {
    ...currentState,
    operation: updatedOperation,
    updatedAt: Date.now(),
  };
}

/**
 * Check if the current state allows dispatching a new operation.
 * Dispatch is allowed when:
 * - Phase is review_ready, update_ready, or pass_ready
 * - No operation is currently running (dispatchState !== "dispatched")
 *
 * @param state - Current design-review state
 * @returns true if dispatch is allowed
 */
export function canDispatch(state: DesignReviewState | undefined): boolean {
  if (!state) {
    return false;
  }
  const allowedPhases: DesignReviewPhase[] = ["review_ready", "update_ready", "pass_ready"];
  if (!allowedPhases.includes(state.phase)) {
    return false;
  }
  if (state.operation && state.operation.dispatchState === "dispatched") {
    return false;
  }
  return true;
}

/**
 * Check if two operations are the same (by operationId).
 * Used for idempotency checks.
 *
 * @param op1 - First operation
 * @param op2 - Second operation
 * @returns true if operations have the same ID
 */
export function isSameOperation(
  op1: DesignReviewOperation | undefined,
  op2: DesignReviewOperation | undefined,
): boolean {
  if (!op1 || !op2) {
    return false;
  }
  return op1.operationId === op2.operationId;
}

/**
 * Check if a plan hash has drifted (changed from the authorized hash).
 * Used for drift detection.
 *
 * @param state - Current design-review state
 * @param currentPlanHash - Current plan hash to compare
 * @returns true if plan has drifted
 */
export function hasPlanDrifted(state: DesignReviewState, currentPlanHash: string): boolean {
  if (!state.planHash) {
    return false;
  }
  return state.planHash !== currentPlanHash;
}

/**
 * Identity predicate: check if two states represent the same authorization context.
 * Compares authorizationId, round, and planHash.
 *
 * @param state1 - First state
 * @param state2 - Second state
 * @returns true if states have the same authorization identity
 */
export function isSameAuthorizationContext(
  state1: DesignReviewState | undefined,
  state2: DesignReviewState | undefined,
): boolean {
  if (!state1 || !state2) {
    return false;
  }
  return (
    state1.authorizationId === state2.authorizationId &&
    state1.round === state2.round &&
    state1.planHash === state2.planHash
  );
}
