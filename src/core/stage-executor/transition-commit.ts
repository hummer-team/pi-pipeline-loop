/**
 * @module stage-executor/transition-commit
 * 194 Phase 3 (C5): RELIABLE commits for every side effect that participates
 * in a closed-loop executor run — stage exits, failure records and confirm
 * gate bookkeeping.
 *
 * The rules this module enforces (plan C5 "阶段写入与共享调用链"):
 * - a bound write (an un-consumed run bound to the stage being written) NEVER
 *   falls back to a plain `updateMeta`: it goes through ONE strict commit
 *   anchored on the current run (stage / visit / runId / declarationRevision);
 * - the internal OWNER context is derived from real runtime evidence at the
 *   commit site (`detectSessionRole`) — it is never a model parameter
 *   (`isOwner`/`runId`/`forceConsume` do not exist on any tool surface);
 * - a stage exit atomically includes the visit patch, the stage/reset fields,
 *   `terminalConsumed` and the `applied` consumption record, and clears the
 *   outstanding `pendingWakeId` (the wake has been acted on);
 * - nothing is consumed, dispatched or reported as success unless the commit
 *   status is exactly `persisted`.
 */

import type {
  PipelineStage,
  SessionMeta,
  StageExecutorRun,
  StageOwnerConsumptionState,
} from "../../types";
import { strictCommitMeta } from "../session-state";
import { executorExpectationFromCurrent } from "./commit-guard";
import { detectSessionRole } from "../session-role";
import { resetFailureBudget } from "./run-state";

/** Minimal strict-commit-capable session surface (structural, test-friendly). */
export interface TransitionCommitSession {
  /**
   * Not used by the commit itself (the anchor comes from the passed meta),
   * but the strict-commit adapter shape requires it — provide a fallback.
   */
  getMeta?(): SessionMeta | undefined;
  updateMeta(patch: Partial<SessionMeta>): SessionMeta | undefined;
  updateMetaVerified?(
    patch: Partial<SessionMeta>,
    expected: Parameters<typeof strictCommitMeta>[2],
  ): ReturnType<typeof strictCommitMeta>;
}

/**
 * 194 C5: adapt an optional-getMeta session to the strict-commit shape.
 * The anchor expectations always come from the CALLER's meta snapshot, so
 * a fallback read of that same snapshot is honest and side-effect free.
 */
function commitSession(
  session: TransitionCommitSession,
  meta: SessionMeta,
): Parameters<typeof strictCommitMeta>[0] {
  return {
    ...session,
    getMeta: session.getMeta?.bind(session) ?? (() => meta),
  };
}

/** Result of one bound-aware commit attempt. */
export type BoundCommitResult =
  | { status: "not-bound" }
  | { status: "persisted"; run: StageExecutorRun }
  | { status: "duplicate" }
  | { status: "refused"; reason: string };

/**
 * The run that PARTICIPATES in a write targeting `sourceStage`: an un-consumed
 * run bound to exactly that stage. Absent participation → callers keep their
 * legacy (ordinary) path untouched.
 */
export function boundActiveRun(
  meta: SessionMeta,
  sourceStage: PipelineStage | string,
): StageExecutorRun | null {
  const run = meta.stageExecutorRun;
  if (!run || run.terminalConsumed) return null;
  if (run.binding.stage !== sourceStage) return null;
  return run;
}

/**
 * 194 C5: prove the CALLING runtime is the owner session of the CURRENT run.
 * Evidence only (session role + owner session file from the trusted binding);
 * never a role fail-open: detection absence means NOT proven.
 */
export function proveOwnerRuntime(
  meta: SessionMeta,
  runtimeCtx: unknown,
): { ok: true } | { ok: false; reason: string } {
  const run = meta.stageExecutorRun;
  if (!run) return { ok: false, reason: "no_current_run" };
  let role: ReturnType<typeof detectSessionRole> | null = null;
  try {
    role = detectSessionRole(runtimeCtx as Parameters<typeof detectSessionRole>[0]);
  } catch {
    role = null;
  }
  if (!role || !role.sessionFile) return { ok: false, reason: "session_file_unproven" };
  if (role.isChild) return { ok: false, reason: "child_caller" };
  if (role.sessionFile !== run.binding.ownerSessionFile) {
    return { ok: false, reason: "owner_session_mismatch" };
  }
  return { ok: true };
}

/**
 * ONE atomic commit for a bound stage exit: transition fields + consumption
 * (`terminalConsumed`, `applied`, wake marker cleared, failure budget reset by
 * the legitimate new stage). Non-bound callers receive `not-bound` and keep
 * their existing `updateMeta` behaviour.
 */
export function commitBoundStageExit(deps: {
  session: TransitionCommitSession;
  /** Fresh meta snapshot anchoring the strict expectation. */
  meta: SessionMeta;
  /** The stage being exited (must equal the bound run's stage). */
  sourceStage: PipelineStage | string;
  /** Full transition delta (visit patch + stage/reset fields). */
  transitionPatch: Partial<SessionMeta>;
  /** Raw entry ctx — owner evidence is derived from it internally. */
  runtimeCtx: unknown;
  consumptionState?: StageOwnerConsumptionState;
  resultKey?: string;
}): BoundCommitResult {
  const run = boundActiveRun(deps.meta, deps.sourceStage);
  if (!run) return { status: "not-bound" };

  const owner = proveOwnerRuntime(deps.meta, deps.runtimeCtx);
  if (!owner.ok) return { status: "refused", reason: `owner_unproven:${owner.reason}` };

  const base = resetFailureBudget(run);
  const consumed: StageExecutorRun = {
    ...base,
    terminalConsumed: true,
    // The wake for this run has been acted on: exactly-once means it must
    // never be re-served after consumption.
    pendingWakeId: undefined,
    consumption: {
      state: deps.consumptionState ?? "applied",
      ...(run.declaration !== undefined ? { declarationRevision: run.declaration.revision } : {}),
      ...(deps.resultKey !== undefined
        ? { resultKey: deps.resultKey }
        : run.consumption?.resultKey !== undefined
          ? { resultKey: run.consumption.resultKey }
          : {}),
    },
  };

  const res = strictCommitMeta(
    commitSession(deps.session, deps.meta),
    { ...deps.transitionPatch, stageExecutorRun: consumed },
    {
      pipelineId: deps.meta.pipelineId ?? "unknown",
      ...executorExpectationFromCurrent(deps.meta),
    },
  );
  if (res.status !== "persisted") {
    return {
      status: "refused",
      reason: `commit_${res.status}:${"reason" in res ? res.reason : "unknown"}`,
    };
  }
  return { status: "persisted", run: consumed };
}

/**
 * ONE atomic commit recording a bound verification FAILURE: the failure delta
 * plus the result key that deduplicates the same result across the hook and
 * tool paths (a re-reported identical failure is `duplicate` and counts ONCE).
 * Consumption stays false and the pending wake is kept — a failure is only
 * consumed by a legitimate owner advance/pause (C3).
 */
export function commitBoundFailureRecord(deps: {
  session: TransitionCommitSession;
  meta: SessionMeta;
  sourceStage: PipelineStage | string;
  /** Failure delta (verifyAttempts / verifyFailures / feedback fields). */
  failurePatch: Partial<SessionMeta>;
  runtimeCtx: unknown;
  resultKey: string;
}): BoundCommitResult {
  const run = boundActiveRun(deps.meta, deps.sourceStage);
  if (!run) return { status: "not-bound" };

  if (run.consumption?.resultKey === deps.resultKey) {
    // Same result already recorded: no second increment, no second write.
    return { status: "duplicate" };
  }

  const owner = proveOwnerRuntime(deps.meta, deps.runtimeCtx);
  if (!owner.ok) return { status: "refused", reason: `owner_unproven:${owner.reason}` };

  const nextRun: StageExecutorRun = {
    ...run,
    consumption: {
      state: run.consumption?.state ?? "awaiting-terminal",
      ...(run.declaration !== undefined
        ? { declarationRevision: run.declaration.revision }
        : {}),
      resultKey: deps.resultKey,
    },
  };
  const res = strictCommitMeta(
    commitSession(deps.session, deps.meta),
    { ...deps.failurePatch, stageExecutorRun: nextRun },
    {
      pipelineId: deps.meta.pipelineId ?? "unknown",
      ...executorExpectationFromCurrent(deps.meta),
    },
  );
  if (res.status !== "persisted") {
    return {
      status: "refused",
      reason: `commit_${res.status}:${"reason" in res ? res.reason : "unknown"}`,
    };
  }
  return { status: "persisted", run: nextRun };
}

/**
 * A bound bookkeeping write (confirm counts / gate resets): strict-anchored,
 * owner-proven, and it does NOT consume the run. Non-bound callers keep the
 * legacy plain write.
 */
export function commitBoundGateWrite(deps: {
  session: TransitionCommitSession;
  meta: SessionMeta;
  sourceStage: PipelineStage | string;
  patch: Partial<SessionMeta>;
  runtimeCtx: unknown;
}): BoundCommitResult {
  const run = boundActiveRun(deps.meta, deps.sourceStage);
  if (!run) return { status: "not-bound" };

  const owner = proveOwnerRuntime(deps.meta, deps.runtimeCtx);
  if (!owner.ok) return { status: "refused", reason: `owner_unproven:${owner.reason}` };

  const res = strictCommitMeta(
    commitSession(deps.session, deps.meta),
    // The run record itself is UNCHANGED — pinning it in the expectation is
    // what makes this an anchored write, not a blind patch.
    deps.patch,
    {
      pipelineId: deps.meta.pipelineId ?? "unknown",
      ...executorExpectationFromCurrent(deps.meta),
    },
  );
  if (res.status !== "persisted") {
    return {
      status: "refused",
      reason: `commit_${res.status}:${"reason" in res ? res.reason : "unknown"}`,
    };
  }
  return { status: "persisted", run };
}
