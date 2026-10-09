/**
 * 194 Phase 0 (C3): strict-commit integration for the bounded executor run,
 * exercised through the REAL createSessionState adapter (temp-dir shared
 * store) plus the production expectation comparison.
 *
 * Covers: backward-compatible reads of pre-feature meta, stale whole-meta
 * writes that must NOT erase a live run, concurrent consumers where only one
 * side succeeds, duplicate-declaration conflicts and commit / read-back
 * failures.
 */

import { describe, it, expect, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  createSessionState,
  expectedFromCurrent,
  matchCommitExpectation,
  PIPELINE_META_CUSTOM_TYPE,
  __resetSharedStateDir,
  type MetaCommitExpectation,
} from "../../core/session-state";
import { executorExpectationFromCurrent, hasLiveExecutorRun } from "../../core/stage-executor/commit-guard";
import type { SessionMeta, StageExecutorBinding, StageExecutorRun } from "../../types";
import { makeMockSessionManager } from "../helpers";

function makeRun(binding?: Partial<StageExecutorBinding>, overrides?: Partial<StageExecutorRun>): StageExecutorRun {
  const full: StageExecutorBinding = {
    runId: "run-1",
    pipelineId: "pipe-strict-1",
    ownerSessionFile: "/sessions/owner.jsonl",
    stage: "develop",
    stageVisitId: 1_700_000_000_000,
    operationId: "op-1",
    agentId: "01a11bbb-c3b4-72bc-9397-4f5b9881be41",
    ...binding,
  };
  return {
    binding: full,
    status: "running",
    recovery: "none",
    consecutiveFailures: 0,
    terminalConsumed: false,
    ...overrides,
  };
}

function makeRealAdapter() {
  const projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-executor-commit-"));
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
  return {
    session,
    entries,
    breakAppend: () => { appendBroken = true; },
    sharedMetaPath: path.join(projectRoot, auditDir, "pipe-strict-1", "meta.json"),
    cleanup: () => {
      __resetSharedStateDir();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

function baseMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return {
    currentStage: "develop",
    previousStage: "design-review",
    stageStartTime: 1_700_000_000_000,
    pipelineId: "pipe-strict-1",
    domain: { id: "general", version: "latest", skillPath: "/tmp/domain.md" },
    summaries: {},
    loopCount: 0,
    currentStepIndex: 0,
    maxLoops: 3,
    ...overrides,
  };
}

let h: ReturnType<typeof makeRealAdapter> | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

describe("194 Phase 0 C3: legacy meta compatibility", () => {
  it("reads a pre-feature meta unchanged and its strict commit still succeeds", () => {
    h = makeRealAdapter();
    const meta = baseMeta();
    h.session.updateMeta(meta);

    const read = h.session.getMeta()!;
    expect(read.stageExecutorRun).toBeUndefined();
    expect((read as unknown as Record<string, unknown>)["designReview"]).toBeUndefined();

    // expectedFromCurrent pins "no run" — nothing else changed, so it commits.
    const expected = expectedFromCurrent(read);
    expect(expected.executorRunId).toBeNull();
    const res = h.session.updateMetaVerified!({ currentStage: "review" }, expected);
    expect(res.status).toBe("persisted");
  });

  it("keeps an invalid persisted run untrusted for consumers that narrow it", () => {
    h = makeRealAdapter();
    // A foreign/corrupt record must not be treated as a live run authority.
    const meta = baseMeta({
      stageExecutorRun: {
        binding: { runId: "x", pipelineId: "pipe-strict-1" },
        status: "running",
      } as unknown as StageExecutorRun,
    });
    h.session.updateMeta(meta);
    expect(hasLiveExecutorRun(h.session.getMeta())).toBe(true); // shape-blind read
    expect(executorExpectationFromCurrent(h.session.getMeta()!).executorRunId).toBe("x");
    // Downstream authority still requires narrowStageExecutorBinding (see the
    // binding test): an incomplete record can never authorize a mutation.
  });
});

describe("194 Phase 0 C3: run persistence and stale-write protection", () => {
  it("persists a new run and reads it back from the shared store", () => {
    h = makeRealAdapter();
    h.session.updateMeta(baseMeta());
    const run = makeRun();
    const res = h.session.updateMetaVerified!(
      { stageExecutorRun: run },
      { pipelineId: "pipe-strict-1", executorRunId: null },
    );
    expect(res.status).toBe("persisted");
    const shared = JSON.parse(fs.readFileSync(h.sharedMetaPath, "utf-8")) as SessionMeta;
    expect(shared.stageExecutorRun?.binding.agentId).toBe(run.binding.agentId);
  });

  it("a stale whole-meta echo WITHOUT the run key preserves the live run", () => {
    h = makeRealAdapter();
    h.session.updateMeta(baseMeta({ stageExecutorRun: makeRun() }));
    const staleSnapshot = baseMeta(); // captured before the run existed
    const merged = h.session.updateMeta({ ...staleSnapshot });
    expect(merged?.stageExecutorRun?.binding.runId).toBe("run-1");
    const shared = JSON.parse(fs.readFileSync(h.sharedMetaPath, "utf-8")) as SessionMeta;
    expect(shared.stageExecutorRun?.binding.runId).toBe("run-1");
  });

  it("a plain write that clears the run is REJECTED with zero effect", () => {
    h = makeRealAdapter();
    h.session.updateMeta(baseMeta({ stageExecutorRun: makeRun() }));
    const before = fs.readFileSync(h.sharedMetaPath, "utf-8");

    const res = h.session.updateMeta({ stageExecutorRun: undefined });
    expect(res).toBeUndefined();
    expect(fs.readFileSync(h.sharedMetaPath, "utf-8")).toBe(before);

    // Different identity is equally forbidden for a plain (expectation-less) write.
    expect(h.session.updateMeta({ stageExecutorRun: makeRun({ runId: "run-evil" }) })).toBeUndefined();
    const shared = JSON.parse(fs.readFileSync(h.sharedMetaPath, "utf-8")) as SessionMeta;
    expect(shared.stageExecutorRun?.binding.runId).toBe("run-1");
  });

  it("an identical run echo is harmless (JOIN idempotency)", () => {
    h = makeRealAdapter();
    const run = makeRun();
    h.session.updateMeta(baseMeta({ stageExecutorRun: run }));
    const before = fs.readFileSync(h.sharedMetaPath, "utf-8");
    const merged = h.session.updateMeta({ stageExecutorRun: run });
    expect(merged).toBeDefined();
    expect(fs.readFileSync(h.sharedMetaPath, "utf-8")).toBe(before);
  });

  it("live/unknown runs are detected; consumed or settled runs are not live", () => {
    expect(hasLiveExecutorRun(baseMeta({ stageExecutorRun: makeRun(undefined, { status: "unknown" }) }))).toBe(true);
    expect(hasLiveExecutorRun(baseMeta({ stageExecutorRun: makeRun(undefined, { status: "completed" }) }))).toBe(false);
    expect(hasLiveExecutorRun(undefined)).toBe(false);
  });
});

describe("194 Phase 0 C3/C5: concurrent consumers — only one side succeeds", () => {
  function seededWithRun(): ReturnType<typeof makeRealAdapter> {
    const adapter = makeRealAdapter();
    adapter.session.updateMeta(baseMeta({ stageExecutorRun: makeRun() }));
    return adapter;
  }

  it("two consumers anchored to the same declaration conflict on the second", () => {
    h = seededWithRun();
    const current = h.session.getMeta()!;
    const expected = expectedFromCurrent(current);
    expect(expected.executorRunId).toBe("run-1");
    expect(expected.executorDeclarationRevision).toBeNull();

    const first = h.session.updateMetaVerified!(
      { stageExecutorRun: { ...current.stageExecutorRun!, declaration: {
        declarationId: "decl-1", revision: 1, requestedBy: "stage_advance", nextStage: "review",
      } } },
      expected,
    );
    expect(first.status).toBe("persisted");

    // The second consumer still believes there is no declaration.
    const stale = h.session.updateMetaVerified!(
      { stageExecutorRun: { ...current.stageExecutorRun!, declaration: {
        declarationId: "decl-2", revision: 1, requestedBy: "stage_advance", nextStage: "completed",
      } } },
      expected,
    );
    // "expected absent, but present" is the same convention as the 192
    // `operation_expected_absent` anchor — the conflict is what matters.
    expect(stale).toEqual({ status: "conflict", reason: "executor_declaration_expected_absent" });

    const shared = JSON.parse(fs.readFileSync(h.sharedMetaPath, "utf-8")) as SessionMeta;
    expect(shared.stageExecutorRun?.declaration?.declarationId).toBe("decl-1");
  });

  it("a run replaced between read and write conflicts by runId", () => {
    h = seededWithRun();
    const expected = expectedFromCurrent(h.session.getMeta()!);
    const superseded = makeRun({ runId: "run-2", stage: "design-review" });
    expect(h.session.updateMetaVerified!({ stageExecutorRun: superseded }, expected).status).toBe("persisted");

    // A caller that read run-1 can never commit against run-2.
    const late = h.session.updateMetaVerified!(
      { stageExecutorRun: { ...superseded, terminalConsumed: true } },
      { pipelineId: "pipe-strict-1", executorRunId: "run-1" },
    );
    expect(late).toEqual({ status: "conflict", reason: "executor_run_mismatch" });
  });

  it("asserting 'no run' conflicts once a run exists (no blind clearing)", () => {
    h = seededWithRun();
    const res = h.session.updateMetaVerified!(
      { currentStage: "review" },
      { pipelineId: "pipe-strict-1", executorRunId: null },
    );
    expect(res).toEqual({ status: "conflict", reason: "executor_run_expected_absent" });
  });

  it("stage / visit / terminal / resultKey anchors are compared individually", () => {
    h = seededWithRun();
    const run = h.session.getMeta()!.stageExecutorRun!;
    expect(matchCommitExpectation(h.session.getMeta()!, {
      pipelineId: "pipe-strict-1", executorStage: "develop", executorStageVisitId: run.binding.stageVisitId,
      executorRunId: "run-1", executorTerminalConsumed: false, executorResultKey: null,
    })).toBeNull();

    expect(matchCommitExpectation(h.session.getMeta()!, {
      pipelineId: "pipe-strict-1", executorStage: "plan",
    })).toBe("executor_stage_mismatch");
    expect(matchCommitExpectation(h.session.getMeta()!, {
      pipelineId: "pipe-strict-1", executorStageVisitId: run.binding.stageVisitId + 1,
    })).toBe("executor_visit_mismatch");
    expect(matchCommitExpectation(h.session.getMeta()!, {
      pipelineId: "pipe-strict-1", executorTerminalConsumed: true,
    })).toBe("executor_terminal_mismatch");
    expect(matchCommitExpectation(h.session.getMeta()!, {
      pipelineId: "pipe-strict-1", executorResultKey: "k1",
    })).toBe("executor_result_key_mismatch");
    expect(matchCommitExpectation(h.session.getMeta()!, {
      pipelineId: "pipe-strict-1", executorOperationId: "op-other",
    })).toBe("executor_operation_mismatch");
    expect(matchCommitExpectation(h.session.getMeta()!, {
      pipelineId: "pipe-strict-1", executorPipelineId: "pipe-other",
    })).toBe("executor_pipeline_mismatch");
    // No executor expectations at all → ordinary commits behave exactly as before.
    expect(matchCommitExpectation(h.session.getMeta()!, { pipelineId: "pipe-strict-1" })).toBeNull();
  });

  it("positive executor expectations without any run cannot be satisfied", () => {
    h = makeRealAdapter();
    h.session.updateMeta(baseMeta());
    expect(matchCommitExpectation(h.session.getMeta()!, {
      pipelineId: "pipe-strict-1", executorStage: "develop",
    })).toBe("executor_run_missing");
  });
});

describe("194 Phase 0 C3: commit and read-back failures are never success", () => {
  it("a local append failure reports unavailable and writes nothing shared", () => {
    h = makeRealAdapter();
    h.session.updateMeta(baseMeta());
    h.breakAppend();
    const res = h.session.updateMetaVerified!(
      { stageExecutorRun: makeRun() },
      { pipelineId: "pipe-strict-1", executorRunId: null },
    );
    expect(res.status).toBe("unavailable");
    expect(res.status === "unavailable" ? res.reason : "").toBe("local_append_failed");
  });

  it("a run that does not survive the read-back is reported unavailable", () => {
    h = makeRealAdapter();
    h.session.updateMeta(baseMeta({ stageExecutorRun: makeRun(undefined, { terminalConsumed: false }) }));
    const expected: MetaCommitExpectation = {
      pipelineId: "pipe-strict-1", executorRunId: "run-1", executorTerminalConsumed: false,
    };
    // Simulate a SHARED store that silently drops the new run field on read
    // back (storage drift): every read BEFORE the atomic publish is honest;
    // once a rename into meta.json lands, the next read loses `stageExecutorRun`.
    // The strict commit must notice the divergence and report unavailable.
    const realRead = fsDefault.readFileSync;
    const realRename = fsDefault.renameSync;
    let published = false;
    const readSpy = spyOn(fsDefault, "readFileSync").mockImplementation(((file: fs.PathLike | number, options?: unknown) => {
      const out = (realRead as (f: fs.PathLike | number, o?: unknown) => string)(file, options as never);
      const p = typeof file === "string" ? file : String(file);
      if (published && p.endsWith(path.join("pipe-strict-1", "meta.json"))) {
        const parsed = JSON.parse(out) as SessionMeta;
        delete (parsed as unknown as Record<string, unknown>).stageExecutorRun;
        return JSON.stringify(parsed);
      }
      return out;
    }) as typeof fsDefault.readFileSync);
    const renameSpy = spyOn(fsDefault, "renameSync").mockImplementation(((from: string | URL, to: string | URL) => {
      (realRename as (f: string | URL, t: string | URL) => void)(from, to);
      if (String(to).endsWith(path.join("pipe-strict-1", "meta.json"))) published = true;
    }) as typeof fsDefault.renameSync);

    try {
      const res = h.session.updateMetaVerified!(
        { stageExecutorRun: makeRun(undefined, { terminalConsumed: true }) },
        expected,
      );
      expect(res.status).toBe("unavailable");
      expect(res.status === "unavailable" ? res.reason : "").toBe("readback_executor_run_mismatch");
      // The publish really happened — the test proves detection, not a bypass.
      expect(published).toBe(true);
    } finally {
      readSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it("an expectation-less run write still requires the run anchor on commit", () => {
    h = makeRealAdapter();
    h.session.updateMeta(baseMeta());
    // No executor expectation at all: committing a run is allowed (the anchor
    // is the caller's choice), and the read-back proof is what makes it real.
    const res = h.session.updateMetaVerified!({ stageExecutorRun: makeRun() }, { pipelineId: "pipe-strict-1" });
    expect(res.status).toBe("persisted");
    expect(h.session.getMeta()!.stageExecutorRun?.binding.runId).toBe("run-1");
  });
});
