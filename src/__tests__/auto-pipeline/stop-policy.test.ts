/**
 * 219 Phase 5 §3 (H3): `evaluateHardStop` and `evaluateLoopBrake` are SEPARATE
 * functions with separate seams. This suite pins each matrix and the H3
 * invariant triple: inside a loop a wall-clock/freeze condition is a HARD stop,
 * while a merely exhausted `totalLoops` is NOT (the next loop start handles it).
 */
import { describe, it, expect } from "bun:test";
import { makeTestMeta } from "../helpers";
import { createJobState } from "../../core/auto-pipeline/job-state";
import type { AutoJobState } from "../../core/auto-pipeline/job-state";
import { parseAutoJob, type AutoJobConfig } from "../../core/auto-pipeline/job-schema";
import { evaluateHardStop, evaluateLoopBrake } from "../../core/auto-pipeline/stop-policy";

const JOB_YAML = [
  "version: 1",
  "enabled: true",
  "docs:",
  "  list:",
  "    - doc: docs/design/a.md",
  "stopConditions:",
  "  maxTotalLoops: 5",
  "  maxTotalFreezes: 2",
  "  wallClockMs: 0",
  "  stopOnBlockedReasons:",
  "    - blocked_by_policy",
  "  finalLoopGrace: 1",
  "verify:",
  "  maxAttempts: 3",
  "freezePolicy:",
  "  onFreeze: resume",
  "  maxAutoResumes: 2",
].join("\n");

function job(overrides?: (j: AutoJobConfig) => void): AutoJobConfig {
  const parsed = parseAutoJob(JOB_YAML, "docs/jobs/alpha_loop.yaml");
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  overrides?.(parsed.job);
  return parsed.job;
}

function state(overrides?: Partial<AutoJobState>): AutoJobState {
  const base = createJobState({
    jobId: "alpha_loop",
    jobPath: "docs/jobs/alpha_loop.yaml",
    jobHash: "h",
    docs: [{ doc: "docs/design/a.md" }],
  });
  return { ...base, ...overrides };
}

const NOW = 10_000_000;

describe("stop-policy — evaluateHardStop", () => {
  it("wall clock: disabled at 0, hard once exceeded", () => {
    const base = state({ startedAt: NOW - 1000 });
    expect(evaluateHardStop({ state: base, meta: makeTestMeta(), job: job(), now: NOW })).toEqual({
      kind: "continue",
    });
    const limited = job((j) => {
      j.stopConditions.wallClockMs = 500;
    });
    expect(evaluateHardStop({ state: base, meta: makeTestMeta(), job: limited, now: NOW })).toEqual({
      kind: "hard",
      stopReason: "wall_clock",
    });
  });

  it("blocked reason listed in stopOnBlockedReasons → hard", () => {
    const meta = makeTestMeta({ flowState: "blocked", blockedReason: "blocked_by_policy" });
    expect(evaluateHardStop({ state: state(), meta, job: job(), now: NOW })).toEqual({
      kind: "hard",
      stopReason: "blocked_reason",
    });
    const other = makeTestMeta({ flowState: "blocked", blockedReason: "loop_overflow" });
    expect(evaluateHardStop({ state: state(), meta: other, job: job(), now: NOW }).kind).toBe("continue");
  });

  it("verify attempts reach job.verify.maxAttempts → hard", () => {
    // 220 D7/Q15: the streak is read from LIVE meta (reset on stage advance),
    // never from a cross-stage sidecar counter.
    const atThreshold = makeTestMeta({ verifyAttempts: 3 });
    expect(evaluateHardStop({ state: state(), meta: atThreshold, job: job(), now: NOW })).toEqual({
      kind: "hard",
      stopReason: "verify_failures",
    });
    const below = makeTestMeta({ verifyAttempts: 2 });
    expect(evaluateHardStop({ state: state(), meta: below, job: job(), now: NOW }).kind).toBe("continue");
    // Unset (fresh stage) is never a failure.
    expect(evaluateHardStop({ state: state(), meta: makeTestMeta(), job: job(), now: NOW }).kind).toBe("continue");
  });

  it("unresolvable freeze wins over the historical freeze budget", () => {
    const meta = makeTestMeta({ flowState: "blocked", blockedReason: "mystery_freeze" });
    // onFreeze: resume but the reason is unknown? `onFreeze` applies, so make it
    // stop-and-report explicitly to represent an unresolvable freeze.
    const stopped = job((j) => {
      j.freezePolicy.onFreeze = "stop-and-report";
    });
    const both = state({ counters: { ...state().counters, totalFreezes: 5 } });
    expect(evaluateHardStop({ state: both, meta, job: stopped, now: NOW })).toEqual({
      kind: "hard",
      stopReason: "freeze_unresolvable",
    });
  });

  it("freeze budget: 0 = unlimited, reached → hard", () => {
    const meta = makeTestMeta();
    const unlimited = job((j) => {
      j.stopConditions.maxTotalFreezes = 0;
    });
    const reached = state({ counters: { ...state().counters, totalFreezes: 2 } });
    expect(evaluateHardStop({ state: reached, meta, job: unlimited, now: NOW }).kind).toBe("continue");
    expect(evaluateHardStop({ state: reached, meta, job: job(), now: NOW })).toEqual({
      kind: "hard",
      stopReason: "freeze_budget_exhausted",
    });
  });
});

describe("stop-policy — evaluateLoopBrake", () => {
  const docKey = "docs/design/a.md";

  it("within budget → continue; at the budget → grace once (default 1) then soft", () => {
    const meta = makeTestMeta();
    const within = state({ counters: { ...state().counters, totalLoops: 4 } });
    expect(evaluateLoopBrake({ state: within, meta, job: job(), docKey, now: NOW })).toEqual({
      kind: "continue",
      reason: "within_budget",
    });

    const at = state({ counters: { ...state().counters, totalLoops: 5 } });
    expect(evaluateLoopBrake({ state: at, meta, job: job(), docKey, now: NOW })).toEqual({
      kind: "grace",
      reason: "grace_granted",
    });
    expect(at.counters.finalGraceUsed[docKey]).toBe(1);
    // Second call in the same doc → grace is spent.
    expect(evaluateLoopBrake({ state: at, meta, job: job(), docKey, now: NOW })).toEqual({
      kind: "soft",
      stopReason: "budget_exhausted",
    });
  });

  it("finalLoopGrace:0 disables the grace entirely", () => {
    const noGrace = job((j) => {
      j.stopConditions.finalLoopGrace = 0;
    });
    const at = state({ counters: { ...state().counters, totalLoops: 5 } });
    expect(evaluateLoopBrake({ state: at, meta: makeTestMeta(), job: noGrace, docKey, now: NOW })).toEqual({
      kind: "soft",
      stopReason: "budget_exhausted",
    });
    expect(at.counters.finalGraceUsed[docKey]).toBeUndefined();
  });

  it("an already completed doc never gets a grace", () => {
    const meta = makeTestMeta();
    const done = state({
      counters: { ...state().counters, totalLoops: 5 },
      docs: [{ doc: docKey, status: "completed", updatedAt: 0 }],
    });
    expect(evaluateLoopBrake({ state: done, meta, job: job(), docKey, now: NOW })).toEqual({
      kind: "soft",
      stopReason: "budget_exhausted",
    });
  });

  it("grace accounting is per document", () => {
    const meta = makeTestMeta();
    const shared = state({
      counters: { ...state().counters, totalLoops: 5 },
      docs: [
        { doc: "docs/design/a.md", status: "running", updatedAt: 0 },
        { doc: "docs/design/b.md", status: "pending", updatedAt: 0 },
      ],
    });
    expect(evaluateLoopBrake({ state: shared, meta, job: job(), docKey: "docs/design/a.md", now: NOW }).kind).toBe("grace");
    expect(evaluateLoopBrake({ state: shared, meta, job: job(), docKey: "docs/design/b.md", now: NOW }).kind).toBe("grace");
    expect(shared.counters.finalGraceUsed).toEqual({
      "docs/design/a.md": 1,
      "docs/design/b.md": 1,
    });
  });
});

describe("stop-policy — H3: the two functions never blur", () => {
  it("inside a loop: wall clock → hard, but only totalLoops → not hard", () => {
    const meta = makeTestMeta();
    const timed = state({
      startedAt: NOW - 10_000,
      counters: { ...state().counters, totalLoops: 99 },
    });
    const limited = job((j) => {
      j.stopConditions.wallClockMs = 1000;
    });
    expect(evaluateHardStop({ state: timed, meta, job: limited, now: NOW })).toEqual({
      kind: "hard",
      stopReason: "wall_clock",
    });

    const onlyLoops = state({ counters: { ...state().counters, totalLoops: 99 } });
    expect(evaluateHardStop({ state: onlyLoops, meta, job: job(), now: NOW }).kind).toBe("continue");
    expect(
      evaluateLoopBrake({ state: onlyLoops, meta, job: job(), docKey: "docs/design/a.md", now: NOW }).kind,
    ).toBe("grace");
  });

  it("inside a loop: a stop-and-report freeze is hard on the settle side", () => {
    const meta = makeTestMeta({ flowState: "blocked", blockedReason: "stuck" });
    const stopped = job((j) => {
      j.freezePolicy.onFreeze = "stop-and-report";
    });
    expect(evaluateHardStop({ state: state(), meta, job: stopped, now: NOW })).toEqual({
      kind: "hard",
      stopReason: "freeze_unresolvable",
    });
  });
});
