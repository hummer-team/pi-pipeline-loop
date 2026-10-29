/**
 * 194 Phase 3 (C3, task 2): terminal lifecycle for closed-loop executor runs.
 *
 * Covers the plan matrix for `core/stage-executor-terminal.test.ts`:
 * completed-handoff + running develop, early/duplicate/late terminals,
 * commit conflicts, conditional spawn cleanup and the child-side binding
 * record from runtime evidence. The strict commit runs through the REAL
 * createSessionState adapter (temp-dir shared store), the same way the
 * Phase 0 commit tests do.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createSessionState, __resetSharedStateDir } from "../../core/session-state";
import {
  issueExecutorRunOnDispatch,
  applyExecutorTerminal,
  isHandoffReceiptFinal,
  deriveExecutorStage,
} from "../../core/stage-executor/terminal";
import { recordChildBindingFromRuntimeEvidence } from "../../core/stage-executor/runtime-binding";
import type {
  DesignReviewState,
  PipelineConfig,
  SessionMeta,
  SpawnOperationContext,
  StageExecutorBinding,
  StageExecutorRun,
} from "../../types";
import { makeMockSessionManager } from "../helpers";

const AGENT = "01a11bbb-c3b4-72bc-9397-4f5b9881be41";
const OWNER_FILE = "/sessions/owner.jsonl";
const CHILD_FILE = "/sessions/child.jsonl";
const VISIT = 1_700_000_000_000;

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const PREV_MANAGER = (globalThis as Record<symbol, unknown>)[MANAGER_KEY];

/** Install a registry mock; `null` removes it. */
function withManager(mock: unknown): void {
  if (mock === undefined || mock === null) {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    return;
  }
  (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = mock;
}

function makeOc(overrides?: Partial<SpawnOperationContext>): SpawnOperationContext {
  return {
    pipelineId: "pipe-exec-1",
    authorizationId: "auth-1",
    round: 1,
    kind: "develop-handoff",
    operationId: "op-1",
    stageVisitId: VISIT,
    runId: "run-1",
    ...overrides,
  };
}

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
    previousStage: "design-review",
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

interface RealAdapter {
  session: ReturnType<typeof createSessionState>;
  entries: unknown[];
  breakAppend: () => void;
  config: PipelineConfig;
  cleanup: () => void;
}

function makeRealAdapter(maxLoopCycles?: number): RealAdapter {
  const projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-exec-terminal-"));
  const auditDir = ".pi/audit";
  const entries: unknown[] = [];
  let appendBroken = false;
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      if (appendBroken) throw new Error("append_entry_simulated_failure");
      entries.push({ type: "custom", customType, data });
    },
  };
  const session = createSessionState(pi as never, { sessionManager: makeMockSessionManager(entries) } as never, {
    projectRoot,
    auditDir,
  });
  const config = {
    projectRoot,
    stages: {},
    auditDir,
    ...(maxLoopCycles !== undefined ? { maxLoopCycles } : {}),
  } as unknown as PipelineConfig;
  return {
    session,
    entries,
    breakAppend: () => { appendBroken = true; },
    config,
    cleanup: () => {
      __resetSharedStateDir();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

let adapter: RealAdapter | undefined;
afterEach(() => {
  adapter?.cleanup();
  adapter = undefined;
  withManager(null);
});

// Seed the local + shared meta through the real adapter's own writer.
function seedMeta(meta: SessionMeta): void {
  const a = adapter!;
  a.session.updateMeta(meta);
  // Sanity: the shared read-back must see the seeded pipeline.
  const read = a.session.getMeta();
  if (read?.pipelineId !== meta.pipelineId) {
    throw new Error("seed failed: shared store did not adopt the meta");
  }
}

// ─── run establishment at trusted dispatch ──────────────────────────────────

describe("194 Phase 3 (C3): trusted dispatch establishes the run", () => {
  it("persists a running run with registry-folded session evidence", async () => {
    adapter = makeRealAdapter();
    withManager({
      getRecord: (id: string) => (id === AGENT ? { status: "running", sessionFile: CHILD_FILE } : undefined),
    });
    seedMeta(baseMeta());

    const res = await issueExecutorRunOnDispatch({
      session: adapter.session,
      config: adapter.config,
      identity: { ownerSessionFile: OWNER_FILE, agentId: AGENT, operationContext: makeOc() },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.duplicate).toBe(false);
    expect(res.run.status).toBe("running");
    expect(res.run.binding.runId).toBe("run-1"); // pre-issued runId is kept
    expect(res.run.binding.executorSessionFile).toBe(CHILD_FILE);

    const persisted = adapter.session.getMeta()!.stageExecutorRun;
    expect(persisted?.binding.agentId).toBe(AGENT);
    expect(persisted?.terminalConsumed).toBe(false);
  });

  it("re-asserting the SAME trusted identity is a duplicate echo (no second run)", async () => {
    adapter = makeRealAdapter();
    seedMeta(baseMeta({ stageExecutorRun: makeRun() }));
    const before = adapter.entries.length;

    const res = await issueExecutorRunOnDispatch({
      session: adapter.session,
      config: adapter.config,
      identity: { ownerSessionFile: OWNER_FILE, agentId: AGENT, operationContext: makeOc() },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.duplicate).toBe(true);
    expect(adapter.entries.length).toBe(before);
  });

  it("supersedes a same-visit retry with the INHERITED failure budget", async () => {
    adapter = makeRealAdapter();
    const prior = makeRun({ runId: "run-old", agentId: "old-agent" }, {
      status: "failed", recovery: "awaiting-owner", consecutiveFailures: 2,
    });
    seedMeta(baseMeta({ stageExecutorRun: prior }));

    const res = await issueExecutorRunOnDispatch({
      session: adapter.session,
      config: adapter.config,
      identity: { ownerSessionFile: OWNER_FILE, agentId: AGENT, operationContext: makeOc({ runId: "run-2" }) },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.run.consecutiveFailures).toBe(2); // budget carries across attempts
    expect(res.run.status).toBe("running");
    expect(adapter.session.getMeta()!.stageExecutorRun!.binding.runId).toBe("run-2");
  });

  it("refuses a further run once the same-visit budget is exhausted", async () => {
    adapter = makeRealAdapter(3);
    const prior = makeRun({ runId: "run-old" }, {
      status: "failed", recovery: "budget-exhausted", consecutiveFailures: 3,
    });
    seedMeta(baseMeta({ stageExecutorRun: prior }));

    const res = await issueExecutorRunOnDispatch({
      session: adapter.session,
      config: adapter.config,
      identity: { ownerSessionFile: OWNER_FILE, agentId: AGENT, operationContext: makeOc({ runId: "run-4" }) },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("budget_exhausted_same_visit");
    // Zero mutation: the exhausted prior record stands untouched.
    expect(adapter.session.getMeta()!.stageExecutorRun!.binding.runId).toBe("run-old");
  });

  it("rejects a foreign pipeline identity without writing", async () => {
    adapter = makeRealAdapter();
    seedMeta(baseMeta());
    const res = await issueExecutorRunOnDispatch({
      session: adapter.session,
      config: adapter.config,
      identity: { ownerSessionFile: OWNER_FILE, agentId: AGENT, operationContext: makeOc({ pipelineId: "pipe-other" }) },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("pipeline_mismatch");
    expect(adapter.session.getMeta()!.stageExecutorRun).toBeUndefined();
  });

  it("an append failure makes the run issue honest-fail (no phantom run)", async () => {
    adapter = makeRealAdapter();
    seedMeta(baseMeta());
    adapter.breakAppend();
    const res = await issueExecutorRunOnDispatch({
      session: adapter.session,
      config: adapter.config,
      identity: { ownerSessionFile: OWNER_FILE, agentId: AGENT, operationContext: makeOc() },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("unavailable");
  });
});

// ─── terminal application: identity / duplicate / late matrix ───────────────

describe("194 Phase 3 (C3): terminal identity and dedup", () => {
  it("completed terminal persists status + clears the matched spawn entry", async () => {
    adapter = makeRealAdapter();
    seedMeta(baseMeta({
      stageExecutorRun: makeRun(),
      activeSpawns: { develop: { agentName: "develop-agent", agentId: AGENT, startedAt: VISIT, operationContext: makeOc() } },
    }));

    const res = await applyExecutorTerminal({
      session: adapter.session,
      config: adapter.config,
      evt: { event: "completed", agentId: AGENT, operationContext: makeOc() },
    });
    expect(res.action).toBe("applied");
    if (res.action !== "applied") return;
    expect(res.run.status).toBe("completed");
    expect(res.run.terminalConsumed).toBe(false);
    // conditional cleanup ran against the CURRENT entry:
    expect(adapter.session.getMeta()!.activeSpawns?.develop).toBeUndefined();
  });

  it("a foreign full agentId is a LATE event: zero mutation, no spawn clear", async () => {
    adapter = makeRealAdapter();
    seedMeta(baseMeta({
      stageExecutorRun: makeRun(),
      activeSpawns: { develop: { agentName: "develop-agent", agentId: "spawn-new", startedAt: VISIT } },
    }));

    const res = await applyExecutorTerminal({
      session: adapter.session,
      config: adapter.config,
      evt: { event: "completed", agentId: "0zzzzzzz-0000-0000-0000-000000000000", operationContext: makeOc() },
    });
    expect(res.action).toBe("late_ignored");
    const after = adapter.session.getMeta()!;
    expect(after.stageExecutorRun!.status).toBe("running");
    // A superseded listener must never wipe the CURRENT spawn record:
    expect(after.activeSpawns?.develop?.agentId).toBe("spawn-new");
  });

  it("a superseded runId on the event never touches the current run", async () => {
    adapter = makeRealAdapter();
    seedMeta(baseMeta({ stageExecutorRun: makeRun() }));
    const res = await applyExecutorTerminal({
      session: adapter.session,
      config: adapter.config,
      evt: { event: "completed", agentId: AGENT, operationContext: makeOc({ runId: "run-dead" }) },
    });
    expect(res.action).toBe("late_ignored");
    expect(adapter.session.getMeta()!.stageExecutorRun!.status).toBe("running");
  });

  it("a second terminal of an already-terminal run is duplicate_ignored (no recount)", async () => {
    adapter = makeRealAdapter();
    seedMeta(baseMeta({
      stageExecutorRun: makeRun({}, { status: "completed", consumption: { state: "awaiting-declaration", resultKey: "run-1|none|op-1|completed" } }),
    }));
    const before = adapter.entries.length;

    const res = await applyExecutorTerminal({
      session: adapter.session,
      config: adapter.config,
      evt: { event: "completed", agentId: AGENT, operationContext: makeOc() },
    });
    expect(res.action).toBe("duplicate_ignored");
    expect(adapter.entries.length).toBe(before);
  });

  it("without a run the terminal is a pure no-op for legacy operations", async () => {
    adapter = makeRealAdapter();
    seedMeta(baseMeta());
    const res = await applyExecutorTerminal({
      session: adapter.session,
      config: adapter.config,
      evt: { event: "failed", agentId: AGENT, operationContext: makeOc() },
    });
    expect(res.action).toBe("no_run");
    expect(adapter.session.getMeta()!.stageExecutorRun).toBeUndefined();
  });

  it("a commit conflict keeps the spawn entry and reports commit_failed", async () => {
    adapter = makeRealAdapter();
    seedMeta(baseMeta({
      stageExecutorRun: makeRun(),
      activeSpawns: { develop: { agentName: "develop-agent", agentId: AGENT, startedAt: VISIT, operationContext: makeOc() } },
    }));
    adapter.breakAppend();

    const res = await applyExecutorTerminal({
      session: adapter.session,
      config: adapter.config,
      evt: { event: "completed", agentId: AGENT, operationContext: makeOc() },
    });
    expect(res.action).toBe("commit_failed");
    // Reliable-save-first ordering: no cleanup after a failed persist.
    expect(adapter.session.getMeta()!.activeSpawns?.develop).toBeDefined();
    expect(adapter.session.getMeta()!.stageExecutorRun!.status).toBe("running");
  });
});

// ─── failure counting + budget ──────────────────────────────────────────────

describe("194 Phase 3 (rule 6): failure counting and budget on the run", () => {
  it("first failed terminal counts once and pauses for the owner", async () => {
    adapter = makeRealAdapter(3);
    seedMeta(baseMeta({ stageExecutorRun: makeRun() }));
    const res = await applyExecutorTerminal({
      session: adapter.session,
      config: adapter.config,
      evt: { event: "failed", agentId: AGENT, operationContext: makeOc() },
    });
    expect(res.action).toBe("applied");
    if (res.action !== "applied") return;
    expect(res.run.consecutiveFailures).toBe(1);
    expect(res.run.recovery).toBe("awaiting-owner");
    expect(res.budgetExhausted).toBe(false);
    // The resultKey records the consumed result for cross-path dedup.
    expect(res.run.consumption?.resultKey).toContain("run-1");
  });

  it("the third failure flips recovery to budget-exhausted (no fourth)", async () => {
    adapter = makeRealAdapter(3);
    seedMeta(baseMeta({
      stageExecutorRun: makeRun({}, { status: "running", consecutiveFailures: 2, recovery: "awaiting-owner" }),
    }));
    const res = await applyExecutorTerminal({
      session: adapter.session,
      config: adapter.config,
      evt: { event: "failed", agentId: AGENT, operationContext: makeOc() },
    });
    expect(res.action).toBe("applied");
    if (res.action !== "applied") return;
    expect(res.budgetExhausted).toBe(true);
    expect(res.run.recovery).toBe("budget-exhausted");
    expect(res.run.consecutiveFailures).toBe(3);
  });

  it("completed never touches the failure budget", async () => {
    adapter = makeRealAdapter(3);
    seedMeta(baseMeta({
      stageExecutorRun: makeRun({}, { consecutiveFailures: 1, recovery: "awaiting-owner" }),
    }));
    const res = await applyExecutorTerminal({
      session: adapter.session,
      config: adapter.config,
      evt: { event: "completed", agentId: AGENT, operationContext: makeOc() },
    });
    expect(res.action).toBe("applied");
    if (res.action !== "applied") return;
    expect(res.run.consecutiveFailures).toBe(1); // never decremented
    expect(res.run.status).toBe("completed");
  });

  it("a stored declaration routes the waiting state to the owner tool", async () => {
    adapter = makeRealAdapter();
    seedMeta(baseMeta({
      stageExecutorRun: makeRun({}, {
        declaration: { declarationId: "d-1", revision: 2, requestedBy: "stage_advance", nextStage: "review", needConfirm: false },
      }),
    }));
    const res = await applyExecutorTerminal({
      session: adapter.session,
      config: adapter.config,
      evt: { event: "completed", agentId: AGENT, operationContext: makeOc() },
    });
    expect(res.action).toBe("applied");
    if (res.action !== "applied") return;
    expect(res.run.consumption?.state).toBe("awaiting-owner-tool");
    expect(res.run.consumption?.declarationRevision).toBeUndefined(); // terminal sets state; revision bound later (Part 3)
  });
});

// ─── handoff-receipt finality + routing helpers ─────────────────────────────

describe("194 Phase 3 (C3): handoff receipt is terminal-proof", () => {
  const finished = (opPatch?: Partial<DesignReviewState["operation"]>): DesignReviewState => ({
    pipelineId: "pipe-exec-1",
    authorizationId: "auth-1",
    round: 1,
    phase: "finished",
    planDoc: "/p/plan.md",
    reportDoc: "/p/review-design-1-plan.md",
    updatedAt: 10,
    operation: {
      operationId: "op-1",
      kind: "develop-handoff",
      stageVisitId: VISIT,
      dispatchState: "completed",
      dispatchEvidence: "trusted_id",
      agentId: AGENT,
      settledAt: 9,
      ...opPatch,
    },
  } as unknown as DesignReviewState);

  it("finished + trusted completed receipt → final", () => {
    expect(isHandoffReceiptFinal(finished())).toBe(true);
  });
  it("not finished yet → not final (192 writeback still governs)", () => {
    expect(isHandoffReceiptFinal({ ...finished(), phase: "pass_ready" } as DesignReviewState)).toBe(false);
  });
  it("untrusted or non-handoff receipt → not final", () => {
    expect(isHandoffReceiptFinal(finished({ dispatchEvidence: "unknown" }))).toBe(false);
    expect(isHandoffReceiptFinal(finished({ kind: "review" }))).toBe(false);
  });
  it("no state / no operation → not final", () => {
    expect(isHandoffReceiptFinal(undefined)).toBe(false);
    expect(isHandoffReceiptFinal({ ...finished(), operation: undefined } as DesignReviewState)).toBe(false);
  });

  it("deriveExecutorStage maps kinds to the closed-loop stage set", () => {
    expect(deriveExecutorStage("review")).toBe("design-review");
    expect(deriveExecutorStage("update")).toBe("plan");
    expect(deriveExecutorStage("develop-handoff")).toBe("develop");
  });
});

// ─── child-side binding record from runtime evidence ────────────────────────

describe("194 Phase 3 (C3): JOINed child records its own binding", () => {
  interface Writer { appendEntry: (t: string, d: unknown) => void }
  const writerWith = (sink: Array<{ t: string; d: unknown }>): Writer => ({
    appendEntry: (t, d) => sink.push({ t, d }),
  });

  it("records when the run provably belongs to this child", () => {
    const sink: Array<{ t: string; d: unknown }> = [];
    const res = recordChildBindingFromRuntimeEvidence({
      writer: writerWith(sink),
      entries: [],
      parentSession: OWNER_FILE,
      ownSessionFile: CHILD_FILE,
      currentRun: makeRun(),
    });
    expect(res.recorded).toBe(true);
    expect(sink[0]!.t).toBe("pi-pipeline:executor-binding");
    expect((sink[0]!.d as StageExecutorBinding).runId).toBe("run-1");
  });

  it("a run bound to ANOTHER owner is refused", () => {
    const sink: Array<{ t: string; d: unknown }> = [];
    const res = recordChildBindingFromRuntimeEvidence({
      writer: writerWith(sink),
      entries: [],
      parentSession: "/sessions/other-owner.jsonl",
      ownSessionFile: CHILD_FILE,
      currentRun: makeRun(),
    });
    expect(res.recorded).toBe(false);
    expect(res.reason).toBe("owner_session_mismatch");
    expect(sink.length).toBe(0);
  });

  it("no registry-folded session file → unproven, nothing recorded", () => {
    const sink: Array<{ t: string; d: unknown }> = [];
    const run = makeRun({ executorSessionFile: undefined });
    delete (run.binding as { executorSessionFile?: string }).executorSessionFile;
    const res = recordChildBindingFromRuntimeEvidence({
      writer: writerWith(sink),
      entries: [],
      parentSession: OWNER_FILE,
      ownSessionFile: CHILD_FILE,
      currentRun: run,
    });
    expect(res.recorded).toBe(false);
    expect(res.reason).toBe("executor_session_file_unproven");
  });

  it("idempotent: an already-recorded run never appends twice", () => {
    const sink: Array<{ t: string; d: unknown }> = [];
    const first = recordChildBindingFromRuntimeEvidence({
      writer: writerWith(sink), entries: [], parentSession: OWNER_FILE, ownSessionFile: CHILD_FILE, currentRun: makeRun(),
    });
    expect(first.recorded).toBe(true);
    const entries = [{ type: "custom", customType: "pi-pipeline:executor-binding", data: makeBinding() }];
    const second = recordChildBindingFromRuntimeEvidence({
      writer: writerWith(sink), entries, parentSession: OWNER_FILE, ownSessionFile: CHILD_FILE, currentRun: makeRun(),
    });
    expect(second.recorded).toBe(false);
    expect(second.reason).toBe("already_recorded");
    expect(sink.length).toBe(1);
  });
});

  it("Phase 0 (195_Bug): maxLoopCycles=99 still flips budget-exhausted on 4th failure (decoupled from config.maxLoopCycles)", async () => {
    adapter = makeRealAdapter(99); // Set config.maxLoopCycles to 99
    seedMeta(baseMeta({
      stageExecutorRun: makeRun({}, { status: "running", consecutiveFailures: 2, recovery: "awaiting-owner" }),
    }));
    const res = await applyExecutorTerminal({
      session: adapter.session,
      config: adapter.config,
      evt: { event: "failed", agentId: AGENT, operationContext: makeOc() },
    });
    expect(res.action).toBe("applied");
    if (res.action !== "applied") return;
    // budgetLimitOf now returns DEFAULT_EXECUTOR_FAILURE_BUDGET (3), not config.maxLoopCycles
    expect(res.budgetExhausted).toBe(true);
    expect(res.run.recovery).toBe("budget-exhausted");
    expect(res.run.consecutiveFailures).toBe(3);
  });
