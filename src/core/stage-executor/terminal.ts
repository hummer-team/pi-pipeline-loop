/**
 * @module stage-executor/terminal
 * 194 Phase 3 (C3, task 2): trusted terminal handling for closed-loop stage
 * executor runs, wired into the RPC lifecycle.
 *
 * Processing order enforced here (plan Phase 3 task 2):
 *   fresh identity check  →  reliable terminal save  →  conditional
 *   activeSpawns cleanup; every awaited step catches its own exceptions and
 *   writes an ERROR audit record (no silent swallow).
 *
 * Routing rule (plan Phase 3 task 2):
 * - a `develop-handoff` terminal maintains `SessionMeta.stageExecutorRun`
 *   ONLY — a real terminal never rewrites the handoff receipt (C3: once the
 *   receipt is finished+trusted-completed, a later "failed" event must not
 *   corrupt it; recovery is the explicit path instead);
 * - `review` / `update` terminals keep their operation writeback (the 192
 *   path stays authoritative there, invoked by the coordinator caller); this
 *   module adds run bookkeeping when a run exists.
 *
 * Duplicate/late events cause ZERO side effects: no failure counting, no
 * advance, no clearing of a NEWER spawn record. Duplicates of the same
 * result are recorded as `duplicate_ignored` (run-state dedup owns the rule;
 * a run already in a terminal status is also a duplicate by identity).
 */

import { randomUUID } from "node:crypto";
import type {
  DesignReviewOperationKind,
  DesignReviewState,
  PipelineConfig,
  SessionMeta,
  SpawnOperationContext,
} from "../../types";
import type { ReliableMetaCommitResult } from "../../types";
import { strictCommitMeta } from "../session-state";
import { executorExpectationFromCurrent } from "./commit-guard";
import { clearActiveSpawnRecord } from "../../utils/spawn-cleanup";
import { safeWriteAuditLog } from "../../utils/auditLog";
import {
  applyTerminalStatus,
  computeResultKey,
  sameBinding,
} from "./run-state";
import { withRuntimeSessionFileEvidence } from "./runtime-binding";
import type {
  StageExecutorBinding,
  StageExecutorRun,
  StageExecutorStage,
  StageExecutorStatus,
} from "./contracts";

/** Strict-commit-capable session adapter (same bounded shape as coordinator). */
export interface ExecutorTerminalSession {
  getMeta(): SessionMeta | undefined;
  updateMeta(patch: Partial<SessionMeta>): SessionMeta | undefined;
  updateMetaVerified?(
    patch: Partial<SessionMeta>,
    expected: import("../session-state").MetaCommitExpectation,
  ): ReliableMetaCommitResult;
}

/** Trusted-dispatch identity for run creation (C3: reply-carried evidence only). */
export interface RunDispatchIdentity {
  /** Owner (parent) session file proven by the entry point's runtime evidence */
  ownerSessionFile: string;
  /** FULL agent id exactly as returned by the trusted RPC reply */
  agentId: string;
  /** Operation context the spawn was dispatched under (carries runId when 194) */
  operationContext: SpawnOperationContext;
}

/** Outcome of maintaining one executor run at trusted dispatch. */
export type IssueRunResult =
  | { ok: true; run: StageExecutorRun; duplicate: boolean }
  | { ok: false; reason: string };

/** Classification of one terminal event against the CURRENT run. */
export type TerminalAction =
  /** No closed-loop run tracked at all — the legacy operation path governs. */
  | { action: "no_run" }
  /** Event belongs to a superseded identity: zero side effects. */
  | { action: "late_ignored"; reason: string }
  /** Same terminal already applied: zero side effects (no recount/clear). */
  | { action: "duplicate_ignored" }
  /** Terminal persisted; spawn entry conditionally cleaned. */
  | { action: "applied"; run: StageExecutorRun; budgetExhausted: boolean }
  /** Persist refused (conflict/unavailable): NO cleanup, NO wake. */
  | { action: "commit_failed"; reason: string };

/** The stage a run for this operation kind executes under (C3 closed-loop subset). */
export function deriveExecutorStage(kind: DesignReviewOperationKind): StageExecutorStage | null {
  switch (kind) {
    case "review": return "design-review";
    case "update": return "plan";
    case "develop-handoff": return "develop";
    default: return null;
  }
}

/** Map one RPC lifecycle event onto the bounded executor status vocabulary. */
export function toRunTerminalStatus(event: "completed" | "failed"): StageExecutorStatus {
  return event === "completed" ? "completed" : "failed";
}

/**
 * True when the CURRENT design-review state already carries the finished
 * handoff receipt (phase finished + develop-handoff operation proven
 * completed with trusted-id evidence). A real terminal arriving afterwards
 * must NOT rewrite that receipt — it only maintains the run (C3).
 */
export function isHandoffReceiptFinal(state: DesignReviewState | undefined): boolean {
  if (!state || state.phase !== "finished") return false;
  const op = state.operation;
  return !!op
    && op.kind === "develop-handoff"
    && op.dispatchState === "completed"
    && op.dispatchEvidence === "trusted_id";
}

/** Default consecutive-failure budget (plan Phase 3 rule 6: 3, no 4th). */
function budgetLimitOf(config: PipelineConfig): number {
  return config.maxLoopCycles ?? 3;
}

/**
 * 194 C3: create (or atomically supersede) the latest run after a trusted
 * RPC reply proved a full agent id. Intent/prepared state never reaches here.
 *
 * - binding identity = runId (from the dispatch operation context when the
 *   dispatcher pre-issued one, else freshly issued) + full agentId + the
 *   owner session file + registry-proven executor session file when the
 *   registry can supply one;
 * - a re-dispatch for the SAME stage visit + operation inherits the previous
 *   run's failure count (same result counted once; the budget accumulates
 *   across attempts, never per fresh run);
 * - `budget-exhausted` under the same identity blocks creating a further run
 *   (no 4th same-visit attempt);
 * - the write goes through the STRICT commit anchored on the current run, so
 *   a concurrent consumer of the same run can only succeed on one side.
 */
export async function issueExecutorRunOnDispatch(
  deps: {
    session: ExecutorTerminalSession;
    config: PipelineConfig;
    identity: RunDispatchIdentity;
    /** Id issuer DI (tests); defaults to crypto.randomUUID */
    issueRunId?: () => string;
  },
): Promise<IssueRunResult> {
  const { session, identity } = deps;
  const oc = identity.operationContext;
  try {
    const meta = session.getMeta();
    if (!meta) return { ok: false, reason: "meta_absent" };
    if (meta.pipelineId !== undefined && meta.pipelineId !== oc.pipelineId) {
      return { ok: false, reason: "pipeline_mismatch" };
    }
    const stage = deriveExecutorStage(oc.kind);
    if (stage === null) return { ok: false, reason: `kind_out_of_scope:${oc.kind}` };

    const prior = meta.stageExecutorRun;
    if (prior) {
      // Idempotent echo: the SAME trusted identity re-reported (e.g. a second
      // receipt of the same reply) never re-creates or bumps anything. The
      // echo only holds while the operation's run id AGREES with the entry
      // (or was never issued): a dispatch carrying a different run id is a
      // new attempt, so it must fall through to the same-visit budget rules.
      if (
        sameBinding(prior.binding, {
          runId: oc.runId ?? prior.binding.runId,
          pipelineId: oc.pipelineId,
          ownerSessionFile: identity.ownerSessionFile,
          stage,
          stageVisitId: oc.stageVisitId,
          operationId: oc.operationId,
          agentId: identity.agentId,
        })
      ) {
        return { ok: true, run: prior, duplicate: true };
      }
      // Same-visit attempt: the failure budget must carry over, and an
      // exhausted budget refuses any further run (plan Phase 3 rule 6).
      const sameVisit =
        prior.binding.pipelineId === oc.pipelineId
        && prior.binding.stage === stage
        && prior.binding.operationId === oc.operationId
        && prior.binding.stageVisitId === oc.stageVisitId;
      if (sameVisit && prior.recovery === "budget-exhausted") {
        return { ok: false, reason: "budget_exhausted_same_visit" };
      }
    }

    const runId = oc.runId ?? deps.issueRunId?.() ?? randomUUID();
    const baseBinding: StageExecutorBinding = {
      runId,
      pipelineId: oc.pipelineId,
      ownerSessionFile: identity.ownerSessionFile,
      stage,
      stageVisitId: oc.stageVisitId,
      operationId: oc.operationId,
      agentId: identity.agentId,
    };
    // Registry evidence enriches — it never fabricates — the session file.
    const binding = withRuntimeSessionFileEvidence(baseBinding);
    const run: StageExecutorRun = {
      binding,
      status: "running",
      recovery: "none",
      // Carry the budget across same-visit attempts; a different visit/
      // operation starts its own count.
      consecutiveFailures:
        prior
        && prior.binding.pipelineId === oc.pipelineId
        && prior.binding.stage === stage
        && prior.binding.operationId === oc.operationId
        && prior.binding.stageVisitId === oc.stageVisitId
          ? prior.consecutiveFailures
          : 0,
      terminalConsumed: false,
    };

    const res = strictCommitMeta(
      session,
      { stageExecutorRun: run },
      {
        pipelineId: meta.pipelineId ?? "unknown",
        ...executorExpectationFromCurrent(meta),
      },
    );
    if (res.status !== "persisted") {
      void safeWriteAuditLog("executor_run_issue", {
        action: "run_issue_failed",
        runId,
        operationId: oc.operationId,
        stage,
        status: res.status,
        reason: "reason" in res ? res.reason : "unknown",
      }, "error");
      return { ok: false, reason: `${res.status}:${"reason" in res ? res.reason : "unknown"}` };
    }
    void safeWriteAuditLog("executor_run_issue", {
      action: "run_issued",
      runId,
      pipelineId: oc.pipelineId,
      stage,
      stageVisitId: String(oc.stageVisitId),
      operationId: oc.operationId,
      agentId: identity.agentId,
      inheritedFailures: String(run.consecutiveFailures),
    });
    return { ok: true, run, duplicate: false };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    void safeWriteAuditLog("executor_run_issue", {
      action: "run_issue_error",
      operationId: oc.operationId,
      error: errMsg,
    }, "error");
    return { ok: false, reason: `exception:${errMsg}` };
  }
}

/**
 * 194 C3/task 2: maintain the CURRENT run at a trusted RPC terminal event.
 *
 * Fresh identity check first: the event's full agent id AND operation
 * identity must match the run's binding; anything else is a late event of a
 * superseded run — zero side effects (no count, no advance, no clearing of a
 * newer spawn). Duplicate terminals of an already-finished run never count
 * the budget twice (run-state's resultKey dedup + terminal-status guard).
 *
 * On a persisted transition the activeSpawns entry is cleaned ONLY when it
 * provably belongs to this run (agentId + operationId expectation shared
 * with spawn-cleanup); a spawn record of a newer attempt stays untouched.
 *
 * The caller (coordinator) decides operation writeback vs. handoff-receipt
 * protection and issues the owner wake; this module performs no dispatch,
 * no advance and no consumption claims.
 */
export async function applyExecutorTerminal(
  deps: {
    session: ExecutorTerminalSession;
    config: PipelineConfig;
    evt: {
      event: "completed" | "failed";
      agentId?: string;
      operationContext: SpawnOperationContext;
    };
  },
): Promise<TerminalAction> {
  const { session, config } = deps;
  const oc = deps.evt.operationContext;
  try {
    const meta = session.getMeta();
    const run = meta?.stageExecutorRun;
    if (!meta || !run) return { action: "no_run" };

    // ── fresh identity check (C3 closure: runId/full agent/pipeline/stage/visit/operation)
    const stage = deriveExecutorStage(oc.kind);
    if (
      stage === null
      || run.binding.stage !== stage
      || run.binding.pipelineId !== oc.pipelineId
      || run.binding.operationId !== oc.operationId
      || run.binding.stageVisitId !== oc.stageVisitId
      || (deps.evt.agentId !== undefined && deps.evt.agentId !== run.binding.agentId)
      // A pre-194 spawn context carries no runId: when one exists on both
      // sides it must match — a superseded run's listener never touches the
      // current record. Absence on either side falls back to the remaining
      // (full) identity checks above.
      || (oc.runId !== undefined && run.binding.runId !== oc.runId)
    ) {
      void safeWriteAuditLog("executor_terminal", {
        action: "late_event_ignored",
        eventOperationId: oc.operationId,
        eventAgentId: deps.evt.agentId ?? "unknown",
        currentRunId: run.binding.runId,
        currentOperationId: run.binding.operationId,
        event: deps.evt.event,
      }, "warn");
      return { action: "late_ignored", reason: "terminal_identity_mismatch" };
    }

    // A run already in a terminal status is a duplicate by identity — never
    // recount, never rewrite, never clear anything.
    if (run.status !== "running" && run.status !== "unknown") {
      void safeWriteAuditLog("executor_terminal", {
        action: "duplicate_ignored",
        runId: run.binding.runId,
        status: run.status,
        event: deps.evt.event,
        reason: "run_already_terminal",
      });
      return { action: "duplicate_ignored" };
    }

    const status = toRunTerminalStatus(deps.evt.event);
    const resultKey = computeResultKey({
      runId: run.binding.runId,
      declarationRevision: run.declaration?.revision,
      inputFingerprints: [oc.operationId, deps.evt.event],
    });
    // After a trusted terminal the owner consumption posture is "awaiting":
    // a stored declaration routes to the owner tool, otherwise the child
    // declaration is still missing. Part 3's tool-consumption refines this.
    const consumptionState = run.declaration
      ? ("awaiting-owner-tool" as const)
      : ("awaiting-declaration" as const);
    const applied = applyTerminalStatus(
      run,
      status,
      resultKey,
      budgetLimitOf(config),
      consumptionState,
    );
    if (applied.duplicateIgnored) {
      void safeWriteAuditLog("executor_terminal", {
        action: "duplicate_ignored",
        runId: run.binding.runId,
        status,
        event: deps.evt.event,
        reason: "same_result_key",
      });
      return { action: "duplicate_ignored" };
    }

    const res = strictCommitMeta(
      session,
      { stageExecutorRun: applied.run },
      {
        pipelineId: meta.pipelineId ?? "unknown",
        ...executorExpectationFromCurrent(meta),
      },
    );
    if (res.status !== "persisted") {
      void safeWriteAuditLog("executor_terminal", {
        action: "terminal_commit_failed",
        runId: run.binding.runId,
        status,
        commit: res.status,
        reason: "reason" in res ? res.reason : "unknown",
      }, "error");
      return {
        action: "commit_failed",
        reason: `${res.status}:${"reason" in res ? res.reason : "unknown"}`,
      };
    }

    // Reliable save first, THEN the conditional cleanup — a conflict keeps
    // the spawn entry (its own listener/recovery will handle it).
    clearActiveSpawnRecord(session, run.binding.stage, {
      agentId: run.binding.agentId,
      operationId: run.binding.operationId,
    });

    // The terminal is COMMITTED and the spawn record cleaned: the audit
    // line is diagnostic only — throwing here would misreport an applied
    // terminal as commit_failed and invite a duplicate consumer.
    void safeWriteAuditLog("executor_terminal", {
      action: "terminal_applied",
      runId: run.binding.runId,
      stage: run.binding.stage,
      status,
      consecutiveFailures: String(applied.run.consecutiveFailures),
      budgetExhausted: String(applied.budgetExhausted),
      event: deps.evt.event,
    });
    return { action: "applied", run: applied.run, budgetExhausted: applied.budgetExhausted };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    void safeWriteAuditLog("executor_terminal", {
      action: "terminal_error",
      operationId: oc.operationId,
      error: errMsg,
    }, "error");
    return { action: "commit_failed", reason: `exception:${errMsg}` };
  }
}
