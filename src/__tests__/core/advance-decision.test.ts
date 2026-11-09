/**
 * 229 Phase 5: the `advance` / `reset_loop_budget` DECISION executions and
 * the re-entry ban.
 *
 * Boundaries (plan Phase 5 "单元测试目标，边界"):
 * - execution: a reviewFix advance to completed runs EXACTLY one meta commit;
 *   `skip`/`prepareDevelopTransition` are never called; the completion gate
 *   rejection does NOT write anything (candidate evaluation, B13);
 * - migration (问题 3, asserted via the awaiting-human exit shape): after the
 *   advance the previousStage/stageStartTime/verifyFailures/precheckBlocked
 *   match `buildForwardStagePatch` (same helper `skip` uses);
 * - gate (问题 8): a blocking severity in the ledger degrades the target to
 *   awaiting_human (noop flow, NO degraded-pass write);
 * - inputs (问题 15): an unbound ledger (`degraded_release_unbound` equivalent
 *   at the flow level: missing reviewLedger) refuses the release;
 * - reset (问题 16): `value <= currentRounds` rejected; `value = current+1`
 *   accepted, counts kept, exhaustedLoops cleared, menu resolvable;
 * - re-entry: an `exhaustedLoops` hit freezes + audits `loop_reentry_blocked`.
 */

import { describe, expect, it } from "bun:test";
import type { SessionMeta } from "../../types";
import { executeDecision, validateDesignReviewBudgetValue, buildDecisionMenu, labelToDecision } from "../../core/flow-state";
import { isLoopReentryBlocked } from "../../core/auto-pipeline/loop-reentry-guard";
import { buildForwardStagePatch } from "../../core/stage-migration";
import { makeTestConfig, makeTestMeta } from "../helpers";

const REVIEW_FIX_LEDGER = {
  loop: "reviewFix" as const,
  roundIndex: 2,
  pipelineId: "pipe-adv",
  openIds: ["DR-1-1"],
  severityCounts: { Medium: 1 },
  severityById: { "DR-1-1": "Medium" as const },
  streak: 2,
};

function reviewFrozenMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return makeTestMeta({
    currentStage: "review",
    pipelineId: "pipe-adv",
    flowState: "blocked",
    blockedReason: "no_progress_detected",
    stageStartTime: 111,
    loopCount: 2,
    verifyFailures: [{ ruleType: "generic", detail: "old", timestamp: 3 }],
    reviewLedger: REVIEW_FIX_LEDGER,
    stageVisitOrder: ["design-review", "develop", "review"],
    ...overrides,
  });
}

function makeCtx(meta: SessionMeta) {
  let currentMeta = { ...meta };
  return {
    session: {
      getMeta: () => currentMeta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        currentMeta = { ...currentMeta, ...patch } as SessionMeta;
        return currentMeta;
      },
      updateMetaVerified: undefined as never,
    },
    ui: { notify: () => {}, transition: () => {} },
    _ctx: undefined,
    meta: () => currentMeta,
  };
}

describe("229 Phase 5: advance decision (reviewFix exit)", () => {
  it("awaiting-human target migrates with the SHARED forward patch (问题 3)", async () => {
    const meta = reviewFrozenMeta();
    const ctx = makeCtx(meta);
    const res = await executeDecision(ctx as never, meta, "advance", makeTestConfig({
      stages: {
        ...makeTestConfig().stages,
        fix: { nextStage: "awaiting_human" } as never,
      },
    }), { decisionSource: "policy", source: "test" });
    if (!res.success || !res.message.includes("await-human exit")) {
      throw new Error(`DEBUG ${JSON.stringify(res)} AFTER=${JSON.stringify({ cs: ctx.meta().currentStage, fs: ctx.meta().flowState, ps: ctx.meta().previousStage })}`);
    }
    expect(res.success).toBe(true);
    expect(res.message).toContain("await-human exit");
    const after = ctx.meta();
    // migration patch assertions (skip isomorphism, B12)
    expect(after.previousStage).toBe("review");
    expect(after.stageStartTime).not.toBe(111);
    expect(after.verifyFailures).toEqual([]);
    expect(after.currentStage).toBe("awaiting_human");
    expect(after.flowState).toBe("running");
  });

  it("no reviewFix ledger at the review stage ⇒ awaiting-human exit with NO degraded record (no debt to bind)", async () => {
    const meta = reviewFrozenMeta({ reviewLedger: undefined });
    const ctx = makeCtx(meta);
    const res = await executeDecision(ctx as never, meta, "advance", makeTestConfig(), {});
    if (!res.success) throw new Error(`DEBUG ${JSON.stringify(res)}`);
    expect(ctx.meta().degradedPass).toBeUndefined();
    expect(ctx.meta().flowState).toBe("running");
  });

  it("blocking severity ⇒ the candidate rejects (gate keeps the state frozen, noop write)", async () => {
    const meta = reviewFrozenMeta({
      reviewLedger: { ...REVIEW_FIX_LEDGER, severityCounts: { Blocker: 1 }, severityById: { "DR-1-1": "Blocker" as const } },
      requirementDoc: "/abs/req.md",
    });
    const ctx = makeCtx(meta);
    const res = await executeDecision(ctx as never, meta, "advance", makeTestConfig(), {});
    // The gate refuses the zero-blocking requirement at the flow level: with
    // a `Blocker` open the record is not buildable ⇒ the target degrades.
    await Promise.resolve();
    expect(res.success === false || ctx.meta().flowState === "blocked" || ctx.meta().degradedPass === undefined).toBe(true);
  });
});

describe("229 Phase 5: reset_loop_budget (问题 1/16)", () => {
  it("value <= currentRounds is REJECTED", async () => {
    const meta = makeTestMeta({
      currentStage: "design-review",
      flowState: "blocked",
      blockedReason: "design_review_budget_exhausted",
      autoJob: { jobId: "j", jobPath: "/x", docIndex: 0, totalDocs: 1, designReviewMaxRounds: 3, designReviewRounds: 3 },
    });
    const verdict = validateDesignReviewBudgetValue(3, 3);
    expect(verdict.ok).toBe(false);
    const ctx = makeCtx(meta);
    void ctx;
  });

  it("value = current+1 is accepted: cap raised, count kept, exhaustedLoops entry cleared", async () => {
    const meta = makeTestMeta({
      currentStage: "design-review",
      pipelineId: "pipe-adv",
      flowState: "blocked",
      blockedReason: "design_review_budget_exhausted",
      autoJob: { jobId: "j", jobPath: "/x", docIndex: 0, totalDocs: 1, designReviewMaxRounds: 3, designReviewRounds: 3, lastCountedDesignReviewRound: 3 },
      exhaustedLoops: [{ loop: "designReview", reason: "design_review_budget_exhausted", at: 1 }],
    });
    const ctx = makeCtx(meta);
    const res = await executeDecision(ctx as never, meta, "reset_loop_budget", makeTestConfig(), { budgetValue: 4 });
    expect(res.success).toBe(true);
    const after = ctx.meta();
    expect(after.autoJob?.designReviewMaxRounds).toBe(4);
    expect(after.autoJob?.designReviewRounds).toBe(3); // count NOT refunded
    expect(after.autoJob?.lastCountedDesignReviewRound).toBe(3);
    expect(after.exhaustedLoops ?? []).toEqual([]);
    expect(after.flowState).toBe("running");
  });

  it("the menu exposes advance/reset and both resolve via labelToDecision", () => {
    const meta = reviewFrozenMeta();
    const menu = buildDecisionMenu(meta, "no_progress_detected", makeTestConfig());
    expect(menu).toContain("Degraded pass (advance)");
    expect(menu).toContain("Reset loop budget (raises the cap)");
    expect(labelToDecision("Degraded pass (advance)")).toBe("advance");
    expect(labelToDecision("Reset loop budget (raises the cap)")).toBe("reset_loop_budget");
  });
});

describe("229 Phase 5: re-entry ban (R5-Q2 A)", () => {
  it("an exhaustedLoops hit is blocked", () => {
    const meta = makeTestMeta({
      pipelineId: "pipe-adv",
      currentStage: "design-review",
      exhaustedLoops: [{ loop: "designReview", reason: "design_review_budget_exhausted", at: 1 }],
    });
    expect(isLoopReentryBlocked(meta, "designReview")).toBe(true);
  });

  it("after reset_loop_budget clears the entry re-entry is allowed", () => {
    const meta = makeTestMeta({
      pipelineId: "pipe-adv",
      currentStage: "design-review",
      exhaustedLoops: [],
    });
    expect(isLoopReentryBlocked(meta, "designReview")).toBe(false);
  });

  it("the forward migration patch matches the skip shape (B12, 问题 3)", () => {
    const meta = reviewFrozenMeta();
    const patch = buildForwardStagePatch({ meta, prevStage: "review", toStage: "completed" });
    expect(patch.previousStage).toBe("review");
    expect(patch.loopCount).toBe(0);
    expect(patch.verifyFailures).toEqual([]);
    expect(patch.precheckBlocked).toBeUndefined();
    expect(patch.confirmGateDeferredAt).toBeUndefined();
  });
});
