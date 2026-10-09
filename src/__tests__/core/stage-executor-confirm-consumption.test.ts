/**
 * 194 Phase 3 (C5 + task 7, review round-1 issues 2/5): owner-side CONFIRM
 * CONSUMPTION boundaries for closed-loop executor runs.
 *
 * Two production guarantees are pinned here:
 *
 * 1. The 189 auto-respawn bypass is REFUSED while the closed loop owns the
 *    stage (plan Phase 3 task 7 / C3 / D4). `maybeRespawnAfterTransientFailure`
 *    Guard 1.5 gates on `meta.stageExecutorRun && !terminalConsumed`: a live
 *    (running/unknown) run is never re-dispatched, an unconsumed terminal run
 *    stays parked on the owner's explicit D4 recovery. Only after the owner
 *    consumed the terminal does the ordinary 189 behaviour resume; a develop/fix
 *    pipeline WITHOUT an executor run is untouched.
 *
 * 2. Confirm consumption is the OWNER's, never a default. The declaration
 *    relay (`applyDeclarationRelay`) must never downgrade a stored
 *    `needConfirm: true` through omitted or `false` relay arguments, and the
 *    caller gate keeps the owner in `awaiting-terminal` (before a trusted
 *    terminal) / `awaiting-owner-recovery` (failed/aborted) instead of
 *    silently verifying, confirming, counting or advancing.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from "bun:test";
import { maybeRespawnAfterTransientFailure } from "../../core/agent-settled";
import { applyDeclarationRelay, gateStageToolCall } from "../../core/stage-executor/tool-consumption";
import type {
  PipelineConfig,
  SessionMeta,
  StageCompletionDeclaration,
  StageExecutorBinding,
  StageExecutorRun,
} from "../../types";
import type { RuntimeCtx } from "../../core/runtime-ctx";
import * as autoVerifier from "../../core/auto-verifier";
import * as subagentRpc from "../../utils/subagent-rpc";
import * as auditLog from "../../utils/auditLog";
import { makeMockSessionManager, makeStrictSession } from "../helpers";

const OWNER_FILE = "/sessions/owner.jsonl";
const VISIT = 1_700_000_000_000;

type PipelineUiArg = Parameters<typeof maybeRespawnAfterTransientFailure>[4];

// ─── shared fixtures ────────────────────────────────────────────────────────

function makeBinding(overrides?: Partial<StageExecutorBinding>): StageExecutorBinding {
  return {
    runId: "run-1",
    pipelineId: "test-pipeline-123",
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
    status: "running",
    recovery: "none",
    consecutiveFailures: 0,
    terminalConsumed: false,
    ...overrides,
  };
}

// ═══ 1. 189 bypass refused under closed-loop ownership (Guard 1.5) ════════

describe("194 task 7: 189 auto-respawn bypass is refused while the closed loop owns the stage", () => {
  let mockConfig: PipelineConfig;
  let mockMeta: SessionMeta;
  let metaUpdateCalls: Array<Partial<SessionMeta>>;
  let mockCtx: RuntimeCtx;
  let precheckSpy: jest.Mock;
  let spawnSpy: jest.Mock;
  let auditSpy: jest.Mock;

  beforeEach(() => {
    metaUpdateCalls = [];

    mockConfig = {
      projectRoot: "/tmp/test-project",
      stages: {
        develop: {
          verify: {
            require: true,
            mode: "hook" as const,
            requiredFiles: ["docs/design/189_req_plan.md"],
          },
          agent: "@pixis",
          skill: "fast-develop",
          nextStage: "review",
          prevStage: "plan",
        },
        fix: {
          verify: {
            require: true,
            mode: "hook" as const,
            requiredFiles: ["docs/design/189_fix_commit.md"],
          },
          agent: "@pixis",
          skill: "fast-develop",
          nextStage: "review",
          prevStage: "develop",
        },
      },
    } as unknown as PipelineConfig;

    mockMeta = {
      currentStage: "develop",
      pipelineId: "test-pipeline-123",
      flowState: "running",
      transientRetryCount: 0,
      lastTransientRespawnMsgId: undefined,
      spawnedStages: {},
      activeSpawns: {},
    } as SessionMeta;

    mockCtx = {
      session: {
        getMeta: () => mockMeta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          metaUpdateCalls.push(patch);
          Object.assign(mockMeta, patch);
          return mockMeta;
        },
      },
      ui: { notify: (_msg: string) => {} },
      _ctx: {},
    } as unknown as RuntimeCtx;

    precheckSpy = jest
      .spyOn(autoVerifier, "precheckRequiredFiles")
      .mockResolvedValue({ passed: false, missing: ["docs/design/189_req_plan.md"] } as never);
    spawnSpy = jest
      .spyOn(subagentRpc, "spawnStageSubagent")
      .mockResolvedValue({ spawned: true, fallback: false } as never);
    auditSpy = jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);

    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Run Guard 1.5 through the full respawn helper with a fresh messageId. */
  function respawn(run: StageExecutorRun | undefined): Promise<void> {
    mockMeta.stageExecutorRun = run;
    return maybeRespawnAfterTransientFailure(
      mockCtx,
      mockConfig,
      mockMeta,
      { messageId: "msg-194" },
      mockCtx.ui as unknown as PipelineUiArg,
    );
  }

  test("G1. live RUNNING run → gated: no spawn, no precheck, no meta writes, audit says live", async () => {
    await respawn(makeRun({ status: "running" }));

    expect(spawnSpy).not.toHaveBeenCalled();
    // Guard 1.5 sits BEFORE the precheck — the bypass never even measures the stage.
    expect(precheckSpy).not.toHaveBeenCalled();
    // Zero side effects: no retry-count increment, no spawn-record clearing.
    expect(metaUpdateCalls).toHaveLength(0);
    expect(auditSpy).toHaveBeenCalledWith(
      "transient_respawn_closed_loop_gated",
      expect.objectContaining({
        pipelineId: "test-pipeline-123",
        stage: "develop",
        runId: "run-1",
        runStage: "develop",
        status: "running",
        live: "true",
      }),
      "warn",
    );
    expect(auditSpy).not.toHaveBeenCalledWith("transient_auto_respawn", expect.anything());
  });

  test("G2. UNKNOWN run → gated (C3: unknown/live never redispatch)", async () => {
    await respawn(makeRun({ status: "unknown" }));

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(metaUpdateCalls).toHaveLength(0);
    expect(auditSpy).toHaveBeenCalledWith(
      "transient_respawn_closed_loop_gated",
      expect.objectContaining({ status: "unknown", live: "true" }),
      "warn",
    );
  });

  test("G3. FAILED run parked at recovery=awaiting-owner (unconsumed) → gated, D4 owner path decides", async () => {
    await respawn(
      makeRun({ status: "failed", recovery: "awaiting-owner", consecutiveFailures: 1 }),
    );

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(metaUpdateCalls).toHaveLength(0);
    expect(auditSpy).toHaveBeenCalledWith(
      "transient_respawn_closed_loop_gated",
      expect.objectContaining({
        status: "failed",
        recovery: "awaiting-owner",
        live: "false",
      }),
      "warn",
    );
  });

  test("G4. budget-exhausted failed run → gated (no 4th same-visit attempt through the bypass)", async () => {
    await respawn(
      makeRun({ status: "failed", recovery: "budget-exhausted", consecutiveFailures: 3 }),
    );

    expect(spawnSpy).not.toHaveBeenCalled();
    // The 189 freeze path must not fire either: the loop is already parked on D4.
    expect(metaUpdateCalls).toHaveLength(0);
    expect(auditSpy).toHaveBeenCalledWith(
      "transient_respawn_closed_loop_gated",
      expect.objectContaining({ recovery: "budget-exhausted", live: "false" }),
      "warn",
    );
  });

  test("G5. closed-loop ownership beats the current stage: fix stage with an unconsumed develop run → gated", async () => {
    mockMeta.currentStage = "fix";

    await respawn(
      makeRun({
        status: "completed",
        recovery: "awaiting-owner",
        terminalConsumed: false,
        binding: makeBinding({ stage: "develop" }),
      }),
    );

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(
      "transient_respawn_closed_loop_gated",
      expect.objectContaining({ stage: "fix", runStage: "develop" }),
      "warn",
    );
  });

  test("G6. owner already CONSUMED the terminal (terminalConsumed=true) → ordinary 189 bypass resumes", async () => {
    await respawn(makeRun({ status: "completed", terminalConsumed: true }));

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledWith("transient_auto_respawn", {
      pipelineId: "test-pipeline-123",
      stage: "develop",
      attempt: "1",
      basis: "rpc",
      missing: "docs/design/189_req_plan.md",
    });
    expect(metaUpdateCalls.some((c) => c.transientRetryCount === 1)).toBe(true);
  });

  test("G7. ordinary develop/fix WITHOUT an executor run → bypass unchanged (regression)", async () => {
    await respawn(undefined);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy).not.toHaveBeenCalledWith(
      "transient_respawn_closed_loop_gated",
      expect.anything(),
    );
  });
});

// ═══ 2. owner confirm relay: stored intent is never downgraded ════════════

describe("194 C5: applyDeclarationRelay keeps the child's stored confirm intent", () => {
  function decl(overrides?: Partial<StageCompletionDeclaration>): StageCompletionDeclaration {
    return {
      declarationId: "decl-1",
      revision: 1,
      requestedBy: "stage_advance",
      ...overrides,
    };
  }

  test("no declaration → args pass through untouched", () => {
    const args = { nextStage: "review" };
    expect(applyDeclarationRelay(args, undefined)).toEqual(args);
  });

  test("stored needConfirm=true is NOT downgraded by an omitted relay argument", () => {
    const out = applyDeclarationRelay({}, decl({ needConfirm: true, nextStage: "review" }));
    expect(out.needConfirm).toBe(true);
  });

  test("stored needConfirm=true is NOT downgraded by an explicit false relay argument", () => {
    const out = applyDeclarationRelay(
      { needConfirm: false },
      decl({ needConfirm: true, nextStage: "review" }),
    );
    expect(out.needConfirm).toBe(true);
  });

  test("stored target fills an omitted nextStage; an explicit relay target is kept", () => {
    const filled = applyDeclarationRelay({}, decl({ nextStage: "review" }));
    expect(filled.nextStage).toBe("review");

    const kept = applyDeclarationRelay({ nextStage: "completed" }, decl({ nextStage: "review" }));
    expect(kept.nextStage).toBe("completed");
  });

  test("no stored confirm intent → relay never injects one (confirm is not a default)", () => {
    const out = applyDeclarationRelay({}, decl({ nextStage: null, needConfirm: false }));
    expect("needConfirm" in out).toBe(false);
    expect("nextStage" in out).toBe(false);
  });

  test("verify-only declaration (no advance intent) leaves the relay args untouched", () => {
    const out = applyDeclarationRelay(
      { skipVerify: false },
      decl({ requestedBy: "pipeline_verify", verificationRequested: true }),
    );
    expect(out).toEqual({ skipVerify: false });
  });
});

// ═══ 3. owner consumption posture: no confirm/advance before a trusted end ═

describe("194 C5: the owner gate withholds consumption until a trusted terminal", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Owner sessionManager: session file proves ownership, NO parent header. */
  function ownerManager() {
    return {
      ...makeMockSessionManager([]),
      getSessionFile: () => OWNER_FILE,
      getSessionName: () => "owner-session",
      getHeader: () => undefined,
    };
  }

  function ownerGateDeps(meta: SessionMeta) {
    const session = makeStrictSession(meta);
    return {
      session,
      deps: {
        tool: "stage_advance" as const,
        config: {} as PipelineConfig,
        session: session as never,
        meta,
        args: {},
        runtimeCtx: { session, _ctx: { sessionManager: ownerManager() } },
      },
    };
  }

  test("completed + terminalConsumed=false → owner-bound: the owner's tool drives the bound consumption", async () => {
    const meta = {
      currentStage: "develop",
      pipelineId: "test-pipeline-123",
      stageExecutorRun: makeRun({ status: "completed" }),
    } as SessionMeta;
    const { deps } = ownerGateDeps(meta);

    const outcome = await gateStageToolCall(deps);
    expect(outcome.kind).toBe("owner-bound");
  });

  test("run still running → awaiting-terminal pending: nothing verified, confirmed, counted or dispatched", async () => {
    jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);
    const meta = {
      currentStage: "develop",
      pipelineId: "test-pipeline-123",
      stageExecutorRun: makeRun({ status: "running" }),
    } as SessionMeta;
    const { session, deps } = ownerGateDeps(meta);

    const outcome = await gateStageToolCall(deps);
    expect(outcome.kind).toBe("return");
    const result = (outcome as { kind: "return"; result: Record<string, unknown> }).result;
    expect(result.action).toBe("awaiting-terminal");
    expect(result.pending).toBe(true);
    // Zero-write posture: the persisted run is exactly as before.
    expect(session.getMeta().stageExecutorRun).toEqual(meta.stageExecutorRun);
  });

  test("failed terminal (unconsumed) → awaiting-owner-recovery: automatic advancement is withheld", async () => {
    jest.spyOn(auditLog, "writeAuditLog").mockResolvedValue(undefined as never);
    const meta = {
      currentStage: "develop",
      pipelineId: "test-pipeline-123",
      stageExecutorRun: makeRun({ status: "failed", recovery: "awaiting-owner" }),
    } as SessionMeta;
    const { session, deps } = ownerGateDeps(meta);

    const outcome = await gateStageToolCall(deps);
    const result = (outcome as { kind: "return"; result: Record<string, unknown> }).result;
    expect(result.action).toBe("awaiting-owner-recovery");
    expect(result.success).toBe(false);
    expect(session.getMeta().stageExecutorRun).toEqual(meta.stageExecutorRun);
  });

  test("terminalConsumed=true → ordinary: post-consumption flows are unaffected (no regression)", async () => {
    const meta = {
      currentStage: "develop",
      pipelineId: "test-pipeline-123",
      stageExecutorRun: makeRun({ status: "completed", terminalConsumed: true }),
    } as SessionMeta;
    const { deps } = ownerGateDeps(meta);

    const outcome = await gateStageToolCall(deps);
    expect(outcome.kind).toBe("ordinary");
  });
});
