/**
 * @module stage-executor/contracts
 * 194 Phase 0 (C3 + C5): bounded runtime identity, declaration and consumption
 * contracts for CLOSED-LOOP stage executors (design-review / plan / develop).
 *
 * Design rules enforced by these shapes:
 * - Exactly ONE latest run is tracked (`SessionMeta.stageExecutorRun`). There
 *   is deliberately no unbounded history array — audit JSON Lines is the
 *   history surface.
 * - A run is created ONLY from a trusted RPC reply carrying the full agent id;
 *   intent/preparation state stays on the operation (operationId/activeSpawns).
 * - Executor authority is proven by runtime evidence (owner session file,
 *   parent session, registry `getRecord(fullId).sessionFile`), never by a
 *   short id, a time window, or `active_agent` prompt text.
 * - Declarations (child → owner) and consumption (owner → verify/confirm) are
 *   separate persisted milestones: a child calling a tool NEVER verifies,
 *   advances, or counts budget by itself.
 *
 * This file is type/value-only (no imports besides the type-only PipelineStage
 * bridge) so `src/types.ts` can re-export it without a runtime module cycle.
 */

import type { PipelineStage } from "../../types";

/** Stages whose plugin-dispatched executor may own a bounded run (C3). */
export const STAGE_EXECUTOR_STAGES = ["design-review", "plan", "develop"] as const;

export type StageExecutorStage = (typeof STAGE_EXECUTOR_STAGES)[number];

/** True when `stage` is inside the closed-loop executor scope (C3). */
export function isStageExecutorStage(stage: unknown): stage is StageExecutorStage {
  return (
    typeof stage === "string" &&
    (STAGE_EXECUTOR_STAGES as readonly string[]).includes(stage)
  );
}

/**
 * 194 C3: identity of one ACTUAL execution attempt. A new runId is issued for
 * every attempt; superseding a run replaces this whole binding atomically.
 */
export interface StageExecutorBinding {
  /** Fresh id per actual execution attempt (plugin-issued UUID) */
  readonly runId: string;
  /** Owning pipeline id */
  readonly pipelineId: string;
  /** Owner (parent) session file — trusted runtime evidence */
  readonly ownerSessionFile: string;
  /** Executor stage (closed-loop subset only) */
  readonly stage: StageExecutorStage;
  /** Stage visit id at dispatch (stageStartTime) */
  readonly stageVisitId: number;
  /** Design-review / operation id this run belongs to */
  readonly operationId: string;
  /** FULL agent id exactly as returned by the trusted RPC reply */
  readonly agentId: string;
  /**
   * Executor session file, recorded ONLY from runtime registry evidence
   * (`getRecord(fullId).sessionFile`). Absent until such evidence exists —
   * absence blocks authority, it never falls back to a guess.
   */
  readonly executorSessionFile?: string;
}

/** Terminal-vs-live status of the run as proven by runtime evidence. */
export type StageExecutorStatus = "running" | "completed" | "failed" | "aborted" | "unknown";

/** Explicit recovery posture after a failed/aborted terminal (D4). */
export type StageExecutorRecovery = "none" | "awaiting-owner" | "budget-exhausted";

/** Which plugin entry requested the latest child-side declaration (C5). */
export type StageDeclarationRequester = "stage_advance" | "pipeline_verify";

/**
 * 194 C5: the child executor's LATEST completion declaration, registered by a
 * tool call under a verified current binding and consumed later by the owner.
 * The plugin issues `declarationId`; models cannot supply it.
 */
export interface StageCompletionDeclaration {
  /** Plugin-issued id tied to the current run */
  readonly declarationId: string;
  /** Monotonic revision of this declaration within the run */
  readonly revision: number;
  /** Real tool entry that produced (or last merged into) this declaration */
  readonly requestedBy: StageDeclarationRequester;
  /** Set when a pipeline_verify request merged fresh-verification intent */
  readonly verificationRequested?: boolean;
  /**
   * Advance target recorded from a REAL stage_advance call. Present only for
   * that call shape; omission in a stage_advance call is normalized per the
   * existing API (never inferred from a terminal or a wake).
   */
  readonly nextStage?: PipelineStage | null;
  /**
   * Confirm intent recorded from a REAL stage_advance call (omission = false).
   * Owner relays must never downgrade a stored `true` from omitted args.
   */
  readonly needConfirm?: boolean;
}

/** Owner-side consumption state for the latest declaration (C5). */
export type StageOwnerConsumptionState =
  | "awaiting-terminal"
  | "awaiting-declaration"
  | "awaiting-owner-tool"
  | "awaiting-confirmation"
  | "applied";

/**
 * 194 C5: owner consumption progress of the current run. `resultKey` binds a
 * consumed result to (run + declaration + verified input fingerprints) for
 * DEDUPLICATION only — it is never a cache that replaces fresh verification.
 */
export interface StageOwnerConsumption {
  readonly state: StageOwnerConsumptionState;
  readonly declarationRevision?: number;
  readonly resultKey?: string;
}

/**
 * 194 C3: the single latest closed-loop executor run persisted on SessionMeta.
 *
 * `terminalConsumed` becomes true ONLY after the owner has reliably advanced
 * or legitimately paused; a PASS still awaiting a tool/confirmation is NOT
 * consumed, and an un-persisted failure keeps the pending wake.
 */
export interface StageExecutorRun {
  readonly binding: StageExecutorBinding;
  readonly status: StageExecutorStatus;
  readonly recovery: StageExecutorRecovery;
  /** Consecutive failed/aborted terminals sharing one result are counted ONCE */
  readonly consecutiveFailures: number;
  readonly terminalConsumed: boolean;
  /** Plugin-issued wake marker, consumed exactly once with the current binding */
  readonly pendingWakeId?: string;
  readonly declaration?: StageCompletionDeclaration;
  readonly consumption?: StageOwnerConsumption;
}

/** True while the run may still be executing or its end is unproven. */
export function isRunUnfinished(run: StageExecutorRun | undefined): boolean {
  if (!run) return false;
  return run.status === "running" || run.status === "unknown";
}

/**
 * 194 C3/C5: strict expectation for MetaCommitExpectation and terminal/wake
 * closures — every component must match exactly (undefined = do not check,
 * `null` for runId = assert there is NO current run).
 */
export interface StageExecutorExpectation {
  /** Expected binding.stage of the CURRENT run */
  executorStage?: StageExecutorStage;
  /** Expected binding.stageVisitId of the CURRENT run */
  executorStageVisitId?: number;
  /** Expected binding.runId; `null` asserts there is NO current run */
  executorRunId?: string | null;
  /** Expected run.terminalConsumed of the CURRENT run */
  executorTerminalConsumed?: boolean;
  /** Expected declaration.revision; `null` asserts NO declaration */
  executorDeclarationRevision?: number | null;
  /** Expected consumption.resultKey; `null` asserts NO result key */
  executorResultKey?: string | null;
  /** Expected binding.pipelineId (defaults to MetaCommitExpectation.pipelineId) */
  executorPipelineId?: string;
  /** Expected binding.operationId */
  executorOperationId?: string;
}
