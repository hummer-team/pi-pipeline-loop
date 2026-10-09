/**
 * 194 Phase 3 (C5, part 3): the shared CALLER GATE for stage-side tools and
 * the bound tool-entry consumption paths.
 *
 * Covers the plan matrix for `core/stage-executor-tool-consumption.test.ts`:
 * a current child only REGISTERS its declaration (with over-reach refused
 * BEFORE any write), stale/unknown callers get zero side effects, the owner
 * stays `awaiting-terminal` before a trusted terminal and parks on
 * `awaiting-owner-recovery` for failed/aborted ones, and the REAL tool entries
 * (`pipeline_verify`, `pipeline_handoff`, `applyVerifyPass`/`applyVerifyFail`)
 * consume bound runs through ONE strict commit — never a plain fallback.
 * The strict commits run through the real createSessionState adapter.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createSessionState, __resetSharedStateDir } from "../../core/session-state";
import {
  gateStageToolCall,
  CHILD_DECLARED_COPY,
  type StageToolGateDeps,
} from "../../core/stage-executor/tool-consumption";
import { EXECUTOR_BINDING_ENTRY_TYPE } from "../../core/stage-executor/runtime-binding";
import { applyVerifyPass, applyVerifyFail } from "../../core/verify-advance";
import { createPipelineVerify } from "../../tools/pipeline-verify";
import { createPipelineHandoff } from "../../tools/pipeline-handoff";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import { makeMockSessionManager } from "../helpers";
import type {
  PipelineConfig,
  SessionMeta,
  StageExecutorBinding,
  StageExecutorRun,
} from "../../types";

const AGENT = "01a11bbb-c3b4-72bc-9397-4f5b9881be41";
const OWNER_FILE = "/sessions/owner.jsonl";
const CHILD_FILE = "/sessions/child.jsonl";
const VISIT = 1_700_000_000_000;

function makeBinding(overrides?: Partial<StageExecutorBinding>): StageExecutorBinding {
  return {
    runId: "run-1",
    pipelineId: "pipe-exec-1",
    ownerSessionFile: OWNER_FILE,
    stage: "develop",
    stageVisitId: VISIT,
    operationId: "op-1",
    agentId: AGENT,
    executorSessionFile: CHILD_FILE,
    ...overrides,
  };
}

function makeRun(binding?: Partial<StageExecutorBinding>, overrides?: Partial<StageExecutorRun>): StageExecutorRun {
  return {
    binding: makeBinding(binding),
    status: "running",
    recovery: "none",
    consecutiveFailures: 0,
    terminalConsumed: false,
    ...overrides,
  };
}

function baseMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return {
    currentStage: "develop",
    previousStage: "plan",
    stageStartTime: VISIT,
    pipelineId: "pipe-exec-1",
    domain: { id: "general", version: "latest", skillPath: "/tmp/domain.md" },
    summaries: {},
    loopCount: 0,
    currentStepIndex: 0,
    maxLoops: 3,
    ...overrides,
  };
}

function bindingEntry(data: StageExecutorBinding): unknown {
  return { type: "custom", customType: EXECUTOR_BINDING_ENTRY_TYPE, data };
}

/** Owner sessionManager: session file proves ownership, NO parent header. */
function ownerManager(entries: unknown[] = []) {
  return {
    ...makeMockSessionManager(entries),
    getSessionFile: () => OWNER_FILE,
    getSessionName: () => "owner-session",
    getHeader: () => undefined,
  };
}

/** Child sessionManager: parent header + subagent name pattern + own file. */
function childManager(childEntries: unknown[], overrides?: { file?: string; parent?: string }) {
  return {
    ...makeMockSessionManager(childEntries),
    getSessionFile: () => overrides?.file ?? CHILD_FILE,
    getSessionName: () => "develop-executor#a1b2c3d4",
    getHeader: () => ({ parentSession: overrides?.parent ?? OWNER_FILE }),
  };
}

interface Harness {
  session: ReturnType<typeof createSessionState>;
  /** Session proxy counting plain vs verified writes. */
  proxy: {
    session: {
      getMeta(): SessionMeta | undefined;
      updateMeta(patch: Partial<SessionMeta>): SessionMeta | undefined;
      updateMetaVerified(patch: Partial<SessionMeta>, expected: any): any;
    };
    calls: { plain: number; verified: number };
  };
  entries: unknown[];
  config: PipelineConfig;
  projectRoot: string;
  cleanup: () => Promise<void>;
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
  __resetAuditDirPath();
});

async function makeHarness(): Promise<Harness> {
  const projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-exec-consumption-"));
  const auditDir = ".pi/audit";
  const entries: unknown[] = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
  };
  const session = createSessionState(pi as never, { sessionManager: makeMockSessionManager(entries) } as never, {
    projectRoot,
    auditDir,
  });
  const calls = { plain: 0, verified: 0 };
  const proxy = {
    session: {
      getMeta: () => session.getMeta(),
      updateMeta: (patch: Partial<SessionMeta>) => {
        calls.plain++;
        return session.updateMeta(patch);
      },
      updateMetaVerified: (patch: Partial<SessionMeta>, expected: any) => {
        calls.verified++;
        return session.updateMetaVerified!(patch, expected);
      },
    },
    calls,
  };
  const config = {
    projectRoot,
    auditDir,
    maxLoopCycles: 3,
    stages: {
      clarify: { nextStage: "plan" },
      plan: { nextStage: "develop" },
      develop: { nextStage: "review" },
      review: { nextStage: "completed" },
      fix: { nextStage: "review" },
      completed: { nextStage: null },
    },
  } as unknown as PipelineConfig;
  await initAuditLog(config);
  return {
    session,
    proxy,
    entries,
    config,
    projectRoot,
    cleanup: async () => {
      __resetSharedStateDir();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

/** Seed through the adapter itself (the FIRST write, before a shared meta exists). */
function seed(h: Harness, meta: SessionMeta): void {
  h.session.updateMeta(meta);
  if (h.session.getMeta()?.pipelineId !== meta.pipelineId) {
    throw new Error("seed failed: shared store did not adopt the meta");
  }
}

function freshRun(h: Harness): StageExecutorRun | undefined {
  return h.session.getMeta()?.stageExecutorRun;
}

function gateDeps(overrides: Partial<StageToolGateDeps>): StageToolGateDeps {
  const h = harness!;
  return {
    tool: "pipeline_verify",
    config: h.config,
    session: h.proxy.session as never,
    meta: h.session.getMeta()!,
    args: {},
    runtimeCtx: { session: h.proxy.session, _ctx: { sessionManager: ownerManager() } },
    issueDeclarationId: (() => {
      let n = 0;
      return () => `decl-${++n}`;
    })(),
    ...overrides,
  };
}

// ─── child declaration registration ─────────────────────────────────────────

describe("194 C5 gate: current child registers its declaration only", () => {
  it("pipeline_verify from a current child stores revision 1 with zero other effects", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    const childCtx = {
      session: harness.proxy.session,
      _ctx: { sessionManager: childManager([bindingEntry(makeBinding())]) },
    };

    const res = await gateStageToolCall(gateDeps({
      tool: "pipeline_verify",
      runtimeCtx: childCtx,
      args: {},
    }));

    expect(res.kind).toBe("return");
    if (res.kind !== "return") return;
    expect(res.result.action).toBe("declared-for-owner");
    expect(res.result.pending).toBe(true);
    expect(res.result.declarationRevision).toBe(1);
    expect(res.result.message).toBe(CHILD_DECLARED_COPY);

    const persisted = freshRun(harness)!;
    expect(persisted.declaration).toMatchObject({
      declarationId: "decl-1",
      revision: 1,
      requestedBy: "pipeline_verify",
      verificationRequested: true,
    });
    // The registration is the ONLY write (no plain fallback).
    expect(harness.proxy.calls).toEqual({ plain: 0, verified: 1 });
    // Nothing else moved: still develop, unconsumed.
    expect(harness.session.getMeta()!.currentStage).toBe("develop");
    expect(persisted.terminalConsumed).toBe(false);
  });

  it("stage_advance after a verify completes the intent (revision 2, requestedBy stage_advance)", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({
      stageExecutorRun: makeRun(undefined, {
        declaration: { declarationId: "decl-0", revision: 1, requestedBy: "pipeline_verify", verificationRequested: true },
      }),
    }));
    const childCtx = {
      session: harness.proxy.session,
      _ctx: { sessionManager: childManager([bindingEntry(makeBinding())]) },
    };

    const res = await gateStageToolCall(gateDeps({
      tool: "stage_advance",
      runtimeCtx: childCtx,
      args: { nextStage: "review", needConfirm: true },
    }));

    expect(res.kind).toBe("return");
    if (res.kind !== "return") return;
    expect(res.result.action).toBe("declared-for-owner");
    expect(res.result.declarationRevision).toBe(2);
    const persisted = freshRun(harness)!;
    expect(persisted.declaration).toMatchObject({
      revision: 2,
      requestedBy: "stage_advance",
      nextStage: "review",
      needConfirm: true,
      verificationRequested: true, // merged, kept
    });
    expect(harness.proxy.calls).toEqual({ plain: 0, verified: 1 });
  });

  it("an identical re-submit echoes: same answer, ZERO writes", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({
      stageExecutorRun: makeRun(undefined, {
        declaration: {
          declarationId: "decl-1", revision: 1, requestedBy: "stage_advance",
          nextStage: "review", needConfirm: false,
        },
      }),
    }));
    const before = JSON.stringify(freshRun(harness));
    const childCtx = {
      session: harness.proxy.session,
      _ctx: { sessionManager: childManager([bindingEntry(makeBinding())]) },
    };

    const res = await gateStageToolCall(gateDeps({
      tool: "stage_advance",
      runtimeCtx: childCtx,
      args: { nextStage: "review" },
    }));

    expect(res.kind).toBe("return");
    if (res.kind !== "return") return;
    expect(res.result).toMatchObject({ success: false, pending: true, action: "declared-for-owner" });
    // Echo shape: NO declarationRevision (nothing changed).
    expect(res.result.declarationRevision).toBeUndefined();
    expect(harness.proxy.calls).toEqual({ plain: 0, verified: 0 });
    expect(JSON.stringify(freshRun(harness))).toBe(before);
  });

  it("a verify after a stage_advance does NOT bump the revision (verification already true)", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({
      stageExecutorRun: makeRun(undefined, {
        declaration: {
          declarationId: "decl-1", revision: 1, requestedBy: "stage_advance",
          nextStage: "review", needConfirm: false, verificationRequested: true,
        },
      }),
    }));
    const childCtx = {
      session: harness.proxy.session,
      _ctx: { sessionManager: childManager([bindingEntry(makeBinding())]) },
    };

    const res = await gateStageToolCall(gateDeps({ tool: "pipeline_verify", runtimeCtx: childCtx }));
    expect(res.kind).toBe("return");
    if (res.kind !== "return") return;
    expect(res.result.action).toBe("declared-for-owner");
    expect(res.result.declarationRevision).toBeUndefined(); // echo
    expect(harness.proxy.calls.verified).toBe(0);
  });

  it("a failed declaration commit reports honestly and stores nothing", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    const before = JSON.stringify(freshRun(harness));
    // Session whose strict commit always conflicts (simulated concurrent write).
    const conflictSession = {
      getMeta: () => harness!.session.getMeta(),
      updateMeta: () => { throw new Error("plain fallback must NEVER happen"); },
      updateMetaVerified: () => ({ status: "conflict", reason: "executor_runid_mismatch" }),
    };
    const childCtx = {
      session: conflictSession,
      _ctx: { sessionManager: childManager([bindingEntry(makeBinding())]) },
    };

    const res = await gateStageToolCall(gateDeps({
      tool: "pipeline_verify",
      session: conflictSession as never,
      runtimeCtx: childCtx,
    }));

    expect(res.kind).toBe("return");
    if (res.kind !== "return") return;
    expect(res.result.error).toBe("declaration_commit_failed:conflict");
    expect(res.result.success).toBe(false);
    expect(JSON.stringify(freshRun(harness))).toBe(before); // store untouched
  });
});

// ─── child over-reach & caller refusal (zero side effects) ─────────────────

describe("194 C5 gate: over-reach and untrusted callers are refused with ZERO writes", () => {
  const childCtx = () => ({
    session: harness!.proxy.session,
    _ctx: { sessionManager: childManager([bindingEntry(makeBinding())]) },
  });

  async function expectRefusal(
    tool: StageToolGateDeps["tool"],
    args: Record<string, unknown>,
    reason: string,
  ): Promise<void> {
    const res = await gateStageToolCall(gateDeps({ tool, args, runtimeCtx: childCtx() }));
    expect(res.kind).toBe("return");
    if (res.kind !== "return") return;
    expect(res.result.action).toBe("declaration_rejected");
    expect(res.result.reason).toBe(reason);
    expect(harness!.proxy.calls).toEqual({ plain: 0, verified: 0 });
    expect(freshRun(harness!)!.declaration).toBeUndefined();
  }

  it("verify with a stage override → verify_stage_override", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    await expectRefusal("pipeline_verify", { stage: "review" }, "verify_stage_override");
  });

  it("verify with a file override → verify_file_override", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    await expectRefusal("pipeline_verify", { verifyFile: "/tmp/other.md" }, "verify_file_override");
  });

  it("advance with skipVerify → advance_skip_verify", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    await expectRefusal("stage_advance", { skipVerify: true }, "advance_skip_verify");
  });

  it("advance with a reviewConclusion → advance_review_conclusion", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    await expectRefusal("stage_advance", { reviewConclusion: "pass" }, "advance_review_conclusion");
  });

  it("advance to an unknown target → advance_unknown_target", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    await expectRefusal("stage_advance", { nextStage: "bogus" }, "advance_unknown_target");
  });

  it("advance to the same stage → advance_same_stage", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    await expectRefusal("stage_advance", { nextStage: "develop" }, "advance_same_stage");
  });

  it("child calling pipeline_handoff → caller_refused handoff_is_plugin_owned", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    const res = await gateStageToolCall(gateDeps({
      tool: "pipeline_handoff",
      args: { nextStage: "review" },
      runtimeCtx: childCtx(),
    }));
    expect(res.kind).toBe("return");
    if (res.kind !== "return") return;
    expect(res.result).toMatchObject({ action: "caller_refused", reason: "handoff_is_plugin_owned" });
    expect(harness.proxy.calls).toEqual({ plain: 0, verified: 0 });
  });

  it("child whose recorded binding is from an OLD run → stale_executor_binding", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    const staleCtx = {
      session: harness.proxy.session,
      _ctx: { sessionManager: childManager([bindingEntry(makeBinding({ runId: "run-old" }))]) },
    };
    const res = await gateStageToolCall(gateDeps({ runtimeCtx: staleCtx }));
    expect(res.kind).toBe("return");
    if (res.kind !== "return") return;
    expect(res.result).toMatchObject({ action: "caller_refused", reason: "stale_executor_binding" });
    expect(harness.proxy.calls).toEqual({ plain: 0, verified: 0 });
  });

  it("closed-loop child with NO binding record → caller_identity_unproven (fail-closed)", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    const noRecordCtx = {
      session: harness.proxy.session,
      _ctx: { sessionManager: childManager([]) },
    };
    const res = await gateStageToolCall(gateDeps({ runtimeCtx: noRecordCtx }));
    expect(res.kind).toBe("return");
    if (res.kind !== "return") return;
    expect(res.result).toMatchObject({ action: "caller_refused", reason: "caller_identity_unproven" });
  });

  it("a non-child session that is NOT the owner file → caller_identity_unproven", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    const strangerCtx = {
      session: harness.proxy.session,
      _ctx: { sessionManager: { ...ownerManager(), getSessionFile: () => "/sessions/stranger.jsonl" } },
    };
    const res = await gateStageToolCall(gateDeps({ runtimeCtx: strangerCtx }));
    expect(res.kind).toBe("return");
    if (res.kind !== "return") return;
    expect(res.result).toMatchObject({ action: "caller_refused", reason: "caller_identity_unproven" });
  });

  it("runtime evidence absence is NOT a fallback → caller_identity_unproven", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    const res = await gateStageToolCall(gateDeps({ runtimeCtx: { session: harness.proxy.session } }));
    expect(res.kind).toBe("return");
    if (res.kind !== "return") return;
    expect(res.result).toMatchObject({ action: "caller_refused", reason: "caller_identity_unproven" });
    expect(harness.proxy.calls).toEqual({ plain: 0, verified: 0 });
  });
});

// ─── owner posture ───────────────────────────────────────────────────────────

describe("194 C5 gate: owner posture follows the trusted run state", () => {
  const ownerCtx = () => ({
    session: harness!.proxy.session,
    _ctx: { sessionManager: ownerManager() },
  });

  it("no current run → ordinary (existing flow untouched)", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta());
    const res = await gateStageToolCall(gateDeps({ runtimeCtx: ownerCtx() }));
    expect(res.kind).toBe("ordinary");
  });

  it("run still running → awaiting-terminal with zero side effects", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    const res = await gateStageToolCall(gateDeps({ runtimeCtx: ownerCtx() }));
    expect(res.kind).toBe("return");
    if (res.kind !== "return") return;
    expect(res.result).toMatchObject({ success: false, pending: true, action: "awaiting-terminal" });
    expect(harness.proxy.calls).toEqual({ plain: 0, verified: 0 });
  });

  it("run status unknown (end unproven) → awaiting-terminal", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun(undefined, { status: "unknown" }) }));
    const res = await gateStageToolCall(gateDeps({ runtimeCtx: ownerCtx() }));
    expect(res.kind).toBe("return");
    if (res.kind !== "return") return;
    expect(res.result.action).toBe("awaiting-terminal");
  });

  it("failed run → awaiting-owner-recovery (no automatic advancement)", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({
      stageExecutorRun: makeRun(undefined, { status: "failed", recovery: "awaiting-owner", consecutiveFailures: 1 }),
    }));
    const res = await gateStageToolCall(gateDeps({ runtimeCtx: ownerCtx() }));
    expect(res.kind).toBe("return");
    if (res.kind !== "return") return;
    expect(res.result).toMatchObject({ success: false, pending: true, action: "awaiting-owner-recovery" });
    expect(harness.proxy.calls).toEqual({ plain: 0, verified: 0 });
  });

  it("aborted run → awaiting-owner-recovery", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun(undefined, { status: "aborted" }) }));
    const res = await gateStageToolCall(gateDeps({ tool: "pipeline_handoff", args: { nextStage: "review" }, runtimeCtx: ownerCtx() }));
    expect(res.kind).toBe("return");
    if (res.kind !== "return") return;
    expect(res.result.action).toBe("awaiting-owner-recovery");
  });

  it("trusted completed run with the domain closed → owner-bound (consume with strict commits)", async () => {
    harness = await makeHarness();
    const run = makeRun(undefined, { status: "completed" });
    seed(harness, baseMeta({ stageExecutorRun: run }));
    const res = await gateStageToolCall(gateDeps({ runtimeCtx: ownerCtx() }));
    expect(res.kind).toBe("owner-bound");
    if (res.kind !== "owner-bound") return;
    expect(res.run.binding.runId).toBe("run-1");
  });

  it("while the design-review domain is active the coordinator keeps consuming → ordinary", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({
      currentStage: "plan",
      designReview: { phase: "reviewing", round: 1, planDoc: "/tmp/plan.md" } as never,
      stageExecutorRun: makeRun({ stage: "plan" }, { status: "completed" }),
    }));
    const res = await gateStageToolCall(gateDeps({ runtimeCtx: ownerCtx() }));
    expect(res.kind).toBe("ordinary");
  });

  it("an already consumed run → ordinary (exactly-once: never re-served)", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({
      stageExecutorRun: makeRun(undefined, { status: "completed", terminalConsumed: true }),
    }));
    const res = await gateStageToolCall(gateDeps({ runtimeCtx: ownerCtx() }));
    expect(res.kind).toBe("ordinary");
  });
});

// ─── pipeline_verify tool entry (real factory.execute) ──────────────────────

describe("194 C5: pipeline_verify tool entry through the gate", () => {
  it("child call registers the declaration and performs NO verification", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    const tool = createPipelineVerify(harness.config);
    const ctx = {
      session: harness.proxy.session,
      _ctx: { sessionManager: childManager([bindingEntry(makeBinding())]) },
      ui: { notify: () => {} },
    };

    // Partial RuntimeCtx mock: `as never` is the established convention for
    // structural mocks (see tools/design-review-advance-entrypoints.test.ts).
    const result = await tool.execute({}, ctx as never) as Record<string, unknown>;
    expect(result).toMatchObject({ success: false, pending: true, action: "declared-for-owner" });
    expect(freshRun(harness)!.declaration?.requestedBy).toBe("pipeline_verify");
    // No verification side effect: no failure record, no counting.
    const persisted = harness.session.getMeta()!;
    expect(persisted.verifyFailures ?? []).toEqual([]);
    expect(persisted.verifyAttempts ?? 0).toBe(0);
    expect(harness.proxy.calls).toEqual({ plain: 0, verified: 1 });
  });

  it("owner while the run is still live → awaiting-terminal, no verification runs", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    const tool = createPipelineVerify(harness.config);
    const ctx = {
      session: harness.proxy.session,
      _ctx: { sessionManager: ownerManager() },
      ui: { notify: () => {} },
    };

    // Partial RuntimeCtx mock: `as never` is the established convention for
    // structural mocks (see tools/design-review-advance-entrypoints.test.ts).
    const result = await tool.execute({}, ctx as never) as Record<string, unknown>;
    expect(result).toMatchObject({ success: false, pending: true, action: "awaiting-terminal" });
    expect(harness.proxy.calls).toEqual({ plain: 0, verified: 0 });
  });
});

// ─── bound verify consumption (applyVerifyPass / applyVerifyFail) ───────────

const passSharedResult = {
  structuredResult: { failures: [] },
  ruleMissing: [],
  verifyResult: { structured: { passed: true }, llm: null as unknown, overallPassed: true },
};

function advCtx(h: Harness, sessionManager: unknown) {
  return {
    session: h.proxy.session,
    _ctx: { sessionManager },
    ui: { notify: () => {} },
  } as never;
}

describe("194 C5: bound verify pass is ONE atomic strict commit", () => {
  it("trusted completed run + pass → transition, consumption and wake marker in one verified write", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({
      stageExecutorRun: makeRun(undefined, {
        status: "completed",
        pendingWakeId: "wake-1",
        consecutiveFailures: 2,
        declaration: { declarationId: "decl-1", revision: 1, requestedBy: "stage_advance", nextStage: "review", needConfirm: false },
      }),
    }));

    const res = await applyVerifyPass(
      advCtx(harness, ownerManager()),
      harness.session.getMeta()!,
      "develop",
      "review",
      passSharedResult as never,
      { method: "tool", handleTerminal: true, returnResult: true } as never,
    );

    expect(res).toMatchObject({ success: true, passed: true });
    const persisted = harness.session.getMeta()!;
    expect(persisted.currentStage).toBe("review");
    expect(persisted.previousStage).toBe("develop");
    const run = persisted.stageExecutorRun!;
    expect(run.terminalConsumed).toBe(true);
    expect(run.consumption).toEqual({ state: "applied", declarationRevision: 1, resultKey: "run-1|1|develop->review" });
    // The wake has been acted on: the marker is cleared by the SAME commit.
    expect(run.pendingWakeId).toBeUndefined();
    // The legitimate new stage resets the failure budget.
    expect(run.consecutiveFailures).toBe(0);
    // ONE write total — no plain updateMeta involved.
    expect(harness.proxy.calls).toEqual({ plain: 0, verified: 1 });
  });

  it("owner evidence absent at the commit site → refused, NOTHING advanced (no plain fallback)", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun(undefined, { status: "completed" }) }));

    const res = await applyVerifyPass(
      advCtx(harness, {}), // no sessionManager → owner unprovable
      harness.session.getMeta()!,
      "develop",
      "review",
      passSharedResult as never,
      { method: "tool", handleTerminal: true, returnResult: true } as never,
    );

    expect(res).toMatchObject({ success: false, passed: true });
    expect((res as { message: string }).message).toContain("Bound stage exit refused (owner_unproven:session_file_unproven)");
    expect(harness.session.getMeta()!.currentStage).toBe("develop");
    expect(freshRun(harness)!.terminalConsumed).toBe(false);
    expect(harness.proxy.calls).toEqual({ plain: 0, verified: 0 });
  });

  it("no current run → legacy single plain write untouched", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta());

    const res = await applyVerifyPass(
      advCtx(harness, ownerManager()),
      harness.session.getMeta()!,
      "develop",
      "review",
      passSharedResult as never,
      { method: "tool", handleTerminal: true, returnResult: true } as never,
    );

    expect(res).toMatchObject({ success: true, passed: true });
    expect(harness.session.getMeta()!.currentStage).toBe("review");
    // The legacy single plain write runs UNTOUCHED (baseline d1ae498): one
    // plain updateMeta, no strict interface involved.
    expect(harness.proxy.calls).toEqual({ plain: 1, verified: 0 });
  });
});

describe("194 C5: bound verify failure records deduplicate the SAME result", () => {
  const failSharedResult = {
    structuredResult: { failures: [{ ruleType: "keywords", detail: "Missing keywords: done" }] },
    ruleMissing: [],
    verifyResult: null,
  };

  it("first failure persists once; the identical re-report is deduplicated with no second increment", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({
      stageExecutorRun: makeRun(undefined, { status: "completed", pendingWakeId: "wake-1" }),
    }));

    const first = await applyVerifyFail(
      advCtx(harness, ownerManager()),
      harness.session.getMeta()!,
      "develop",
      failSharedResult as never,
      "tool",
      undefined,
      harness.config,
    );
    expect(first.success).toBe(false);
    expect(harness.session.getMeta()!.verifyAttempts).toBe(1);
    // A failure does NOT consume: wake marker and pending state are kept.
    const afterFirst = freshRun(harness)!;
    expect(afterFirst.terminalConsumed).toBe(false);
    expect(afterFirst.pendingWakeId).toBe("wake-1");

    const second = await applyVerifyFail(
      advCtx(harness, ownerManager()),
      harness.session.getMeta()!,
      "develop",
      failSharedResult as never,
      "tool",
      undefined,
      harness.config,
    );
    expect(second.message).toContain("deduplicated");
    // Still ONE attempt, ONE verified write total.
    expect(harness.session.getMeta()!.verifyAttempts).toBe(1);
    expect(harness.proxy.calls.verified).toBe(1);
  });

  it("refused failure records nothing and reports honestly", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ stageExecutorRun: makeRun(undefined, { status: "completed" }) }));

    const res = await applyVerifyFail(
      advCtx(harness, {}),
      harness.session.getMeta()!,
      "develop",
      failSharedResult as never,
      "tool",
      undefined,
      harness.config,
    );
    expect(res.message).toContain("Bound failure record refused (owner_unproven:session_file_unproven)");
    expect(harness.session.getMeta()!.verifyAttempts ?? 0).toBe(0);
    expect(harness.proxy.calls).toEqual({ plain: 0, verified: 0 });
  });
});

// ─── pipeline_handoff tool entry (real factory.execute) ─────────────────────

function validSummary(h: Harness) {
  return {
    develop: { status: "valid", path: path.join(h.projectRoot, "develop.md"), hash: "" },
  };
}

describe("194 C5: pipeline_handoff consumes a bound run with ONE commit", () => {
  it("trusted completed run + handoff to completed → one verified write carrying visit + transition + consumption", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({
      summaries: validSummary(harness) as never,
      stageExecutorRun: makeRun(undefined, { status: "completed", pendingWakeId: "wake-1", consecutiveFailures: 1 }),
    }));

    const tool = createPipelineHandoff(harness.config);
    const ctx = {
      session: harness.proxy.session,
      _ctx: { sessionManager: ownerManager() },
      ui: { notify: () => {} },
    };
    const result = await tool.execute({ nextStage: "completed" }, ctx as never) as Record<string, unknown>;
    expect(result.success).toBe(true);

    const persisted = harness.session.getMeta()!;
    expect(persisted.currentStage).toBe("completed");
    expect(persisted.previousStage).toBe("develop");
    expect(persisted.contextFiles!.completed).toEqual([path.join(harness.projectRoot, "develop.md")]);
    const run = persisted.stageExecutorRun!;
    expect(run.terminalConsumed).toBe(true);
    expect(run.consumption).toMatchObject({ state: "applied", resultKey: "run-1|none|develop->completed" });
    expect(run.pendingWakeId).toBeUndefined();
    expect(run.consecutiveFailures).toBe(0);
    // ONE atomic verified commit — the legacy TWO plain updateMeta writes did NOT run.
    expect(harness.proxy.calls).toEqual({ plain: 0, verified: 1 });
  });

  it("owner evidence missing at the commit → refused, zero transition, zero dispatch", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({
      summaries: validSummary(harness) as never,
      stageExecutorRun: makeRun(undefined, { status: "completed" }),
    }));

    const tool = createPipelineHandoff(harness.config);
    const ctx = {
      session: harness.proxy.session,
      _ctx: { sessionManager: {} }, // no role evidence
      ui: { notify: () => {} },
    };
    const result = await tool.execute({ nextStage: "completed" }, ctx as never) as Record<string, unknown>;
    // The gate itself refuses unprovable identity BEFORE anything else.
    expect(result).toMatchObject({ action: "caller_refused", reason: "caller_identity_unproven" });
    expect(harness.session.getMeta()!.currentStage).toBe("develop");
    expect(freshRun(harness)!.terminalConsumed).toBe(false);
    expect(harness.proxy.calls).toEqual({ plain: 0, verified: 0 });
  });

  it("child calling the tool entry → caller_refused before any precondition", async () => {
    harness = await makeHarness();
    // Deliberately NO valid summary: refusal must happen even earlier than that.
    seed(harness, baseMeta({ stageExecutorRun: makeRun() }));
    const tool = createPipelineHandoff(harness.config);
    const ctx = {
      session: harness.proxy.session,
      _ctx: { sessionManager: childManager([bindingEntry(makeBinding())]) },
      ui: { notify: () => {} },
    };
    const result = await tool.execute({ nextStage: "review" }, ctx as never) as Record<string, unknown>;
    expect(result).toMatchObject({ success: false, action: "caller_refused", reason: "handoff_is_plugin_owned" });
    expect(harness.proxy.calls).toEqual({ plain: 0, verified: 0 });
  });

  it("no current run → the legacy two plain writes are untouched", async () => {
    harness = await makeHarness();
    seed(harness, baseMeta({ summaries: validSummary(harness) as never }));
    const tool = createPipelineHandoff(harness.config);
    const ctx = {
      session: harness.proxy.session,
      _ctx: { sessionManager: ownerManager() },
      ui: { notify: () => {} },
    };
    const result = await tool.execute({ nextStage: "completed" }, ctx as never) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(harness.session.getMeta()!.currentStage).toBe("completed");
    // The not-bound probe returns BEFORE any commit: the legacy two plain
    // writes run exactly as before, no strict interface involved.
    expect(harness.proxy.calls).toEqual({ plain: 2, verified: 0 });
    expect(harness.session.getMeta()!.stageExecutorRun).toBeUndefined();
  });
});
