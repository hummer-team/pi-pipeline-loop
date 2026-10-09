/**
 * 194 Phase 0 (C3/C5): bounded executor identity, runtime evidence and pure
 * run-state rule tests.
 *
 * Covers: binding narrowing, short-id collisions and missing registry
 * evidence (fail-closed), own-binding recording vs a parent JOIN snapshot,
 * caller-role matrix, declaration merge rules, terminal/duplicate/failure
 * budget and wake deduplication.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  isStageExecutorStage,
  type StageExecutorBinding,
  type StageExecutorRun,
} from "../../core/stage-executor/contracts";
import {
  applyTerminalStatus,
  bindingMatchesCurrent,
  computeResultKey,
  mergeDeclaration,
  resetFailureBudget,
  sameBinding,
  shouldIssueOwnerWake,
  takePendingWake,
} from "../../core/stage-executor/run-state";
import {
  EXECUTOR_BINDING_ENTRY_TYPE,
  narrowStageExecutorBinding,
  readOwnExecutorBinding,
  recordExecutorBinding,
  resolveExecutorCallerRole,
} from "../../core/stage-executor/runtime-binding";
import {
  probeAgentSessionEvidence,
  toExecutorTerminalStatus,
} from "../../utils/subagents-introspect";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
const PREV_MANAGER = (globalThis as Record<symbol, unknown>)[MANAGER_KEY];

function withManager(mock: unknown): void {
  (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = mock;
}

const BINDING: StageExecutorBinding = {
  runId: "run-1",
  pipelineId: "pipe-1",
  ownerSessionFile: "/sessions/owner.jsonl",
  stage: "develop",
  stageVisitId: 1_700_000_000_000,
  operationId: "op-1",
  agentId: "01a11bbb-c3b4-72bc-9397-4f5b9881be41",
};

function makeRun(overrides?: Partial<StageExecutorRun>): StageExecutorRun {
  return {
    binding: BINDING,
    status: "running",
    recovery: "none",
    consecutiveFailures: 0,
    terminalConsumed: false,
    ...overrides,
  };
}

afterEach(() => {
  if (PREV_MANAGER === undefined) delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
  else (globalThis as Record<symbol, unknown>)[MANAGER_KEY] = PREV_MANAGER;
});

describe("194 Phase 0 C3: binding narrowing", () => {
  it("accepts a complete closed-loop binding and preserves optional evidence", () => {
    const res = narrowStageExecutorBinding({ ...BINDING, executorSessionFile: "/sessions/child.jsonl" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.binding.executorSessionFile).toBe("/sessions/child.jsonl");
  });

  it("rejects every incomplete identity component (no partial trust)", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...BINDING, runId: "" }, "binding_missing_run_id"],
      [{ ...BINDING, runId: 42 }, "binding_missing_run_id"],
      [{ ...BINDING, pipelineId: " " }, "binding_missing_pipeline_id"],
      [{ ...BINDING, ownerSessionFile: undefined }, "binding_missing_owner_session_file"],
      [{ ...BINDING, stage: "review" }, "binding_stage_out_of_scope"],
      [{ ...BINDING, stage: "clarify" }, "binding_stage_out_of_scope"],
      [{ ...BINDING, stageVisitId: 0 }, "binding_visit_id_invalid"],
      [{ ...BINDING, stageVisitId: Number.NaN }, "binding_visit_id_invalid"],
      [{ ...BINDING, stageVisitId: "1700000000000" }, "binding_visit_id_invalid"],
      [{ ...BINDING, operationId: undefined }, "binding_missing_operation_id"],
      [{ ...BINDING, agentId: "" }, "binding_missing_agent_id"],
      [{ ...BINDING, executorSessionFile: 7 }, "binding_executor_session_file_malformed"],
    ];
    for (const [input, reason] of cases) {
      expect(narrowStageExecutorBinding(input)).toEqual({ ok: false, reason });
    }
    for (const bad of [null, undefined, "run", 42, []]) {
      expect(narrowStageExecutorBinding(bad)).toEqual({ ok: false, reason: "binding_not_object" });
    }
  });

  it("scopes the executor run to the closed-loop stages only", () => {
    expect(isStageExecutorStage("design-review")).toBe(true);
    expect(isStageExecutorStage("plan")).toBe(true);
    expect(isStageExecutorStage("develop")).toBe(true);
    expect(isStageExecutorStage("review")).toBe(false);
    expect(isStageExecutorStage("fix")).toBe(false);
    expect(isStageExecutorStage(undefined)).toBe(false);
  });

  it("sameBinding requires EVERY component incl. the full agent id", () => {
    expect(sameBinding(BINDING, { ...BINDING })).toBe(true);
    expect(bindingMatchesCurrent(makeRun(), { ...BINDING })).toBe(true);
    expect(bindingMatchesCurrent(makeRun(), { ...BINDING, agentId: "01a11bbb" })).toBe(false);
    expect(bindingMatchesCurrent(makeRun(), { ...BINDING, runId: "run-2" })).toBe(false);
    expect(bindingMatchesCurrent(makeRun(), { ...BINDING, stageVisitId: BINDING.stageVisitId + 1 })).toBe(false);
    expect(bindingMatchesCurrent(undefined, BINDING)).toBe(false);
  });
});

describe("194 Phase 0 C3: registry evidence probe (short-id collisions, missing evidence)", () => {
  it("returns sessionFile + status ONLY for the exact full id", () => {
    withManager({
      getRecord: (id: string) =>
        id === BINDING.agentId ? { status: "running", sessionFile: "/sessions/child.jsonl" } : undefined,
      listRecords: () => [{ id: BINDING.agentId, status: "running" }],
    });
    const evidence = probeAgentSessionEvidence(BINDING.agentId);
    expect(evidence).toEqual({
      agentId: BINDING.agentId,
      found: true,
      status: "live",
      recordStatus: "running",
      sessionFile: "/sessions/child.jsonl",
      ambiguous: false,
    });
    expect(toExecutorTerminalStatus(evidence.recordStatus)).toBe("running");
  });

  it("a SHORT id that collides across agents is never authority", () => {
    // Two live records whose ids share the queried prefix; only the FULL ids
    // resolve via getRecord, so a short id answers found:false.
    withManager({
      getRecord: (id: string) => (id.length > 8 ? { status: "running" } : undefined),
      listRecords: () => [
        { id: "01a11bbb-c3b4-72bc-9397-4f54b23e81c6", status: "running" },
        { id: "01a11bbb-c3b4-0000-0000-000000000000", status: "running" },
      ],
    });
    const short = probeAgentSessionEvidence("01a11bbb");
    expect(short.found).toBe(false);
    expect(short.status).toBe("unknown");
    expect(short.sessionFile).toBeUndefined();
  });

  it("an id enumerating more than once is ambiguous and loses evidence", () => {
    withManager({
      getRecord: () => ({ status: "running", sessionFile: "/sessions/dup.jsonl" }),
      listRecords: () => [
        { id: BINDING.agentId, status: "running" },
        { id: BINDING.agentId, status: "running" },
      ],
    });
    const evidence = probeAgentSessionEvidence(BINDING.agentId);
    expect(evidence.ambiguous).toBe(true);
    expect(evidence.status).toBe("unknown");
    expect(evidence.sessionFile).toBeUndefined();
  });

  it("missing registry / no sessionFile / empty id all mean ABSENT evidence", () => {
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    expect(probeAgentSessionEvidence(BINDING.agentId).status).toBe("unknown");
    expect(probeAgentSessionEvidence("").found).toBe(false);

    withManager({ getRecord: () => ({ status: "completed" }) });
    const noFile = probeAgentSessionEvidence(BINDING.agentId);
    expect(noFile.found).toBe(true);
    expect(noFile.status).toBe("settled");
    expect(noFile.sessionFile).toBeUndefined();
    expect(toExecutorTerminalStatus("completed")).toBe("completed");
    expect(toExecutorTerminalStatus("error")).toBe("failed");
    expect(toExecutorTerminalStatus("aborted")).toBe("aborted");
    expect(toExecutorTerminalStatus("stopped")).toBe("aborted");
    expect(toExecutorTerminalStatus("steered")).toBe("running");
    expect(toExecutorTerminalStatus(undefined)).toBe("unknown");
    expect(toExecutorTerminalStatus("something-new")).toBe("unknown");
  });

  it("a throwing registry probe degrades to unknown instead of crashing the caller", () => {
    withManager({ getRecord: () => { throw new Error("registry drift"); } });
    expect(probeAgentSessionEvidence(BINDING.agentId).status).toBe("unknown");
  });
});

describe("194 Phase 0 C3: own-binding entry recording (JOIN never refreshes identity)", () => {
  function makeWriter() {
    const appended: Array<{ customType: string; data: unknown }> = [];
    return {
      writer: { appendEntry: (customType: string, data: unknown) => { appended.push({ customType, data }); } },
      appended,
    };
  }

  it("records the first trusted binding and is idempotent per run", () => {
    const { writer, appended } = makeWriter();
    const first = recordExecutorBinding(writer, BINDING, []);
    expect(first.recorded).toBe(true);
    expect(appended[0].customType).toBe(EXECUTOR_BINDING_ENTRY_TYPE);

    const entries = [{ type: "custom", customType: EXECUTOR_BINDING_ENTRY_TYPE, data: BINDING }];
    expect(recordExecutorBinding(writer, BINDING, entries)).toEqual({ recorded: false, reason: "already_recorded" });
    expect(appended).toHaveLength(1);
  });

  it("refuses to overwrite its own identity with a different run", () => {
    const { writer, appended } = makeWriter();
    const entries = [{ type: "custom", customType: EXECUTOR_BINDING_ENTRY_TYPE, data: BINDING }];
    const res = recordExecutorBinding(writer, { ...BINDING, runId: "run-2" }, entries);
    expect(res).toEqual({ recorded: false, reason: "identity_frozen_by_earlier_run" });
    expect(appended).toHaveLength(0);
  });

  it("rejects an incomplete binding candidate without appending", () => {
    const { writer, appended } = makeWriter();
    const res = recordExecutorBinding(writer, { ...BINDING, stage: "review" } as unknown as StageExecutorBinding, []);
    expect(res.recorded).toBe(false);
    expect(appended).toHaveLength(0);
  });

  it("reads only its OWN entries (latest wins) and skips malformed ones", () => {
    const entries = [
      { type: "custom", customType: EXECUTOR_BINDING_ENTRY_TYPE, data: { runId: "nope" } },
      { type: "custom", customType: "pi-pipeline:meta", data: BINDING },
      { type: "custom", customType: EXECUTOR_BINDING_ENTRY_TYPE, data: BINDING },
      { type: "custom", customType: EXECUTOR_BINDING_ENTRY_TYPE, data: { ...BINDING, runId: "run-newer" } },
    ];
    const own = readOwnExecutorBinding(entries);
    expect(own?.runId).toBe("run-newer");
    expect(readOwnExecutorBinding([{ type: "custom", customType: EXECUTOR_BINDING_ENTRY_TYPE, data: null }])).toBeNull();
    expect(readOwnExecutorBinding([])).toBeNull();
  });
});

describe("194 Phase 0 C4/C5: caller role resolution is evidence-only", () => {
  const run = makeRun({ binding: { ...BINDING, executorSessionFile: "/sessions/child.jsonl" } });

  it("proves the owner from its own session file", () => {
    expect(resolveExecutorCallerRole({
      currentRun: run,
      callerSessionFile: "/sessions/owner.jsonl",
      callerIsChild: false,
      ownBinding: null,
    })).toBe("owner-current");
  });

  it("proves the current child from its own recorded binding", () => {
    expect(resolveExecutorCallerRole({
      currentRun: run,
      callerSessionFile: "/sessions/child.jsonl",
      callerIsChild: true,
      ownBinding: BINDING,
    })).toBe("child-current");
  });

  it("a stale child (older run) is refused, never inherited", () => {
    expect(resolveExecutorCallerRole({
      currentRun: run,
      callerSessionFile: "/sessions/old-child.jsonl",
      callerIsChild: true,
      ownBinding: { ...BINDING, runId: "run-0" },
    })).toBe("child-stale");
  });

  it("contradictory session-file evidence is stale, not current", () => {
    expect(resolveExecutorCallerRole({
      currentRun: run,
      callerSessionFile: "/sessions/child.jsonl",
      callerIsChild: true,
      ownBinding: { ...BINDING, executorSessionFile: "/sessions/other.jsonl" },
    })).toBe("child-stale");
  });

  it("incomplete identity is unknown (no role fail-open)", () => {
    const base = { callerIsChild: true, ownBinding: null as StageExecutorBinding | null };
    expect(resolveExecutorCallerRole({ ...base, currentRun: run, callerSessionFile: null })).toBe("unknown");
    expect(resolveExecutorCallerRole({ ...base, currentRun: run, callerSessionFile: "/sessions/x.jsonl" })).toBe("unknown");
    expect(resolveExecutorCallerRole({ ...base, currentRun: undefined, callerSessionFile: "/sessions/x.jsonl" })).toBe("unknown");
    expect(resolveExecutorCallerRole({
      currentRun: run, callerSessionFile: "/sessions/not-the-owner.jsonl", callerIsChild: false, ownBinding: null,
    })).toBe("unknown");
  });
});

describe("194 Phase 0 C5: declaration merge rules", () => {
  let seq = 0;
  const issue = (): string => `decl-${++seq}`;

  it("first request opens revision 1 with a plugin-issued id", () => {
    const { declaration, revisionChanged } = mergeDeclaration(undefined, {
      requestedBy: "stage_advance",
      isRealStageAdvanceCall: true,
      nextStage: "review",
      needConfirmProvided: false,
    }, issue);
    expect(revisionChanged).toBe(true);
    expect(declaration.revision).toBe(1);
    expect(declaration.declarationId).toBe("decl-1");
    expect(declaration.nextStage).toBe("review");
    // A REAL stage_advance call omitting needConfirm normalizes to false.
    expect(declaration.needConfirm).toBe(false);
  });

  it("advance then verify merges verification only and keeps the intent", () => {
    const first = mergeDeclaration(undefined, {
      requestedBy: "stage_advance", isRealStageAdvanceCall: true, nextStage: "review", needConfirmProvided: true, needConfirm: true,
    }, issue).declaration;
    const merged = mergeDeclaration(first, {
      requestedBy: "pipeline_verify", isRealStageAdvanceCall: false, verificationRequested: true,
    }, issue);
    expect(merged.revisionChanged).toBe(false);
    expect(merged.declaration.revision).toBe(1);
    expect(merged.declaration.verificationRequested).toBe(true);
    expect(merged.declaration.nextStage).toBe("review");
    expect(merged.declaration.needConfirm).toBe(true);
  });

  it("verify then advance completes the intent and bumps the revision", () => {
    const first = mergeDeclaration(undefined, {
      requestedBy: "pipeline_verify", isRealStageAdvanceCall: false, verificationRequested: true,
    }, issue).declaration;
    expect(first.nextStage).toBeUndefined();
    const merged = mergeDeclaration(first, {
      requestedBy: "stage_advance", isRealStageAdvanceCall: true, nextStage: "develop", needConfirmProvided: true, needConfirm: true,
    }, issue);
    expect(merged.revisionChanged).toBe(true);
    expect(merged.declaration.revision).toBe(2);
    expect(merged.declaration.requestedBy).toBe("stage_advance");
    expect(merged.declaration.verificationRequested).toBe(true);
    expect(merged.declaration.nextStage).toBe("develop");
    expect(merged.declaration.needConfirm).toBe(true);
  });

  it("identical requests change nothing (no revision, no wake)", () => {
    const first = mergeDeclaration(undefined, {
      requestedBy: "stage_advance", isRealStageAdvanceCall: true, nextStage: "review", needConfirmProvided: true, needConfirm: true,
    }, issue).declaration;
    const again = mergeDeclaration(first, {
      requestedBy: "stage_advance", isRealStageAdvanceCall: true, nextStage: "review", needConfirmProvided: true, needConfirm: true,
    }, issue);
    expect(again).toEqual({ declaration: first, revisionChanged: false });
  });

  it("an owner relay never downgrades a stored needConfirm=true", () => {
    const stored = mergeDeclaration(undefined, {
      requestedBy: "stage_advance", isRealStageAdvanceCall: true, nextStage: "review", needConfirmProvided: true, needConfirm: true,
    }, issue).declaration;
    const relay = mergeDeclaration(stored, {
      requestedBy: "pipeline_verify", isRealStageAdvanceCall: false, verificationRequested: true,
    }, issue);
    expect(relay.declaration.needConfirm).toBe(true);
    expect(relay.declaration.nextStage).toBe("review");
  });

  it("a changed completion intent bumps the revision", () => {
    const stored = mergeDeclaration(undefined, {
      requestedBy: "stage_advance", isRealStageAdvanceCall: true, nextStage: "review", needConfirmProvided: false,
    }, issue).declaration;
    const next = mergeDeclaration(stored, {
      requestedBy: "stage_advance", isRealStageAdvanceCall: true, nextStage: "completed", needConfirmProvided: false,
    }, issue);
    expect(next.revisionChanged).toBe(true);
    expect(next.declaration.revision).toBe(2);
  });
});

describe("194 Phase 0 C3/D4: terminal, budget and wake rules", () => {
  it("counts the same failed result only once (duplicate_ignored)", () => {
    const key = computeResultKey({ runId: "run-1", declarationRevision: 1, inputFingerprints: ["plan:ab", "test:cd"] });
    const first = applyTerminalStatus(makeRun(), "failed", key, 3);
    expect(first.run.consecutiveFailures).toBe(1);
    expect(first.run.recovery).toBe("awaiting-owner");
    const second = applyTerminalStatus(first.run, "failed", key, 3);
    expect(second.duplicateIgnored).toBe(true);
    expect(second.run.consecutiveFailures).toBe(1);
  });

  it("stops at the third consecutive failure with no fourth attempt", () => {
    let run = makeRun();
    const budget: number[] = [];
    for (let i = 1; i <= 4; i++) {
      const res = applyTerminalStatus(run, "failed", `key-${i}`, 3);
      run = res.run;
      budget.push(run.consecutiveFailures);
      if (res.budgetExhausted) break;
    }
    expect(budget).toEqual([1, 2, 3]);
    expect(run.recovery).toBe("budget-exhausted");
  });

  it("completed/unknown never touch the budget; only a verified success resets it", () => {
    const failed = applyTerminalStatus(makeRun(), "failed", "k1", 3).run;
    expect(applyTerminalStatus(failed, "completed", "k2", 3).run.consecutiveFailures).toBe(1);
    expect(applyTerminalStatus(failed, "unknown", undefined, 3).run.consecutiveFailures).toBe(1);
    expect(applyTerminalStatus(failed, "unknown", undefined, 3).run.recovery).toBe("awaiting-owner");
    const cleared = resetFailureBudget(failed);
    expect(cleared.consecutiveFailures).toBe(0);
    expect(cleared.recovery).toBe("none");
  });

  it("a terminal with no prior consumption record binds the caller's mode state", () => {
    const res = applyTerminalStatus(makeRun(), "failed", "k1", 3, "awaiting-owner-tool");
    expect(res.run.consumption).toEqual({ state: "awaiting-owner-tool", resultKey: "k1" });
    const keepState = applyTerminalStatus(res.run, "failed", "k2", 3, "awaiting-confirmation");
    expect(keepState.run.consumption).toEqual({ state: "awaiting-owner-tool", resultKey: "k2" });
  });

  it("pendingWakeId is issued at most once per run", () => {
    const issued = takePendingWake(makeRun(), () => "wake-1");
    expect(issued.wakeId).toBe("wake-1");
    expect(issued.run.pendingWakeId).toBe("wake-1");
    const again = takePendingWake(issued.run, () => "wake-2");
    expect(again.wakeId).toBeNull();
    expect(again.run.pendingWakeId).toBe("wake-1");
  });

  it("owner wake requires a declaration, an unconsumed terminal and no pending wake", () => {
    const withDecl = (o?: Partial<StageExecutorRun>) => makeRun({ declaration: {
      declarationId: "decl-x", revision: 1, requestedBy: "stage_advance", nextStage: "review",
    }, ...o });
    expect(shouldIssueOwnerWake(makeRun())).toBe(false);
    expect(shouldIssueOwnerWake(withDecl())).toBe(true);
    expect(shouldIssueOwnerWake(withDecl({ pendingWakeId: "wake-1" }))).toBe(false);
    expect(shouldIssueOwnerWake(withDecl({ terminalConsumed: true }))).toBe(false);
  });
});
