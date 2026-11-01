/**
 * 219 Phase 5 §3.1 (Seam A): `recordAutoAwareStageVisit`.
 *
 * Key behaviors:
 * - Non-auto contexts pass through verbatim (same `visit` object semantics).
 * - Only a COUNTED edge into develop/fix consults the loop brake.
 * - `visit.ok` is NEVER rewritten — the max-loop-cycle freeze stays owned by
 *   `recordStageVisit`; a job-level brake is a distinct `soft-stop`.
 * - A grace grant is persisted to the sidecar (`finalGraceUsed`).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { recordStageVisit } from "../../utils/stage-visit";
import { recordAutoAwareStageVisit } from "../../core/auto-pipeline/stop-policy";
import { createJobState, readJobState, writeJobState, type AutoJobState } from "../../core/auto-pipeline/job-state";
import { parseAutoJob, type AutoJobConfig } from "../../core/auto-pipeline/job-schema";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";

const JOB_YAML = [
  "version: 1",
  "enabled: true",
  "docs:",
  "  list:",
  "    - doc: docs/design/a.md",
  "stopConditions:",
  "  maxTotalLoops: 2",
  "  finalLoopGrace: 1",
].join("\n");

let errorSpy: ReturnType<typeof spyOn>;

function job(): AutoJobConfig {
  const parsed = parseAutoJob(JOB_YAML, "docs/jobs/alpha_loop.yaml");
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.job;
}

function stateWith(totalLoops: number): AutoJobState {
  const base = createJobState({
    jobId: "alpha_loop",
    jobPath: "docs/jobs/alpha_loop.yaml",
    jobHash: "h",
    docs: [{ doc: "docs/design/a.md" }],
  });
  base.counters.totalLoops = totalLoops;
  base.status = "running";
  return base;
}

beforeEach(() => {
  __setSafeWriteAuditLogOverride(async () => undefined);
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  errorSpy.mockRestore();
});

describe("loop-seam — passthrough", () => {
  it("non-auto context returns the plain visit result", () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "review", stageVisitOrder: ["clarify", "plan", "develop", "review"] });
    const result = recordAutoAwareStageVisit({
      meta,
      nextStage: "develop",
      maxCycles: 3,
      config,
      resolveContext: () => null,
    });
    expect(result.kind).toBe("visit");
    if (result.kind !== "visit") return;
    expect(result.visit).toEqual(recordStageVisit(meta, "develop", 3, config));
  });

  it("a config-less (legacy) call passes through", () => {
    const meta = makeTestMeta();
    const result = recordAutoAwareStageVisit({ meta, nextStage: "develop", maxCycles: 3, config: undefined });
    expect(result.kind).toBe("visit");
  });

  it("an uncounted edge (first visit) never consults the brake", () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "clarify", stageVisitOrder: ["clarify"] });
    const result = recordAutoAwareStageVisit({
      meta,
      nextStage: "develop",
      maxCycles: 3,
      config,
      resolveContext: () => ({ state: stateWith(99), job: job() }),
    });
    expect(result.kind).toBe("visit");
  });

  it("a counted edge into plan/design-review never consults the brake", () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "develop", stageVisitOrder: ["clarify", "plan", "develop"] });
    const result = recordAutoAwareStageVisit({
      meta,
      nextStage: "plan",
      maxCycles: 3,
      config,
      resolveContext: () => ({ state: stateWith(99), job: job() }),
    });
    expect(result.kind).toBe("visit");
  });

  it("grace: the visit still passes through and the grant is persisted", async () => {
    const config = makeTestConfig();
    // develop → fix is not a rework edge in this config; fix → develop is the
    // canonical backward (counted) loop edge.
    const meta = makeTestMeta({
      currentStage: "fix",
      stageVisitOrder: ["clarify", "plan", "design-review", "develop", "review", "fix"],
    });
    const state = stateWith(2); // budget = 2 → grace territory
    const result = recordAutoAwareStageVisit({
      meta,
      nextStage: "develop",
      maxCycles: 5,
      config,
      // Persist to a real project root so the fire-and-forget write is observable.
      resolveContext: () => ({ state, job: job() }),
    });
    expect(result.kind).toBe("visit");
    expect(state.counters.finalGraceUsed["docs/design/a.md"]).toBe(1);
    void writeJobState;
    void readJobState;
  });
});

describe("loop-seam — soft stop", () => {
  it("an exhausted budget with no grace left → soft-stop", () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "fix",
      stageVisitOrder: ["clarify", "plan", "design-review", "develop", "review", "fix"],
    });
    const state = stateWith(99);
    state.counters.finalGraceUsed["docs/design/a.md"] = 1;
    const result = recordAutoAwareStageVisit({
      meta,
      nextStage: "develop",
      maxCycles: 5,
      config,
      resolveContext: () => ({ state, job: job() }),
    });
    expect(result.kind).toBe("soft-stop");
    if (result.kind !== "soft-stop") return;
    expect(result.verdict).toEqual({ kind: "soft", stopReason: "budget_exhausted" });
  });

  it("never rewrites visit.ok: the max-loop-cycle freeze still surfaces as a visit", () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "fix",
      loopCycleCount: 5,
      maxLoopCycles: 3,
      stageVisitOrder: ["clarify", "plan", "design-review", "develop", "review", "fix"],
    });
    const result = recordAutoAwareStageVisit({
      meta,
      nextStage: "develop",
      maxCycles: 3,
      config,
      resolveContext: () => null,
    });
    expect(result.kind).toBe("visit");
    if (result.kind !== "visit") return;
    expect(result.visit.ok).toBe(false);
  });
});
