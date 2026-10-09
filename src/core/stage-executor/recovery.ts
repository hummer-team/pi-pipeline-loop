/**
 * @module stage-executor/recovery
 * 194 Phase 3 (C3/D4, task 5 + task 7): trusted failure recovery for
 * closed-loop stage executor runs.
 *
 * Two production responsibilities:
 *
 * 1. `parkExecutorFailure` — when `applyExecutorTerminal` persisted a
 *    failed/aborted terminal (D4: "failed/aborted or no trustworthy delivery
 *    pauses; the owner recovers explicitly"), park the pipeline honestly:
 *    - review/update runs (binding.stage design-review / plan): the
 *      design-review domain transitions to `paused` with
 *      `pauseReason: "executor-failed"` — the loop stops and waits for an
 *      explicit owner recovery, never an automatic re-dispatch;
 *    - develop runs (develop-handoff): `flowState` becomes `blocked` with
 *      `blockedReason: "executor_failed"` while the run stays at
 *      `recovery: "awaiting-owner"` (set by run-state.applyTerminalStatus).
 *
 *    The park decision is driven by ACTUAL terminal/manager evidence:
 *    `probeAgentSessionEvidence` + `toExecutorTerminalStatus` classify the
 *    registry record. A registry that still shows the agent LIVE contradicts
 *    the lifecycle event — nothing is parked, nothing is re-dispatched
 *    (C3: unknown/live never redispatch). A registry status of
 *    aborted/stopped refines the persisted terminal to `aborted`.
 *
 * 2. `invalidateExecutorRunOnBoundary` — plan Phase 3 task 7: pipeline-start,
 *    pipeline-quit and choose-stage must invalidate a stale executor binding.
 *    A CLEAR is a protected-field mutation: it goes through the exclusive
 *    strict commit anchored on the CURRENT run (mirroring the established
 *    `invalidateDesignReviewAuthorization` pattern), never a plain patch
 *    (which `stageExecutorRunPatchViolation` rejects zero-effect anyway).
 *    Legacy adapters without the strict interface keep the plain write.
 *
 * Every failure mode is fail-closed with an audit record: a park or an
 * invalidation that cannot be committed is reported honestly and NEVER
 * re-attempted by silently re-dispatching the executor.
 */

import type { PipelineConfig, ReliableMetaCommitResult, SessionMeta } from "../../types";
import {
  expectedFromCurrent,
  strictCommitMeta,
  type MetaCommitExpectation,
} from "../session-state";
import { getFlowState } from "../flow-state";
import { transitionPhase } from "../design-review/state";
import { safeWriteAuditLog } from "../../utils/auditLog";
import {
  probeAgentSessionEvidence,
  toExecutorTerminalStatus,
  type AgentSessionEvidence,
} from "../../utils/subagents-introspect";
import { executorExpectationFromCurrent } from "./commit-guard";
import { sameBinding } from "./run-state";
import type { StageExecutorRun, StageExecutorStatus } from "./contracts";

/** Strict-commit-capable session adapter (same bounded shape as terminal.ts). */
export interface ExecutorRecoverySession {
  getMeta(): SessionMeta | undefined;
  updateMeta(patch: Partial<SessionMeta>): SessionMeta | undefined;
  updateMetaVerified?(
    patch: Partial<SessionMeta>,
    expected: import("../session-state").MetaCommitExpectation,
  ): ReliableMetaCommitResult;
}

/** Classification of a manager-registry probe against a failed terminal. */
export type FailureDisposition =
  /** Registry still proves the agent live: the terminal is contradicted. */
  | "deferred_live"
  /** Registry proves aborted/stopped: refine the persisted terminal. */
  | { refined: "failed" | "aborted" }
  /** No usable terminal registry evidence: keep the event-derived status. */
  | "as_reported";

/**
 * Map one registry evidence probe onto the failure disposition.
 *
 * Pure and exported for tests: `toExecutorTerminalStatus` is the bounded
 * registry-status mapping (running/completed/failed/aborted/unknown) — an
 * ambiguous id is never identity and never refines anything.
 */
export function resolveFailureDisposition(
  evidence: AgentSessionEvidence | undefined,
): FailureDisposition {
  if (!evidence || evidence.ambiguous) return "as_reported";
  const mapped = toExecutorTerminalStatus(evidence.recordStatus);
  // A live registry record contradicts a "failed" lifecycle event: park
  // NOTHING while the agent may still be executing (C3: unknown/live never
  // redispatch and never auto-park).
  if (evidence.status === "live" || mapped === "running") return "deferred_live";
  if (mapped === "failed" || mapped === "aborted") return { refined: mapped };
  // completed / unknown / missing registry evidence: the trusted lifecycle
  // terminal stays authoritative (absence of a record is not proof of life).
  return "as_reported";
}

/** Outcome of one failure-parking attempt. */
export type FailureParkOutcome =
  /** The run is not in a failed/aborted terminal: nothing to park. */
  | { action: "not_failure" }
  /** The meta no longer carries this run (superseded): zero side effects. */
  | { action: "run_superseded" }
  /** Registry still proves the executor live: no park, no redispatch. */
  | { action: "deferred_live"; agentId: string; recordStatus: string | undefined }
  /** Terminal parked: design-review paused (executor-failed) or blocked. */
  | {
      action: "parked";
      kind: "paused" | "blocked";
      status: StageExecutorStatus;
      refined: boolean;
      budgetExhausted: boolean;
    }
  /** The pipeline is already parked in the same posture: idempotent skip. */
  | { action: "already_parked"; kind: "paused" | "blocked" }
  /** Parking is out of scope for this state (finished / identity drift). */
  | { action: "out_of_scope"; reason: string }
  /** The park commit conflicted or was unavailable: fail closed, audited. */
  | { action: "commit_failed"; reason: string };

/**
 * 194 D4/Phase 3 task 5: park a trusted failed/aborted executor terminal.
 *
 * Called by the coordinator immediately after `applyExecutorTerminal`
 * returned `applied` for a failure — the run record is already persisted
 * (`recovery: awaiting-owner | budget-exhausted`, failures counted). This
 * function only adds the STAGE-level stop mandated by D4; it never wakes,
 * never advances, never re-dispatches.
 */
export async function parkExecutorFailure(deps: {
  session: ExecutorRecoverySession;
  config: PipelineConfig;
  /** The applied terminal run (status failed/aborted). */
  run: StageExecutorRun;
  /** DI: registry evidence probe (defaults to the production probe). */
  probe?: (agentId: string) => AgentSessionEvidence;
}): Promise<FailureParkOutcome> {
  const { session, run } = deps;
  try {
    if (run.status !== "failed" && run.status !== "aborted") {
      return { action: "not_failure" };
    }
    const meta = session.getMeta();
    const current = meta?.stageExecutorRun;
    // Fresh identity: only the CURRENT run may be parked — a superseded
    // run's terminal never stops a newer attempt's pipeline state.
    if (!meta || !current || !sameBinding(current.binding, run.binding)) {
      return { action: "run_superseded" };
    }

    const probe = deps.probe ?? probeAgentSessionEvidence;
    let evidence: AgentSessionEvidence | undefined;
    try {
      evidence = probe(current.binding.agentId);
    } catch {
      // A probe failure is ABSENT evidence, never proof of anything:
      // keep the trusted event status and continue with the park.
      evidence = undefined;
    }
    const disposition = resolveFailureDisposition(evidence);
    if (disposition === "deferred_live") {
      await safeWriteAuditLog("executor_recovery", {
        action: "deferred_live",
        runId: current.binding.runId,
        stage: current.binding.stage,
        agentId: current.binding.agentId,
        recordStatus: evidence?.recordStatus ?? "unknown",
        reason: "registry_live_contradicts_terminal_event",
      }, "warn");
      return {
        action: "deferred_live",
        agentId: current.binding.agentId,
        recordStatus: evidence?.recordStatus,
      };
    }

    const status: StageExecutorStatus =
      disposition === "as_reported" ? current.status : disposition.refined;
    const refined = status !== current.status;
    const budgetExhausted = current.recovery === "budget-exhausted";

    if (current.binding.stage === "develop") {
      return await parkDevelopFailure({
        session,
        meta,
        current,
        status,
        refined,
        budgetExhausted,
      });
    }
    return await parkReviewUpdateFailure({
      session,
      meta,
      current,
      status,
      refined,
      budgetExhausted,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await safeWriteAuditLog("executor_recovery", {
      action: "park_error",
      runId: run.binding.runId,
      stage: run.binding.stage,
      error: errMsg,
    }, "error");
    return { action: "commit_failed", reason: `exception:${errMsg}` };
  }
}

/** develop-handoff failure: flowState=blocked, run stays awaiting-owner. */
async function parkDevelopFailure(args: {
  session: ExecutorRecoverySession;
  meta: SessionMeta;
  current: StageExecutorRun;
  status: StageExecutorStatus;
  refined: boolean;
  budgetExhausted: boolean;
}): Promise<FailureParkOutcome> {
  const { session, meta, current, status, refined, budgetExhausted } = args;
  const flow = getFlowState(meta);
  if (flow !== "running") {
    // Already blocked/aborted: the stop is on record — idempotent skip.
    return { action: "already_parked", kind: "blocked" };
  }
  const res = strictCommitMeta(
    session,
    {
      // Persist the registry-proven terminal refinement together with the
      // stop: one atomic strict commit, anchored on the CURRENT run.
      ...(refined ? { stageExecutorRun: { ...current, status } } : {}),
      flowState: "blocked",
      blockedReason: "executor_failed",
    },
    {
      pipelineId: meta.pipelineId ?? "unknown",
      ...executorExpectationFromCurrent(meta),
    } satisfies MetaCommitExpectation,
  );
  if (res.status !== "persisted") {
    await safeWriteAuditLog("executor_recovery", {
      action: "park_blocked_failed",
      runId: current.binding.runId,
      commit: res.status,
      reason: "reason" in res ? res.reason : "unknown",
    }, "error");
    return {
      action: "commit_failed",
      reason: `${res.status}:${"reason" in res ? res.reason : "unknown"}`,
    };
  }
  await safeWriteAuditLog("executor_recovery", {
    action: "parked_blocked",
    runId: current.binding.runId,
    stage: current.binding.stage,
    status,
    refined: String(refined),
    budgetExhausted: String(budgetExhausted),
    consecutiveFailures: String(current.consecutiveFailures),
    recovery: budgetExhausted ? "budget-exhausted" : "awaiting-owner",
  }, "warn");
  return { action: "parked", kind: "blocked", status, refined, budgetExhausted };
}

/**
 * review/update failure: design-review pauses with pauseReason
 * "executor-failed". The pause NEVER reopens `finished` and never overwrites
 * an existing pause (an in-flight human decision keeps precedence).
 */
async function parkReviewUpdateFailure(args: {
  session: ExecutorRecoverySession;
  meta: SessionMeta;
  current: StageExecutorRun;
  status: StageExecutorStatus;
  refined: boolean;
  budgetExhausted: boolean;
}): Promise<FailureParkOutcome> {
  const { session, meta, current, status, refined, budgetExhausted } = args;
  const dr = meta.designReview;
  if (!dr) {
    await safeWriteAuditLog("executor_recovery", {
      action: "park_skipped",
      runId: current.binding.runId,
      stage: current.binding.stage,
      reason: "no_design_review_state",
    }, "warn");
    return { action: "out_of_scope", reason: "no_design_review_state" };
  }
  // Identity: the pause may only touch the domain this run belongs to.
  if (dr.operation?.operationId !== current.binding.operationId) {
    await safeWriteAuditLog("executor_recovery", {
      action: "park_skipped",
      runId: current.binding.runId,
      operationId: current.binding.operationId,
      domainOperationId: dr.operation?.operationId ?? "none",
      reason: "operation_identity_mismatch",
    }, "warn");
    return { action: "out_of_scope", reason: "operation_identity_mismatch" };
  }
  if (dr.phase === "paused") {
    return { action: "already_parked", kind: "paused" };
  }
  if (dr.phase === "finished") {
    // A terminal of a superseded round never reopens a finished loop; the
    // develop/plan path above and the owner resume commands govern recovery.
    return { action: "out_of_scope", reason: "phase_finished" };
  }

  const pausedState = transitionPhase(dr, "paused", undefined, "executor-failed");
  const res = strictCommitMeta(
    session,
    {
      ...(refined ? { stageExecutorRun: { ...current, status } } : {}),
      designReview: pausedState,
    },
    expectedFromCurrent(meta),
  );
  if (res.status !== "persisted") {
    await safeWriteAuditLog("executor_recovery", {
      action: "park_paused_failed",
      runId: current.binding.runId,
      stage: current.binding.stage,
      commit: res.status,
      reason: "reason" in res ? res.reason : "unknown",
    }, "error");
    return {
      action: "commit_failed",
      reason: `${res.status}:${"reason" in res ? res.reason : "unknown"}`,
    };
  }
  await safeWriteAuditLog("executor_recovery", {
    action: "parked_paused",
    runId: current.binding.runId,
    stage: current.binding.stage,
    pauseReason: "executor-failed",
    status,
    refined: String(refined),
    budgetExhausted: String(budgetExhausted),
    consecutiveFailures: String(current.consecutiveFailures),
    round: String(dr.round),
  }, "warn");
  return { action: "parked", kind: "paused", status, refined, budgetExhausted };
}

/** Result of one boundary invalidation attempt. */
export interface InvalidateExecutorRunResult {
  /** True when the boundary may proceed (cleared or nothing to clear). */
  ok: boolean;
  /** True when a run record was actually removed. */
  cleared: boolean;
  reason?: string;
}

/**
 * 194 Phase 3 task 7: invalidate the stale executor binding at a pipeline
 * boundary (pipeline-start / pipeline-quit / choose-stage).
 *
 * Mirrors the established authorization-clear pattern
 * (`invalidateDesignReviewAuthorization`): one exclusive strict commit
 * anchored on the CURRENT run ("unchanged since read"), a single fresh
 * retry on conflict, the legacy plain write only for adapters WITHOUT the
 * strict interface, and an honest fail-closed audit when neither works.
 */
export async function invalidateExecutorRunOnBoundary(deps: {
  session: ExecutorRecoverySession;
  /** Boundary label for attribution (e.g. "user_quit"). */
  reason: string;
}): Promise<InvalidateExecutorRunResult> {
  const { session, reason } = deps;
  try {
    const meta = session.getMeta();
    if (!meta) return { ok: true, cleared: false, reason: "no_meta" };
    const run = meta.stageExecutorRun;
    if (!run) return { ok: true, cleared: false, reason: "no_run" };

    const attemptClear = (base: SessionMeta): InvalidateExecutorRunResult | "retry" => {
      const res = strictCommitMeta(
        session,
        { stageExecutorRun: undefined },
        expectedFromCurrent(base),
      );
      if (res.status === "persisted") {
        return { ok: true, cleared: true };
      }
      if (res.status === "conflict") return "retry";
      if ("reason" in res && res.reason === "adapter_lacks_strict_interface") {
        // Legacy adapter (no strict interface): the plain write is the
        // established fallback — production adapters never reach here.
        const merged = session.updateMeta({ stageExecutorRun: undefined });
        if (!merged) return { ok: false, cleared: false, reason: "legacy_plain_clear_rejected" };
        return { ok: true, cleared: true, reason: "legacy_plain_clear" };
      }
      return { ok: false, cleared: false, reason: `unavailable:${"reason" in res ? res.reason : "unknown"}` };
    };

    const first = attemptClear(meta);
    const outcome = first === "retry"
      ? (() => {
        const fresh = session.getMeta();
        if (!fresh?.stageExecutorRun) return { ok: true, cleared: false, reason: "already_cleared" };
        const second = attemptClear(fresh);
        if (second !== "retry") return second;
        return { ok: false, cleared: false, reason: "commit_conflict" };
      })()
      : first;

    if (!outcome.ok) {
      await safeWriteAuditLog("executor_run_invalidate", {
        action: "invalidate_failed",
        runId: run.binding.runId,
        stage: run.binding.stage,
        boundary: reason,
        detail: outcome.reason ?? "unknown",
      }, "error");
    } else {
      await safeWriteAuditLog("executor_run_invalidate", {
        action: "invalidated",
        runId: run.binding.runId,
        stage: run.binding.stage,
        boundary: reason,
        via: outcome.reason ?? "strict",
      });
    }
    return outcome;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await safeWriteAuditLog("executor_run_invalidate", {
      action: "invalidate_error",
      boundary: reason,
      error: errMsg,
    }, "error");
    return { ok: false, cleared: false, reason: `exception:${errMsg}` };
  }
}
