/**
 * 194 Phase 3 (task 5 + task 7, review round-1 issues 1/3/5): trusted failure
 * recovery for closed-loop stage executor runs.
 *
 * Pins the three behaviours mandated by plan D4/C3 and the review fixes:
 *
 * 1. `parkExecutorFailure` — a trusted failed/aborted terminal STOPS the
 *    pipeline honestly: review/update runs pause with
 *    `pauseReason: "executor-failed"`, develop runs become `flowState=blocked`
 *    with `blockedReason: "executor_failed"` and the run stays at
 *    `recovery: awaiting-owner`. Registry evidence drives the disposition: a
 *    still-LIVE executor is never parked (and never re-dispatched); an
 *    aborted/stopped record refines the persisted terminal in the SAME
 *    atomic strict commit. Third consecutive failure (budget-exhausted)
 *    parks with no fourth attempt.
 *
 * 2. `resolveFailureDisposition` — the bounded live/refined/as-reported
 *    classification of registry evidence (ambiguous ids never identity).
 *
 * 3. `invalidateExecutorRunOnBoundary` + its wiring at pipeline-start /
 *    pipeline-quit / choose-stage (review issue 3): stale executor bindings
 *    never survive a boundary — one exclusive strict commit anchored on the
 *    CURRENT run, a fresh retry on conflict, the legacy plain write only for
 *    adapters without the strict interface, and honest fail-closed audit.
 *    The resume path (same pipelineId) intentionally KEEPS the binding for
 *    D4 breakpoint recovery.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  parkExecutorFailure,
  invalidateExecutorRunOnBoundary,
  resolveFailureDisposition,
  type ExecutorRecoverySession,
} from "../../core/stage-executor/recovery";
import { applyTerminalStatus } from "../../core/stage-executor/run-state";
import { executeDecision } from "../../core/flow-state";
import { createPipelineQuitCommand } from "../../commands/pipeline-quit";
import { createPipelineStartCommand } from "../../commands/pipeline-start";
import * as subagentRpc from "../../utils/subagent-rpc";
import * as auditLog from "../../utils/auditLog";
import { __resetSubagentsReady } from "../../utils/subagent-availability";
import { makeStrictSession, makeMockSessionManager, makeTestConfig } from "../helpers";
import type { AgentSessionEvidence } from "../../utils/subagents-introspect";
import type {
  DesignReviewState,
  PipelineConfig,
  ReliableMetaCommitResult,
  SessionMeta,
  StageExecutorBinding,
  StageExecutorRun,
} from "../../types";

const OWNER_FILE = "/sessions/owner.jsonl";
const VISIT = 1_700_000_000_000;

// ─── fixtures ───────────────────────────────────────────────────────────────

function makeBinding(overrides?: Partial<StageExecutorBinding>): StageExecutorBinding {
  return {
    runId: "run-1",
    pipelineId: "pipe-rec-1",
    ownerSessionFile: OWNER_FILE,
    stage: "develop",
    stageVisitId: VISIT,
    operationId: "op-1",
    agentId: "01a11bbb-c3b4-72bc-9397-4f5b9881be41",
    ...overrides,
  };
}

function makeRun(overrides?: Partial<StageExecutorRun>): StageExecutorRun {
  return {
    binding: makeBinding(),
    status: "failed",
    recovery: "awaiting-owner",
    consecutiveFailures: 1,
    terminalConsumed: false,
    ...overrides,
  };
}

function makeMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return {
    currentStage: "develop",
    previousStage: "plan",
    stageStartTime: VISIT,
    pipelineId: "pipe-rec-1",
    domain: { id: "general", version: "latest", skillPath: "/tmp/domain.md" },
    summaries: {},
    loopCount: 0,
    currentStepIndex: 0,
    maxLoops: 3,
    flowState: "running",
    stageExecutorRun: makeRun(),
    ...overrides,
  };
}

function drState(overrides?: Partial<DesignReviewState>): DesignReviewState {
  return {
    schemaVersion: 1,
    planDoc: "/docs/design/plan.md",
    authorizationId: "auth-1",
    authorizationSource: "menu",
    round: 1,
    phase: "review_running",
    operation: {
      operationId: "op-1",
      kind: "review",
      stageVisitId: VISIT,
      attempt: 1,
      dispatchState: "dispatched",
      createdAt: VISIT,
      updatedAt: VISIT,
    },
    updatedAt: VISIT,
    ...overrides,
  } as DesignReviewState;
}

/** Live registry evidence: the agent is still executing. */
function liveEvidence(): AgentSessionEvidence {
  return {
    agentId: "01a11bbb-c3b4-72bc-9397-4f5b9881be41",
    found: true,
    status: "live",
    recordStatus: "running",
    sessionFile: "/sessions/child.jsonl",
    ambiguous: false,
  };
}

/** Settled registry evidence with a raw status (refinement candidate). */
function settledEvidence(recordStatus: string): AgentSessionEvidence {
  return {
    agentId: "01a11bbb-c3b4-72bc-9397-4f5b9881be41",
    found: true,
    status: "settled",
    recordStatus,
    sessionFile: "/sessions/child.jsonl",
    ambiguous: false,
  };
}

/** Session with a strict interface that ALWAYS conflicts. */
function makeConflictSession(initial: SessionMeta) {
  let meta: SessionMeta = { ...initial };
  return {
    getMeta: () => meta,
    updateMeta: (patch: Partial<SessionMeta>) => {
      meta = { ...meta, ...patch };
      return meta;
    },
    updateMetaVerified: (): ReliableMetaCommitResult => ({
      status: "conflict",
      reason: "lock_busy",
    }),
  };
}

// ═══ 1. resolveFailureDisposition — bounded registry classification ════════

describe("194 recovery: resolveFailureDisposition maps registry evidence honestly", () => {
  test("absent evidence → as_reported (no registry view never contradicts anything)", () => {
    expect(resolveFailureDisposition(undefined)).toBe("as_reported");
  });

  test("ambiguous id → as_reported: enumeration drift is never identity", () => {
    const evidence: AgentSessionEvidence = {
      agentId: "dup",
      found: true,
      status: "unknown",
      ambiguous: true,
    };
    expect(resolveFailureDisposition(evidence)).toBe("as_reported");
  });

  test("live registry → deferred_live (a terminal event never parks a running agent)", () => {
    expect(resolveFailureDisposition(liveEvidence())).toBe("deferred_live");
  });

  test("registry status 'aborted'/'stopped' → refined aborted", () => {
    expect(resolveFailureDisposition(settledEvidence("aborted"))).toEqual({ refined: "aborted" });
    expect(resolveFailureDisposition(settledEvidence("stopped"))).toEqual({ refined: "aborted" });
  });

  test("registry status 'error' → refined failed", () => {
    expect(resolveFailureDisposition(settledEvidence("error"))).toEqual({ refined: "failed" });
  });

  test("registry 'completed' or unknown status → as_reported (no invented terminal)", () => {
    expect(resolveFailureDisposition(settledEvidence("completed"))).toBe("as_reported");
    expect(resolveFailureDisposition(settledEvidence("weird-status"))).toBe("as_reported");
  });
});

// ═══ 2. parkExecutorFailure — D4 parking of trusted failures ═══════════════

describe("194 recovery: parkExecutorFailure parks trusted failed/aborted terminals", () => {
  let config: PipelineConfig;

  beforeEach(() => {
    config = makeTestConfig();
    jest.spyOn(auditLog, "safeWriteAuditLog").mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("completed terminal → not_failure, zero side effects", async () => {
    const session = makeStrictSession(makeMeta({ stageExecutorRun: makeRun({ status: "completed" }) }));
    const outcome = await parkExecutorFailure({
      session: session as unknown as ExecutorRecoverySession,
      config,
      run: makeRun({ status: "completed", recovery: "none" }),
      probe: () => settledEvidence("completed"),
    });
    expect(outcome.action).toBe("not_failure");
    expect(session.getMeta().flowState).toBe("running");
  });

  test("terminal of a SUPERSEDED run never parks the newer attempt", async () => {
    const session = makeStrictSession(
      makeMeta({ stageExecutorRun: makeRun({ binding: makeBinding({ runId: "run-2" }) }) }),
    );
    const outcome = await parkExecutorFailure({
      session: session as unknown as ExecutorRecoverySession,
      config,
      run: makeRun(), // run-1 no longer the persisted one
      probe: () => settledEvidence("error"),
    });
    expect(outcome.action).toBe("run_superseded");
    expect(session.getMeta().stageExecutorRun?.binding.runId).toBe("run-2");
  });

  test("registry still LIVE contradicts the failed event → deferred_live: nothing parked", async () => {
    const session = makeStrictSession(makeMeta());
    const outcome = await parkExecutorFailure({
      session: session as unknown as ExecutorRecoverySession,
      config,
      run: makeRun(),
      probe: () => liveEvidence(),
    });
    expect(outcome.action).toBe("deferred_live");
    // C3: a live executor is never parked and never re-dispatched from here.
    expect(session.getMeta().flowState).toBe("running");
    expect(session.getMeta().blockedReason).toBeUndefined();
    expect(session.getMeta().stageExecutorRun?.status).toBe("failed");
  });

  test("develop failure parks flowState=blocked with blockedReason=executor_failed (D4)", async () => {
    const session = makeStrictSession(makeMeta());
    const outcome = await parkExecutorFailure({
      session: session as unknown as ExecutorRecoverySession,
      config,
      run: makeRun(),
      probe: () => settledEvidence("error"),
    });
    expect(outcome).toMatchObject({ action: "parked", kind: "blocked", refined: false });
    const meta = session.getMeta();
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("executor_failed");
    // The run record itself is NOT rewritten (recovery=awaiting-owner was
    // already persisted by applyExecutorTerminal before the park).
    expect(meta.stageExecutorRun?.status).toBe("failed");
    expect(meta.stageExecutorRun?.recovery).toBe("awaiting-owner");
    expect(auditLog.safeWriteAuditLog).toHaveBeenCalledWith(
      "executor_recovery",
      expect.objectContaining({ action: "parked_blocked", runId: "run-1", recovery: "awaiting-owner" }),
      "warn",
    );
  });

  test("registry 'stopped' refines the persisted terminal to aborted in the SAME commit", async () => {
    const session = makeStrictSession(makeMeta());
    const outcome = await parkExecutorFailure({
      session: session as unknown as ExecutorRecoverySession,
      config,
      run: makeRun({ status: "failed" }),
      probe: () => settledEvidence("stopped"),
    });
    expect(outcome).toMatchObject({ action: "parked", kind: "blocked", refined: true, status: "aborted" });
    expect(session.getMeta().stageExecutorRun?.status).toBe("aborted");
    expect(session.getMeta().flowState).toBe("blocked");
  });

  test("already blocked → already_parked (idempotent re-settle, zero writes)", async () => {
    const session = makeStrictSession(
      makeMeta({ flowState: "blocked", blockedReason: "executor_failed" }),
    );
    const outcome = await parkExecutorFailure({
      session: session as unknown as ExecutorRecoverySession,
      config,
      run: makeRun(),
      probe: () => settledEvidence("error"),
    });
    expect(outcome).toEqual({ action: "already_parked", kind: "blocked" });
  });

  test("probe throwing is ABSENT evidence → the trusted event still parks", async () => {
    const session = makeStrictSession(makeMeta());
    const outcome = await parkExecutorFailure({
      session: session as unknown as ExecutorRecoverySession,
      config,
      run: makeRun(),
      probe: () => {
        throw new Error("registry unavailable");
      },
    });
    expect(outcome).toMatchObject({ action: "parked", kind: "blocked", refined: false });
  });

  test("THIRD consecutive failure (budget-exhausted) parks blocked with no fourth attempt", async () => {
    // Drive the real budget chain: applyTerminalStatus flips recovery at the
    // limit; parkExecutorFailure then stops the pipeline and records the
    // exhausted budget in the audit.
    let run = makeRun({ consecutiveFailures: 0, recovery: "none" });
    for (let i = 0; i < 3; i++) {
      run = applyTerminalStatus(run, "failed", `res-${i}`, 3).run;
    }
    expect(run.consecutiveFailures).toBe(3);
    expect(run.recovery).toBe("budget-exhausted");

    const session = makeStrictSession(makeMeta({ stageExecutorRun: run }));
    const outcome = await parkExecutorFailure({
      session: session as unknown as ExecutorRecoverySession,
      config,
      run,
      probe: () => settledEvidence("error"),
    });
    expect(outcome).toMatchObject({ action: "parked", kind: "blocked", budgetExhausted: true });
    expect(session.getMeta().flowState).toBe("blocked");
    expect(auditLog.safeWriteAuditLog).toHaveBeenCalledWith(
      "executor_recovery",
      expect.objectContaining({ action: "parked_blocked", budgetExhausted: "true", recovery: "budget-exhausted" }),
      "warn",
    );
  });

  test("review/update (design-review stage) failure pauses with pauseReason=executor-failed", async () => {
    const session = makeStrictSession(
      makeMeta({
        currentStage: "design-review",
        stageExecutorRun: makeRun({ binding: makeBinding({ stage: "design-review" }) }),
        designReview: drState(),
      }),
    );
    const outcome = await parkExecutorFailure({
      session: session as unknown as ExecutorRecoverySession,
      config,
      run: makeRun({ binding: makeBinding({ stage: "design-review" }) }),
      probe: () => settledEvidence("error"),
    });
    expect(outcome).toMatchObject({ action: "parked", kind: "paused" });
    const dr = session.getMeta().designReview!;
    expect(dr.phase).toBe("paused");
    expect(dr.pauseReason).toBe("executor-failed");
    // develop flowState is NOT blocked for domain runs — the loop owns the stop.
    expect(session.getMeta().flowState).toBe("running");
  });

  test("plan-stage run parks on its domain pause too (review/update path)", async () => {
    const session = makeStrictSession(
      makeMeta({
        currentStage: "plan",
        stageExecutorRun: makeRun({ binding: makeBinding({ stage: "plan" }) }),
        designReview: drState(),
      }),
    );
    const outcome = await parkExecutorFailure({
      session: session as unknown as ExecutorRecoverySession,
      config,
      run: makeRun({ binding: makeBinding({ stage: "plan" }) }),
      probe: () => settledEvidence("error"),
    });
    expect(outcome).toMatchObject({ action: "parked", kind: "paused" });
  });

  test("domain pause keeps precedence: already paused → already_parked, no rewrite", async () => {
    const session = makeStrictSession(
      makeMeta({
        stageExecutorRun: makeRun({ binding: makeBinding({ stage: "design-review" }) }),
        designReview: drState({ phase: "paused", pauseReason: "decision-pending" }),
      }),
    );
    const outcome = await parkExecutorFailure({
      session: session as unknown as ExecutorRecoverySession,
      config,
      run: makeRun({ binding: makeBinding({ stage: "design-review" }) }),
      probe: () => settledEvidence("error"),
    });
    expect(outcome).toEqual({ action: "already_parked", kind: "paused" });
    expect(session.getMeta().designReview?.pauseReason).toBe("decision-pending");
  });

  test("no design-review state → out_of_scope (never invents a domain pause)", async () => {
    const session = makeStrictSession(
      makeMeta({
        stageExecutorRun: makeRun({ binding: makeBinding({ stage: "design-review" }) }),
        designReview: undefined,
      }),
    );
    const outcome = await parkExecutorFailure({
      session: session as unknown as ExecutorRecoverySession,
      config,
      run: makeRun({ binding: makeBinding({ stage: "design-review" }) }),
      probe: () => settledEvidence("error"),
    });
    expect(outcome).toEqual({ action: "out_of_scope", reason: "no_design_review_state" });
  });

  test("operation identity mismatch → out_of_scope (a terminal never pauses another operation)", async () => {
    const session = makeStrictSession(
      makeMeta({
        stageExecutorRun: makeRun({ binding: makeBinding({ stage: "design-review", operationId: "op-OTHER" }) }),
        designReview: drState(),
      }),
    );
    const outcome = await parkExecutorFailure({
      session: session as unknown as ExecutorRecoverySession,
      config,
      run: makeRun({ binding: makeBinding({ stage: "design-review", operationId: "op-OTHER" }) }),
      probe: () => settledEvidence("error"),
    });
    expect(outcome).toEqual({ action: "out_of_scope", reason: "operation_identity_mismatch" });
    expect(session.getMeta().designReview?.phase).toBe("review_running");
  });

  test("finished loop is never reopened by a late terminal (phase_finished)", async () => {
    const session = makeStrictSession(
      makeMeta({
        stageExecutorRun: makeRun({ binding: makeBinding({ stage: "design-review" }) }),
        designReview: drState({ phase: "finished" }),
      }),
    );
    const outcome = await parkExecutorFailure({
      session: session as unknown as ExecutorRecoverySession,
      config,
      run: makeRun({ binding: makeBinding({ stage: "design-review" }) }),
      probe: () => settledEvidence("error"),
    });
    expect(outcome).toEqual({ action: "out_of_scope", reason: "phase_finished" });
    expect(session.getMeta().designReview?.phase).toBe("finished");
  });

  test("strict commit conflict → commit_failed, fail-closed with error audit, state unchanged", async () => {
    const session = makeConflictSession(makeMeta());
    const outcome = await parkExecutorFailure({
      session: session as unknown as ExecutorRecoverySession,
      config,
      run: makeRun(),
      probe: () => settledEvidence("error"),
    });
    expect(outcome).toMatchObject({ action: "commit_failed", reason: "conflict:lock_busy" });
    expect(session.getMeta().flowState).toBe("running");
    expect(auditLog.safeWriteAuditLog).toHaveBeenCalledWith(
      "executor_recovery",
      expect.objectContaining({ action: "park_blocked_failed", commit: "conflict" }),
      "error",
    );
  });
});

// ═══ 3. invalidateExecutorRunOnBoundary — controlled strict clear ══════════

describe("194 task 7: invalidateExecutorRunOnBoundary invalidates stale bindings", () => {
  beforeEach(() => {
    jest.spyOn(auditLog, "safeWriteAuditLog").mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("no meta at all → ok/no_meta, zero side effects", async () => {
    const session = {
      getMeta: () => undefined,
      updateMeta: () => undefined,
    };
    const res = await invalidateExecutorRunOnBoundary({
      session: session as unknown as ExecutorRecoverySession,
      reason: "test",
    });
    expect(res).toEqual({ ok: true, cleared: false, reason: "no_meta" });
  });

  test("no run → ok/no_run (idempotent boundary, no audit noise)", async () => {
    const session = makeStrictSession(makeMeta({ stageExecutorRun: undefined }));
    const res = await invalidateExecutorRunOnBoundary({
      session: session as unknown as ExecutorRecoverySession,
      reason: "test",
    });
    expect(res).toEqual({ ok: true, cleared: false, reason: "no_run" });
    expect(auditLog.safeWriteAuditLog).not.toHaveBeenCalled();
  });

  test("healthy strict adapter → ONE anchored clear + invalidated audit", async () => {
    const session = makeStrictSession(makeMeta());
    const res = await invalidateExecutorRunOnBoundary({
      session: session as unknown as ExecutorRecoverySession,
      reason: "pipeline_start",
    });
    expect(res).toEqual({ ok: true, cleared: true });
    expect(session.getMeta().stageExecutorRun).toBeUndefined();
    expect(auditLog.safeWriteAuditLog).toHaveBeenCalledWith(
      "executor_run_invalidate",
      expect.objectContaining({ action: "invalidated", runId: "run-1", boundary: "pipeline_start", via: "strict" }),
    );
  });

  test("legacy adapter WITHOUT the strict interface keeps the plain clear", async () => {
    const legacy = {
      getMeta: () => makeMeta(),
      updateMeta: (patch: Partial<SessionMeta>) => ({ ...makeMeta(), ...patch } as SessionMeta),
    };
    const res = await invalidateExecutorRunOnBoundary({
      session: legacy as unknown as ExecutorRecoverySession,
      reason: "user_quit",
    });
    expect(res).toMatchObject({ ok: true, cleared: true, reason: "legacy_plain_clear" });
  });

  test("conflict then fresh re-read → second anchored attempt clears", async () => {
    const meta = makeMeta();
    let call = 0;
    const session = {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => ({ ...meta, ...patch } as SessionMeta),
      updateMetaVerified: () => {
        call += 1;
        return call === 1
          ? ({ status: "conflict", reason: "lock_busy" } as ReliableMetaCommitResult)
          : ({ status: "persisted", meta } as ReliableMetaCommitResult);
      },
    };
    const res = await invalidateExecutorRunOnBoundary({
      session: session as unknown as ExecutorRecoverySession,
      reason: "test",
    });
    expect(res).toMatchObject({ ok: true, cleared: true });
    expect(call).toBe(2);
  });

  test("two conflicts → fail-closed commit_conflict with error audit, run kept", async () => {
    const session = makeConflictSession(makeMeta());
    const res = await invalidateExecutorRunOnBoundary({
      session: session as unknown as ExecutorRecoverySession,
      reason: "decision_choose_stage",
    });
    expect(res).toEqual({ ok: false, cleared: false, reason: "commit_conflict" });
    expect(session.getMeta().stageExecutorRun).toBeDefined();
    expect(auditLog.safeWriteAuditLog).toHaveBeenCalledWith(
      "executor_run_invalidate",
      expect.objectContaining({ action: "invalidate_failed", detail: "commit_conflict" }),
      "error",
    );
  });

  test("a concurrent clear during the retry window → already_cleared (no double write)", async () => {
    const metaWithRun = makeMeta();
    const metaCleared = makeMeta({ stageExecutorRun: undefined });
    let reads = 0;
    const session = {
      getMeta: () => {
        reads += 1;
        return reads === 1 ? metaWithRun : metaCleared;
      },
      updateMeta: (patch: Partial<SessionMeta>) => ({ ...metaCleared, ...patch } as SessionMeta),
      updateMetaVerified: () => ({ status: "conflict", reason: "lock_busy" } as ReliableMetaCommitResult),
    };
    const res = await invalidateExecutorRunOnBoundary({
      session: session as unknown as ExecutorRecoverySession,
      reason: "test",
    });
    expect(res).toEqual({ ok: true, cleared: false, reason: "already_cleared" });
  });
});

// ═══ 4. boundary wiring — start / quit / choose-stage invalidate (issue 3) ═

describe("194 task 7 wiring: pipeline-start / pipeline-quit / choose-stage invalidate stale bindings", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = path.join(tmpdir(), "pi-rec-boundaries-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    await fs.promises.mkdir(TMP, { recursive: true });
    __resetSubagentsReady();
    jest.spyOn(auditLog, "safeWriteAuditLog").mockResolvedValue(undefined as never);
    jest.spyOn(auditLog, "safeWriteStageAudit").mockResolvedValue(undefined as never);
    jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.promises.rm(TMP, { recursive: true, force: true });
  });

  /** Plain (non-strict) ctx.session like the existing command tests use. */
  function plainCtx(meta: SessionMeta) {
    return {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          Object.assign(meta, patch);
          return meta;
        },
      },
      ui: {
        notify: (_msg: string) => {},
        setStatus: (_key: string, _text: string | undefined) => {},
      },
      _ctx: { sessionManager: makeMockSessionManager([]) },
    };
  }

  test("pipeline-quit invalidates the stale executor run at the boundary", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeMeta({
      flowState: "running",
      stageExecutorRun: makeRun({ status: "completed" }),
    });
    const ctx = plainCtx(meta);
    const cmd = createPipelineQuitCommand(config);
    const result = (await cmd.execute({}, ctx as never)) as { success: boolean };

    expect(result.success).toBe(true);
    expect(meta.flowState).toBe("aborted");
    // The quit boundary must not leave the binding behind for the next run.
    expect(meta.stageExecutorRun).toBeUndefined();
    expect(auditLog.safeWriteAuditLog).toHaveBeenCalledWith(
      "executor_run_invalidate",
      expect.objectContaining({ action: "invalidated", boundary: "user_quit" }),
    );
  });

  test("pipeline-quit idempotent (already aborted) touches nothing", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeMeta({ flowState: "aborted", terminateReason: "user_quit" });
    const ctx = plainCtx(meta);
    const result = (await createPipelineQuitCommand(config).execute({}, ctx as never)) as {
      success: boolean;
      message?: string;
    };
    expect(result.success).toBe(true);
    expect(meta.stageExecutorRun).toBeDefined();
  });

  test("choose-stage invalidates the abandoned visit's binding before the new stage is written", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      stageExecutorRun: makeRun({ status: "failed" }),
    });
    const session = makeStrictSession(meta);
    const ctx = {
      session,
      ui: {
        notify: (_msg: string) => {},
        setStatus: (_key: string, _text: string | undefined) => {},
      },
      _ctx: {},
    };

    const outcome = await executeDecision(
      ctx as never,
      session.getMeta(),
      "choose_stage",
      config,
      { targetStage: "review", source: "test" },
    );

    expect(outcome.success).toBe(true);
    expect(session.getMeta().currentStage).toBe("review");
    expect(session.getMeta().stageExecutorRun).toBeUndefined();
    expect(auditLog.safeWriteAuditLog).toHaveBeenCalledWith(
      "executor_run_invalidate",
      expect.objectContaining({ action: "invalidated", boundary: "decision_choose_stage", via: "strict" }),
    );
  });

  test("choose-stage without a run is unaffected (no regression, no audit)", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      stageExecutorRun: undefined,
    });
    const ctx = plainCtx(meta);
    const outcome = await executeDecision(ctx as never, meta, "choose_stage", config, {
      targetStage: "review",
      source: "test",
    });
    expect(outcome.success).toBe(true);
    expect(auditLog.safeWriteAuditLog).not.toHaveBeenCalledWith(
      "executor_run_invalidate",
      expect.anything(),
    );
  });

  test("new-pipeline start (different doc) invalidates the old binding BEFORE the fresh meta", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    await fs.promises.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    await fs.promises.writeFile(path.join(TMP, "docs", "design", "new.md"), "# Requirement\n", "utf-8");

    const meta = makeMeta({
      currentStage: "review",
      flowState: "aborted",
      requirementDoc: "docs/design/old.md",
      stageExecutorRun: makeRun({ status: "unknown" }),
    });
    const ctx = plainCtx(meta);
    const result = (await createPipelineStartCommand(config).execute(
      { file: "docs/design/new.md" },
      ctx as never,
    )) as { success: boolean };

    expect(result.success).toBe(true);
    expect(meta.currentStage).toBe("clarify");
    // The stale UNKNOWN run must not survive under the new pipelineId —
    // otherwise it would wrongly gate the new run's 189 bypass forever.
    expect(meta.stageExecutorRun).toBeUndefined();
    expect(auditLog.safeWriteAuditLog).toHaveBeenCalledWith(
      "executor_run_invalidate",
      expect.objectContaining({ action: "invalidated", boundary: "pipeline_start" }),
    );
  });

  test("resume start (same doc) KEEPS the binding for D4 breakpoint recovery", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    jest.spyOn(subagentRpc, "spawnStageSubagent").mockResolvedValue({
      spawned: false,
      fallback: true,
    } as never);
    const run = makeRun();
    const meta = makeMeta({
      currentStage: "develop",
      flowState: "aborted",
      requirementDoc: "docs/design/doc.md",
      stageExecutorRun: run,
    });
    const ctx = plainCtx(meta);
    const result = (await createPipelineStartCommand(config).execute(
      { file: "docs/design/doc.md" },
      ctx as never,
    )) as { success: boolean };

    expect(result.success).toBe(true);
    expect(meta.currentStage).toBe("develop");
    // plan task 7: resume uses the original breakpoint — the run stays bound.
    expect(meta.stageExecutorRun).toEqual(run);
  });
});
