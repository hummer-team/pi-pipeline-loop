/**
 * 229 Phase 5 (F5): loop-first exhaustion routing + precedence + targets.
 *
 * Boundaries (plan Phase 5 "单元测试目标，边界"):
 * - routing: review-stage no_progress ⇒ reviewFix (target completed);
 *   design-review no_progress ⇒ designReview (target develop); a
 *   no_progress with NO domain ⇒ NOT routed (onFreeze keeps it);
 * - precedence (B16/问题 17): byReason=stop still stops; onFreeze=
 *   stop-and-report with NO explicit onExhausted ⇒ stop; explicit
 *   onExhausted=advance + onFreeze stop-and-report ⇒ advance;
 * - targets (B3): enum-illegal values are rejected at parse; a topology
 *   loop-back fails closed `exhaustion_target_loops_back`;
 * - mapping: max_loop_cycles ⇒ review_loop_budget_exhausted (问题 19).
 */

import { describe, expect, it } from "bun:test";
import { parseAutoJob, type AutoJobConfig } from "../../core/auto-pipeline/job-schema";
import {
  canonicalLoopExit,
  resolveExhaustionLoop,
  resolveExhaustionTarget,
  EXHAUSTION_REASON_TO_DEGRADED_REASON,
} from "../../core/auto-pipeline/loop-exhaustion";
import { resolveFreezeAction, isUnresolvableFreeze } from "../../core/auto-pipeline/freeze-autopilot";
import { makeTestConfig, makeTestMeta } from "../helpers";
import type { AutoJobState } from "../../core/auto-pipeline/job-state";

function job(withExhausted?: { designReview?: string; reviewFix?: string }, withTarget?: string): AutoJobConfig {
  const lines = [
    "version: 1",
    "enabled: false",
    "tier: rule",
    "docs:",
    "  list:",
    "    - doc: docs/design/x_Feat.md",
    ...(withExhausted?.designReview !== undefined || withExhausted?.reviewFix !== undefined
      ? ["onExhausted:", ...(withExhausted?.designReview !== undefined ? [`  designReview: ${withExhausted.designReview}`] : []), ...(withExhausted?.reviewFix !== undefined ? [`  reviewFix: ${withExhausted.reviewFix}`] : [])]
      : []),
    ...(withTarget !== undefined ? ["onExhaustedTarget:", `  designReview: ${withTarget}`] : []),
  ];
  const res = parseAutoJob(lines.join("\n"), "test");
  if (!res.ok) throw new Error(res.errors.join("; "));
  return res.job;
}

function state(): AutoJobState {
  return {
    schemaVersion: 1,
    jobId: "j",
    jobPath: "/x/j.yaml",
    jobHash: "h",
    jobTotalDocs: 1,
    docIndex: 0,
    status: "running",
    startedAt: 0,
    updatedAt: 0,
    counters: { totalLoops: 0, totalFreezes: 0, consecutiveVerifyFailures: 0, autoResumes: 0, finalGraceUsed: {}, noProgressGraceUsed: {}, designReviewRounds: {} },
    docs: [],
  };
}

const config = makeTestConfig();
// B3 asserts the PRODUCT topology: review → fix, fix → completed.
const productConfig = makeTestConfig({
  stages: {
    clarify: { nextStage: "plan" },
    plan: { nextStage: "design-review" },
    "design-review": { nextStage: "develop" },
    develop: { nextStage: "review" },
    review: { nextStage: "fix" },
    fix: { nextStage: "completed" },
    awaiting_human: { nextStage: null },
    completed: { nextStage: null },
  } as never,
});

describe("229 Phase 5: loop-first routing (问题 2)", () => {
  const reviewMeta = () =>
    makeTestMeta({
      currentStage: "review",
      pipelineId: "p",
      reviewLedger: { loop: "reviewFix", roundIndex: 2, pipelineId: "p", openIds: ["DR-1-1"], severityCounts: {}, streak: 2 },
    });
  const drMeta = () =>
    makeTestMeta({
      currentStage: "design-review",
      pipelineId: "p",
      designReview: {
        schemaVersion: 1, planDoc: "/x/p", round: 2, authorizationId: "a", authorizationSource: "menu",
        phase: "review_running", authorizedAt: Date.now(), updatedAt: Date.now(),
      },
    });

  it("review-stage no_progress_detected ⇒ reviewFix loop, exit target completed", () => {
    const j = job();
    const loop = resolveExhaustionLoop({ meta: reviewMeta(), job: j, reason: "no_progress_detected", config: productConfig });
    expect(loop).toBe("reviewFix");
    const t = resolveExhaustionTarget({ loop: "reviewFix", token: "nextStage", config: productConfig, job: j });
    expect(t.ok && t.target).toBe("completed");
  });

  it("design-review domain no_progress_detected ⇒ designReview loop, exit target develop", () => {
    const loop = resolveExhaustionLoop({ meta: drMeta(), job: job(), reason: "no_progress_detected", config: productConfig });
    expect(loop).toBe("designReview");
    const t = resolveExhaustionTarget({ loop: "designReview", token: "nextStage", config: productConfig, job: job() });
    expect(t.ok && t.target).toBe("develop");
  });

  it("no_progress with NO domain and NO review/fix stage ⇒ NOT routed", () => {
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "p" });
    expect(resolveExhaustionLoop({ meta, job: job(), reason: "no_progress_detected", config: productConfig })).toBeNull();
  });

  it("design_review_budget_exhausted without an active domain ⇒ NOT routed", () => {
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "p" });
    expect(resolveExhaustionLoop({ meta, job: job(), reason: "design_review_budget_exhausted", config: productConfig })).toBeNull();
  });

  it("an explicit stop policy resolves the loop to a stop-and-report", () => {
    const meta = makeTestMeta({
      currentStage: "review", pipelineId: "p",
      reviewLedger: { loop: "reviewFix", roundIndex: 2, pipelineId: "p", openIds: [], severityCounts: {}, streak: 2 },
    });
    const j = job({ reviewFix: "stop" });
    expect(resolveExhaustionLoop({ meta, job: j, reason: "no_progress_detected", config: productConfig })).toBe("reviewFix");
    expect(resolveFreezeAction({ meta, job: j, state: state(), reason: "no_progress_detected", config: productConfig }).action).toBe("stop-and-report");
  });
});

describe("229 Phase 5: precedence (B16 / 问题 17)", () => {
  const meta = makeTestMeta({
    currentStage: "review", pipelineId: "p",
    reviewLedger: { loop: "reviewFix", roundIndex: 2, pipelineId: "p", openIds: [], severityCounts: {}, streak: 2 },
  });

  it("byReason=stop still stops", () => {
    const j = job();
    j.freezePolicy.byReason["no_progress_detected"] = "stop-and-report";
    expect(resolveFreezeAction({ meta, job: j, state: state(), reason: "no_progress_detected", config: productConfig }).action).toBe("stop-and-report");
  });

  it("onFreeze=stop-and-report WITHOUT explicit onExhausted ⇒ stop (legacy runs untouched)", () => {
    const j = job();
    j.freezePolicy.onFreeze = "stop-and-report";
    expect(
      resolveFreezeAction({ meta, job: j, state: state(), reason: "no_progress_detected", config: productConfig }).basis,
    ).toBe("on_freeze");
    expect(
      resolveFreezeAction({ meta, job: j, state: state(), reason: "no_progress_detected", config: productConfig }).action,
    ).toBe("stop-and-report");
  });

  it("explicit onExhausted=advance + onFreeze stop-and-report ⇒ advance (basis on_exhausted)", () => {
    const j = job({ reviewFix: "advance" });
    j.freezePolicy.onFreeze = "stop-and-report";
    const r = resolveFreezeAction({ meta, job: j, state: state(), reason: "max_loop_cycles", config: productConfig });
    expect({ action: r.action, basis: r.basis }).toEqual({ action: "advance", basis: "on_exhausted" });
  });

  it("loop default advance beats nothing — plain job (default stop-and-report) still advances", () => {
    const j = job();
    const r = resolveFreezeAction({ meta, job: j, state: state(), reason: "review_loop_budget_exhausted", config: productConfig });
    expect(r.action).toBe("advance");
    expect(r.basis).toBe("loop_default");
  });
});

describe("229 Phase 5: target resolution (B3 / 问题 19)", () => {
  it("onExhaustedTarget nextStage=develop for designReview is honoured", () => {
    const j = job(undefined, "nextStage");
    // the canonical chain nextStage for design-review is develop already
    expect(resolveExhaustionTarget({ loop: "designReview", token: "nextStage", config: productConfig, job: j })).toEqual({ ok: true, target: "develop" });
  });

  it("a topology loop-back fails closed (exhaustion_target_loops_back)", () => {
    const j = job();
    // reviewFix MUST NOT loop back into review
    const loopBack = makeTestConfig({
      stages: {
        ...productConfig.stages,
        fix: { nextStage: "review" } as never,
      },
    });
    const t = resolveExhaustionTarget({ loop: "reviewFix", token: "nextStage", config: loopBack, job: j });
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.code).toBe("exhaustion_target_loops_back");
  });

  it("awaiting_human token resolves the parking stage (always ok)", () => {
    const t = resolveExhaustionTarget({ loop: "designReview", token: "awaiting_human", config: productConfig, job: job() });
    expect(t.ok && t.target).toBe("awaiting_human");
  });

  it("canonical exits (B3) are the loop's own OUT stage", () => {
    expect(canonicalLoopExit(productConfig, "designReview")).toBe("develop");
    expect(canonicalLoopExit(productConfig, "reviewFix")).toBe("completed");
  });

  it("reason mapping (问题 19): max_loop_cycles ⇒ review_loop_budget_exhausted", () => {
    expect(EXHAUSTION_REASON_TO_DEGRADED_REASON["max_loop_cycles"]).toBe("review_loop_budget_exhausted");
    expect(EXHAUSTION_REASON_TO_DEGRADED_REASON["no_progress_detected"]).toBe("no_progress_detected");
  });
});
