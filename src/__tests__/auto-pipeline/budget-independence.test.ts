/**
 * 219 Phase 3 §7: three INDEPENDENT budgets.
 *
 * Key behaviors:
 * - `designReview.maxRounds` (meta.autoJob) is judged by its own predicate and
 *   never touches the loop-cycle budget (`maxLoopCycles` / `effectiveMax`).
 * - `stopConditions.maxTotalLoops` / `maxTotalFreezes` live in the sidecar and
 *   are invisible to the design-review predicate.
 * - `reviewFix.maxRounds` simply lands in `maxLoopCycles` (Phase 2 overlay) —
 *   covered by the overlay tests; here we assert the predicate does not read it.
 * - Without `meta.autoJob` every auto judgement is inert (human mode).
 */
import { describe, it, expect } from "bun:test";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { effectiveMax } from "../../utils/stage-visit";
import {
  isDesignReviewRoundBudgetExhausted,
  noteDesignReviewDispatch,
} from "../../core/auto-pipeline/round-budget";
import { createJobState } from "../../core/auto-pipeline/job-state";
import { resolveFreezeAction } from "../../core/auto-pipeline/freeze-autopilot";
import { parseAutoJob } from "../../core/auto-pipeline/job-schema";

const JOB_YAML = [
  "version: 1",
  "enabled: true",
  "docs:",
  "  list:",
  "    - doc: docs/design/200_Feat.md",
  "reviewFix:",
  "  maxRounds: 2",
  "  maxLoopsPerStage: 3",
  "stopConditions:",
  "  maxTotalLoops: 5",
  "  maxTotalFreezes: 2",
  "  maxConsecutiveVerifyFailures: 3",
  "decisionPolicy:",
  "  onFreeze: resume",
  "  maxAutoResumes: 1",
].join("\n");

function job() {
  const parsed = parseAutoJob(JOB_YAML, "docs/jobs/alpha.yaml");
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.job;
}

function sidecar() {
  return createJobState({
    jobId: "alpha",
    jobPath: "docs/jobs/alpha.yaml",
    jobHash: "h",
    docs: [{ doc: "docs/design/200_Feat.md" }],
  });
}

describe("budget independence — design-review vs loop cycle", () => {
  it("exhausting the design-review budget leaves the loop-cycle budget untouched", () => {
    const config = makeTestConfig({ maxLoopCycles: 3 });
    const meta = makeTestMeta({
      loopCycleCount: 0,
      maxLoopCycles: 3,
      autoJob: {
        jobId: "alpha",
        jobPath: "docs/jobs/alpha.yaml",
        docIndex: 0,
        totalDocs: 1,
        designReviewMaxRounds: 3,
        designReviewRounds: 3,
        lastCountedDesignReviewRound: 3,
      },
    });

    expect(isDesignReviewRoundBudgetExhausted(meta)).toBe(true);
    // The loop budget is a DIFFERENT axis: unchanged and still fully available.
    expect(effectiveMax(meta, config)).toBe(3);
    expect(meta.loopCycleCount).toBe(0);
    expect(meta.maxLoopCycles).toBe(3);
  });

  it("the loop budget being spent does not exhaust the design-review budget", () => {
    const config = makeTestConfig({ maxLoopCycles: 1 });
    const meta = makeTestMeta({
      loopCycleCount: 1,
      autoJob: {
        jobId: "alpha",
        jobPath: "docs/jobs/alpha.yaml",
        docIndex: 0,
        totalDocs: 1,
        designReviewMaxRounds: 3,
        designReviewRounds: 0,
        lastCountedDesignReviewRound: 0,
      },
    });
    expect(meta.loopCycleCount).toBe(effectiveMax(meta, config)); // loop budget used up
    expect(isDesignReviewRoundBudgetExhausted(meta)).toBe(false);
  });

  it("the sidecar job-loop counter never feeds the design-review predicate", () => {
    const state = sidecar();
    state.counters.totalLoops = 999;
    state.counters.totalFreezes = 999;
    const meta = makeTestMeta({
      autoJob: {
        jobId: "alpha",
        jobPath: "docs/jobs/alpha.yaml",
        docIndex: 0,
        totalDocs: 1,
        designReviewMaxRounds: 3,
        designReviewRounds: 0,
      },
    });
    // Sidecar counters are not consulted at all by this predicate.
    expect(isDesignReviewRoundBudgetExhausted(meta)).toBe(false);
    expect(state.counters.totalLoops).toBe(999);
  });

  it("counting a review round touches ONLY meta.autoJob", () => {
    const meta = makeTestMeta({
      loopCycleCount: 2,
      maxLoopCycles: 5,
      autoJob: {
        jobId: "alpha",
        jobPath: "docs/jobs/alpha.yaml",
        docIndex: 0,
        totalDocs: 1,
        designReviewMaxRounds: 3,
        designReviewRounds: 0,
        lastCountedDesignReviewRound: 0,
      },
    });
    const patch = noteDesignReviewDispatch(meta, 1);
    expect(Object.keys(patch ?? {})).toEqual(["autoJob"]);
    expect(patch?.autoJob?.designReviewRounds).toBe(1);
    // Loop counters are not part of the patch.
    expect(meta.loopCycleCount).toBe(2);
    expect(meta.maxLoopCycles).toBe(5);
  });
});

describe("budget independence — freeze budget vs the others", () => {
  it("maxTotalFreezes does not exhaust the design-review round budget", () => {
    const state = sidecar();
    state.counters.totalFreezes = 2; // equals stopConditions.maxTotalFreezes
    const meta = makeTestMeta({
      autoJob: {
        jobId: "alpha",
        jobPath: "docs/jobs/alpha.yaml",
        docIndex: 0,
        totalDocs: 1,
        designReviewMaxRounds: 2,
        designReviewRounds: 1,
      },
    });
    expect(isDesignReviewRoundBudgetExhausted(meta)).toBe(false);
    expect(state.counters.totalFreezes).toBe(2);
  });

  it("maxAutoResumes gates only the resume action, not round counting", () => {
    const state = sidecar();
    state.counters.autoResumes = 1; // cap reached (maxAutoResumes: 1)
    const meta = makeTestMeta();
    expect(resolveFreezeAction({ meta, job: job(), state, reason: "loop_overflow" }).action).toBe("stop-and-report");
    // Round counting is independent of the freeze policy.
    expect(noteDesignReviewDispatch(
      makeTestMeta({
        autoJob: {
          jobId: "alpha",
          jobPath: "docs/jobs/alpha.yaml",
          docIndex: 0,
          totalDocs: 1,
          designReviewMaxRounds: 2,
          designReviewRounds: 0,
        },
      }),
      1,
    )).not.toBeNull();
  });
});

describe("budget independence — human mode", () => {
  it("without meta.autoJob the design-review predicate is inert", () => {
    expect(isDesignReviewRoundBudgetExhausted(makeTestMeta())).toBe(false);
    expect(noteDesignReviewDispatch(makeTestMeta(), 5)).toBeNull();
  });
});
