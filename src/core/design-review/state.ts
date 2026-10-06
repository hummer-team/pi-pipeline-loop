/**
 * @module design-review/state
 * 191 + 192 Phase 0: Pure functions for design-review state management.
 * Handles report path derivation, round allocation, authorization validity,
 * identity comparison and lifecycle transitions.
 *
 * I/O boundary: this module performs NO file system I/O. Round allocation
 * consumes only the caller-provided history of existing round numbers; the
 * directory scan that produces that history lives in the dispatch/entry I/O
 * layer (see `entry.ts` / `dispatch.ts`), never here.
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
  DesignReviewIdentity,
  SessionMeta,
} from "../../types";

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
  attribution?: { pipelineId?: string; requirementDoc?: string; round?: number },
): DesignReviewState {
  const now = Date.now();
  const round = attribution?.round ?? 1;
  const reportDoc = deriveReportPath(planDoc, round);
  return {
    schemaVersion: 1,
    planDoc: path.resolve(planDoc),
    authorizationId: generateUUID(),
    authorizationSource,
    ownerSessionFile,
    round,
    reportDoc,
    planHash,
    phase: "review_ready",
    ...(attribution?.pipelineId !== undefined ? { pipelineId: attribution.pipelineId } : {}),
    ...(attribution?.requirementDoc !== undefined
      ? { requirementDoc: path.resolve(attribution.requirementDoc) }
      : {}),
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

// ─── 192 Phase 0: identity predicates and flow classification ────────────────

/**
 * Result of narrowing a design-review flow classification.
 * - "ordinary": this feature is not involved; existing pipeline behavior applies.
 * - "authorized": an active, identity-complete closed loop is present; the
 *   domain consumer MUST handle it (never fall back to ordinary branches).
 * - "blocked": the feature exists but identity narrowing failed (invalid or
 *   incomplete state); must be handled as takeover/pending, never ordinary.
 */
export type DesignReviewFlowKind = "ordinary" | "authorized" | "blocked";

export interface DesignReviewFlowClassification {
  kind: DesignReviewFlowKind;
  /** Narrowed state when present (authorized/blocked); undefined for ordinary */
  state?: DesignReviewState;
  /** Machine-readable reason for "blocked" */
  reason?: string;
}

/**
 * Runtime completeness check for a persisted design-review state.
 * Validity is decided by FULL field validation, not by the numeric
 * schemaVersion (old meta with schemaVersion=1 is read compatibly; whether it
 * is usable depends on these fields).
 *
 * Required: authorizationId, planDoc, round (>=1), phase (known value).
 */
export function hasCompleteDesignReviewIdentity(state: unknown): state is DesignReviewState {
  if (typeof state !== "object" || state === null) {
    return false;
  }
  const s = state as Partial<DesignReviewState>;
  if (typeof s.authorizationId !== "string" || s.authorizationId.length === 0) {
    return false;
  }
  if (typeof s.planDoc !== "string" || s.planDoc.length === 0) {
    return false;
  }
  if (typeof s.round !== "number" || !Number.isInteger(s.round) || s.round < 1) {
    return false;
  }
  const phases: DesignReviewPhase[] = [
    "review_ready",
    "review_running",
    "update_ready",
    "update_running",
    "pass_ready",
    "paused",
    "finished",
  ];
  if (!phases.includes(s.phase as DesignReviewPhase)) {
    return false;
  }
  return true;
}

/**
 * Build the full business identity for the CURRENT operation of a narrowed
 * state. Document paths are canonicalized against the process/project root.
 *
 * @param meta - Current session meta (pipelineId source)
 * @param state - Narrowed design-review state
 * @param operation - The operation to bind identity to (defaults to state.operation)
 * @returns Identity tuple, or undefined when the state has no operation to bind.
 */
export function buildDesignReviewIdentity(
  meta: SessionMeta,
  state: DesignReviewState,
  operation?: DesignReviewOperation,
): DesignReviewIdentity | undefined {
  const op = operation ?? state.operation;
  if (!op) {
    return undefined;
  }
  const identity: DesignReviewIdentity = {
    pipelineId: meta.pipelineId ?? "unknown",
    ...(state.requirementDoc !== undefined ? { requirementDoc: state.requirementDoc } : {}),
    planDoc: state.planDoc,
    authorizationId: state.authorizationId,
    round: state.round,
    kind: op.kind,
    operationId: op.operationId,
    stageVisitId: op.stageVisitId,
    ...(op.inputHash !== undefined ? { inputHash: op.inputHash } : {}),
  };
  return identity;
}

/**
 * Full identity comparison over the complete tuple.
 * Any single differing component (kind, round, stageVisitId included — even
 * for same-millisecond visits) makes the identities unequal. Undefined vs
 * defined optional fields are also unequal: no field-omission guessing.
 */
export function identityEquals(
  a: DesignReviewIdentity | undefined,
  b: DesignReviewIdentity | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  return (
    a.pipelineId === b.pipelineId &&
    a.requirementDoc === b.requirementDoc &&
    path.resolve(a.planDoc) === path.resolve(b.planDoc) &&
    a.authorizationId === b.authorizationId &&
    a.round === b.round &&
    a.kind === b.kind &&
    a.operationId === b.operationId &&
    a.stageVisitId === b.stageVisitId &&
    a.inputHash === b.inputHash
  );
}

/**
 * Check whether the given identity refers to the CURRENT run's active
 * design-review operation: same authorization/round/kind/operation as stored
 * in the state, plus matching inputHash when both sides carry one.
 *
 * This is the runtime ownership gate — a pure type assertion is never used
 * as an ownership check elsewhere.
 */
export function isAuthorizedCurrentRun(
  meta: SessionMeta,
  state: DesignReviewState,
  candidate: DesignReviewIdentity,
): boolean {
  const current = buildDesignReviewIdentity(meta, state);
  if (!current) {
    // No operation bound: only a candidate with matching authorization/round
    // and a kind-less comparison is NOT accepted — absence of operation means
    // there is no current run identity to authorize.
    return false;
  }
  return identityEquals(current, candidate);
}

/**
 * True when the current operation is a develop-handoff that has not been
 * reliably finalized (dispatch receipt + finished both missing). Such a state
 * must NEVER be classified ordinary, regardless of currentStage=develop.
 */
export function isDevelopHandoffOperation(meta: SessionMeta): boolean {
  const state = meta.designReview;
  if (!state || !state.operation) {
    return false;
  }
  if (state.operation.kind !== "develop-handoff") {
    return false;
  }
  // A handoff is "unfinished" until it reaches a terminal dispatch state.
  return !["completed", "cancelled"].includes(state.operation.dispatchState);
}

/**
 * Classify the design-review flow for hook/tool entry points.
 *
 * Distinguishes "no involvement of this feature (ordinary)" from "this
 * feature exists but identity is invalid (blocked)" and "active authorized
 * loop (authorized)". pass_ready / paused states — including an unfinished
 * develop-handoff while currentStage is already develop — remain
 * authorized/blocked and are never released to ordinary branches.
 *
 * Behavior note (Phase 0): "finished" is currently treated as ordinary
 * (terminal, released). Phase 4 tightens this to require the current
 * handoff's persisted success receipt before release.
 */
export function classifyDesignReviewFlow(meta: SessionMeta | undefined): DesignReviewFlowClassification {
  const state = meta?.designReview;
  if (!state) {
    return { kind: "ordinary" };
  }
  if (!hasCompleteDesignReviewIdentity(state)) {
    return { kind: "blocked", state, reason: "identity_incomplete" };
  }
  if (state.phase === "finished") {
    // 191-compat terminal release; Phase 4 adds receipt evidence requirement.
    return { kind: "ordinary" };
  }
  if (state.phase === "paused" && state.pauseReason === "authorization-lost") {
    return { kind: "ordinary" };
  }
  return { kind: "authorized", state };
}

/**
 * 192 Phase 0 (task 4): allocate the next round from a caller-provided set of
 * existing round numbers. Pure: the directory scan that gathers the history
 * lives in the entry/dispatch I/O layer, never here.
 *
 * @param existingRounds - Round numbers already occupied (strictly-named files
 *   in the plan directory). Empty array means the next round is 1.
 */
export function allocateNextRoundSafe(existingRounds: readonly number[]): number {
  let max = 0;
  for (const r of existingRounds) {
    if (Number.isInteger(r) && r > max) {
      max = r;
    }
  }
  return max + 1;
}
