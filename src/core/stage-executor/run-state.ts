/**
 * @module stage-executor/run-state
 * 194 Phase 0 (C3 + C5): PURE state helpers for the latest closed-loop
 * executor run — declaration merging, terminal/failure counting and wake
 * deduplication. No I/O, no meta access: callers persist the returned values
 * through strict commits (see `commit-guard.ts` + session-state).
 *
 * Every function here is the single source of truth for its rule; Phase 3
 * wiring must reuse these helpers instead of re-deriving budgets elsewhere.
 */

import type { PipelineStage } from "../../types";
import type {
  StageCompletionDeclaration,
  StageDeclarationRequester,
  StageExecutorBinding,
  StageExecutorRun,
  StageExecutorStatus,
  StageOwnerConsumptionState,
} from "./contracts";

/**
 * Strict binding equality: every identity component (including the full agent
 * id) must match. Used for terminal-closure, JOIN comparison and wake checks.
 * `executorSessionFile` participates only when BOTH sides recorded it — the
 * binding's own session evidence must never be refreshed by a JOIN echo.
 */
export function sameBinding(a: StageExecutorBinding, b: StageExecutorBinding): boolean {
  if (
    a.runId !== b.runId
    || a.pipelineId !== b.pipelineId
    || a.ownerSessionFile !== b.ownerSessionFile
    || a.stage !== b.stage
    || a.stageVisitId !== b.stageVisitId
    || a.operationId !== b.operationId
    || a.agentId !== b.agentId
  ) {
    return false;
  }
  if (a.executorSessionFile !== undefined && b.executorSessionFile !== undefined) {
    return a.executorSessionFile === b.executorSessionFile;
  }
  return true;
}

/** A caller proven against the CURRENT run binding (exact identity match). */
export function bindingMatchesCurrent(
  run: StageExecutorRun | undefined,
  binding: StageExecutorBinding | undefined,
): boolean {
  if (!run || !binding) return false;
  return sameBinding(run.binding, binding);
}

/** Input for one declaration merge request (C5 caller-gate side). */
export interface DeclarationRequest {
  /** Which tool entry produced this request */
  requestedBy: StageDeclarationRequester;
  /**
   * True ONLY for a real `stage_advance` tool call (the plugin entry proves
   * it). Relays from terminal/wake/verify-only paths MUST pass false so a
   * stored `needConfirm: true` can never be downgraded by omitted arguments.
   */
  isRealStageAdvanceCall: boolean;
  /** Advance target from a real stage_advance call (already normalized) */
  nextStage?: PipelineStage | null;
  /** Raw needConfirm presence in the call args (real stage_advance only) */
  needConfirmProvided?: boolean;
  /** needConfirm value carried by the call (undefined when omitted) */
  needConfirm?: boolean;
  /** Fresh-verification intent (pipeline_verify) */
  verificationRequested?: boolean;
}

/** Result of merging one declaration request into the run's latest state. */
export interface DeclarationMergeResult {
  declaration: StageCompletionDeclaration;
  /** True when the declaration changed in a way that warrants a NEW owner wake */
  revisionChanged: boolean;
}

/**
 * 194 C5 rule 4: merge a declaration request into the latest declaration.
 *
 * - first request            → revision 1
 * - advance THEN verify      → merges `verificationRequested` only, keeps the
 *   completion intent, NO revision bump
 * - verify THEN advance      → completes the intent, bumps the revision
 * - changed completion intent→ bumps the revision
 * - identical request        → no bump (no wake, no budget, no UI churn)
 *
 * @param existing - Current declaration (undefined when none)
 * @param request - Merged view of the incoming call (needConfirm already
 *   normalized by the caller: real stage_advance omission = false)
 * @param issueDeclarationId - Plugin-side id issuer (never model-supplied)
 */
export function mergeDeclaration(
  existing: StageCompletionDeclaration | undefined,
  request: DeclarationRequest,
  issueDeclarationId: () => string,
): DeclarationMergeResult {
  const nextStage = request.isRealStageAdvanceCall ? request.nextStage ?? null : undefined;
  const needConfirm = request.isRealStageAdvanceCall
    ? request.needConfirmProvided === true && request.needConfirm === true
    : undefined;
  const verification = request.verificationRequested === true;

  if (!existing) {
    const declaration: StageCompletionDeclaration = {
      declarationId: issueDeclarationId(),
      revision: 1,
      requestedBy: request.requestedBy,
      ...(request.isRealStageAdvanceCall ? { nextStage, needConfirm } : {}),
      ...(verification ? { verificationRequested: true } : {}),
    };
    return { declaration, revisionChanged: true };
  }

  const existingHasIntent = existing.nextStage !== undefined;
  const incomingHasIntent = request.isRealStageAdvanceCall;

  // Completion intent counts only when the incoming call is a real
  // stage_advance: verify-only relays NEVER change the stored target.
  const intentChanged = incomingHasIntent && (
    !existingHasIntent
    || existing.nextStage !== nextStage
    || (existing.needConfirm ?? false) !== (needConfirm ?? false)
  );
  const verificationChanged = verification && existing.verificationRequested !== true;

  // Identical (or verification-only when already requested) → no bump, no wake.
  if (!intentChanged && !verificationChanged) {
    return { declaration: existing, revisionChanged: false };
  }

  const nextVerificationRequested = verification || existing.verificationRequested === true;
  return {
    declaration: {
      ...existing,
      ...(incomingHasIntent ? { nextStage, needConfirm } : {}),
      ...(nextVerificationRequested ? { verificationRequested: true } : {}),
      revision: existing.revision + (intentChanged ? 1 : 0),
      // The requester label tracks the LAST meaningful completion intent.
      requestedBy: incomingHasIntent ? "stage_advance" : existing.requestedBy,
    },
    revisionChanged: intentChanged,
  };
}

/**
 * 194 C3/C5: canonical result key for one consumed outcome — binds the run,
 * the declaration revision and the verified input fingerprints so the same
 * result is counted ONCE across hook/tool paths (deduplication only; never a
 * substitute for fresh verification).
 */
export function computeResultKey(parts: {
  runId: string;
  declarationRevision: number | undefined;
  inputFingerprints: readonly string[];
}): string {
  return [parts.runId, parts.declarationRevision ?? "none", ...parts.inputFingerprints].join("|");
}

/**
 * 194 D4/Phase 3 rule 6: apply one terminal status to the run.
 *
 * - Same resultKey as the current consumption → `duplicate_ignored` (no
 *   budget, no wake, no second failure count).
 * - failed/aborted → increments consecutiveFailures; reaching `budgetLimit`
 *   flips recovery to `budget-exhausted` (no 4th same-visit attempt).
 * - completed/unknown/running → NEVER touch the budget: only a successful
 *   owner verification or a new stage resets it (see `resetFailureBudget`).
 *
 * The caller decides `terminalConsumed` (reliable advance/pause only) — this
 * helper never claims consumption.
 */
export function applyTerminalStatus(
  run: StageExecutorRun,
  status: StageExecutorStatus,
  resultKey: string | undefined,
  budgetLimit: number,
  consumptionState?: StageOwnerConsumptionState,
): { run: StageExecutorRun; duplicateIgnored: boolean; budgetExhausted: boolean } {
  const lastKey = run.consumption?.resultKey;
  const isFailure = status === "failed" || status === "aborted";

  if (isFailure && resultKey !== undefined && lastKey === resultKey) {
    return { run, duplicateIgnored: true, budgetExhausted: run.recovery === "budget-exhausted" };
  }

  const consecutiveFailures = isFailure ? run.consecutiveFailures + 1 : run.consecutiveFailures;

  const budgetExhausted = isFailure && consecutiveFailures >= budgetLimit;
  const nextRun: StageExecutorRun = {
    ...run,
    status,
    consecutiveFailures,
    recovery: budgetExhausted ? "budget-exhausted" : isFailure ? "awaiting-owner" : run.recovery,
    // The consumption RECORD is written only when there is a result to bind.
    // An existing record keeps its state (the owner mode is decided by the
    // caller, not here); a new record uses the caller-provided mode state.
    ...(resultKey === undefined
      ? {}
      : run.consumption === undefined
        ? { consumption: { state: consumptionState ?? "awaiting-terminal", resultKey } }
        : { consumption: { ...run.consumption, resultKey } }),
  };
  return { run: nextRun, duplicateIgnored: false, budgetExhausted };
}

/**
 * 194 D4/Phase 3 rule 6: the consecutive-failure budget is cleared ONLY by a
 * successful owner-side verification (or a legitimate new stage, which builds
 * a fresh run). A raw terminal `completed` status never resets it here.
 */
export function resetFailureBudget(run: StageExecutorRun): StageExecutorRun {
  if (run.consecutiveFailures === 0 && run.recovery === "none") return run;
  return { ...run, consecutiveFailures: 0, recovery: "none" };
}

/**
 * 194 C3/Phase 3: pendingWakeId is emitted AT MOST once per run+revision.
 * Returns the wake id to announce, or null when one is already outstanding.
 */
export function takePendingWake(
  run: StageExecutorRun,
  issueWakeId: () => string,
): { run: StageExecutorRun; wakeId: string | null } {
  if (run.pendingWakeId !== undefined) return { run, wakeId: null };
  const wakeId = issueWakeId();
  return { run: { ...run, pendingWakeId: wakeId }, wakeId };
}

/** True when a fresh wake may be issued for the current declaration revision. */
export function shouldIssueOwnerWake(run: StageExecutorRun): boolean {
  if (!run.declaration) return false;
  if (run.terminalConsumed) return false;
  return run.pendingWakeId === undefined;
}
