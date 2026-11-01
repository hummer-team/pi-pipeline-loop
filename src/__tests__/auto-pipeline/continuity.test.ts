/**
 * 219 Phase 6 (H4): the interrupt-continuity hard judgement.
 *
 * Rules (order = priority):
 * 1 frozen → resume
 * 2 running + not settled in this session → resume (works with meta === null)
 * 3 meta without a stage → none
 * 4 completed + commit doc → none (+ doc)
 * 5 otherwise none
 */
import { describe, it, expect } from "bun:test";
import { makeTestMeta } from "../helpers";
import { decideContinuity } from "../../core/auto-pipeline/continuity";
import { createJobState, type AutoJobState } from "../../core/auto-pipeline/job-state";

function state(overrides?: Partial<AutoJobState>): AutoJobState {
  const base = createJobState({
    jobId: "alpha_loop",
    jobPath: "docs/jobs/alpha_loop.yaml",
    jobHash: "h",
    docs: [{ doc: "docs/design/a.md" }, { doc: "docs/design/b.md" }],
  });
  return { ...base, ...overrides };
}

const SESSION_START = 1_000_000;

describe("continuity — rule matrix", () => {
  it("rule 1: a frozen meta resumes (stage from meta)", () => {
    const meta = makeTestMeta({ flowState: "blocked", currentStage: "review", requirementDoc: "docs/design/a.md" });
    const result = decideContinuity({ meta, state: null, sessionStartedAt: SESSION_START, hasCommitDoc: false });
    expect(result).toEqual({
      decision: "resume",
      reason: "frozen",
      doc: "docs/design/a.md",
      stage: "review",
    });
  });

  it("rule 1: frozen meta without a stage falls back to the sidecar lastStage", () => {
    const meta = makeTestMeta({ flowState: "blocked", currentStage: undefined as unknown as never });
    const running = state({ status: "running", lastSettleAt: 0 });
    running.docs[0]!.lastStage = "develop";
    const result = decideContinuity({ meta, state: running, sessionStartedAt: SESSION_START, hasCommitDoc: false });
    expect(result.decision).toBe("resume");
    expect(result.stage).toBe("develop");
  });

  it("rule 2: meta === null + running + unsettled → resume with stage from the sidecar (H4)", () => {
    const running = state({ status: "running", lastSettleAt: SESSION_START - 1 });
    running.docs[0]!.lastStage = "review";
    const result = decideContinuity({ meta: null, state: running, sessionStartedAt: SESSION_START, hasCommitDoc: false });
    expect(result).toEqual({
      decision: "resume",
      reason: "unsettled_new_session",
      doc: "docs/design/a.md",
      stage: "review",
    });
  });

  it("rule 2: a missing lastSettleAt still resumes", () => {
    const running = state({ status: "running", lastSettleAt: undefined });
    expect(
      decideContinuity({ meta: makeTestMeta(), state: running, sessionStartedAt: SESSION_START, hasCommitDoc: false }).decision,
    ).toBe("resume");
  });

  it("rule 2: meta present + unsettled → reason 'unsettled' (meta stage wins)", () => {
    const running = state({ status: "running", lastSettleAt: 0 });
    running.docs[0]!.lastStage = "review";
    const result = decideContinuity({
      meta: makeTestMeta({ currentStage: "develop" }),
      state: running,
      sessionStartedAt: SESSION_START,
      hasCommitDoc: false,
    });
    expect(result.reason).toBe("unsettled");
    expect(result.stage).toBe("develop");
  });

  it("rule 2 requires an unsettled job: lastSettleAt in THIS session does not resume", () => {
    const settled = state({ status: "running", lastSettleAt: SESSION_START + 10 });
    const result = decideContinuity({ meta: makeTestMeta(), state: settled, sessionStartedAt: SESSION_START, hasCommitDoc: false });
    expect(result.decision).toBe("none");
  });

  it("rule 3: meta without currentStage and no interruption → none", () => {
    const meta = makeTestMeta({ currentStage: undefined as unknown as never });
    expect(decideContinuity({ meta, state: null, sessionStartedAt: SESSION_START, hasCommitDoc: false })).toEqual({
      decision: "none",
      reason: "stage_unknown_in_meta",
    });
  });

  it("rule 4: completed job whose doc shipped → none + doc", () => {
    const done = state({ status: "completed" });
    done.docs[0]!.status = "completed";
    const result = decideContinuity({
      meta: makeTestMeta(),
      state: done,
      sessionStartedAt: SESSION_START,
      hasCommitDoc: true,
    });
    expect(result).toEqual({
      decision: "none",
      reason: "job_completed_with_commit_doc",
      doc: "docs/design/a.md",
    });
  });

  it("rule 4 requires the commit doc: completed without it stays a plain none", () => {
    const done = state({ status: "completed" });
    expect(
      decideContinuity({ meta: makeTestMeta(), state: done, sessionStartedAt: SESSION_START, hasCommitDoc: false }).reason,
    ).toBe("no_interruption");
  });

  it("rule 5: nothing to resume", () => {
    expect(decideContinuity({ meta: makeTestMeta(), state: null, sessionStartedAt: SESSION_START, hasCommitDoc: false })).toEqual({
      decision: "none",
      reason: "no_interruption",
    });
  });
});

describe("continuity — edge cases", () => {
  it("missing lastStage and currentStage → stage undefined, never throws", () => {
    const running = state({ status: "running", lastSettleAt: 0 });
    const result = decideContinuity({ meta: null, state: running, sessionStartedAt: SESSION_START, hasCommitDoc: false });
    expect(result.decision).toBe("resume");
    expect(result.stage).toBeUndefined();
  });

  it("clock skew (settle in the future) never claims an interruption", () => {
    const skew = state({ status: "running", lastSettleAt: SESSION_START + 999_999 });
    const result = decideContinuity({ meta: makeTestMeta(), state: skew, sessionStartedAt: SESSION_START, hasCommitDoc: false });
    expect(result.decision).toBe("none");
  });

  it("sidecar missing but meta frozen → still resume", () => {
    const meta = makeTestMeta({ flowState: "blocked", blockedReason: "loop_overflow" });
    expect(
      decideContinuity({ meta, state: null, sessionStartedAt: SESSION_START, hasCommitDoc: false }).decision,
    ).toBe("resume");
  });

  it("both sides missing → none", () => {
    expect(decideContinuity({ meta: null, state: null, sessionStartedAt: SESSION_START, hasCommitDoc: false })).toEqual({
      decision: "none",
      reason: "no_interruption",
    });
  });
});
