/**
 * 219 Phase 3 §7c (B2): the INDEPENDENT design-review round budget.
 *
 * Key behaviors:
 * - Counting is deduped by round number and monotonic: a rewind never refunds.
 * - The predicate is consulted ONLY at pre-dispatch points. The B2 end-to-end
 *   invariant is exercised here: the Nth round's PASS advances to develop
 *   (`handleReviewRunning` never freezes) while the (N+1)th DISPATCH freezes.
 * - Human mode (no `meta.autoJob`) is inert.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineConfig, SessionMeta } from "../../types";
import { makeTestConfig, makeTestMeta, reviewReportContent, boundReviewOperation } from "../helpers";
import { matchCommitExpectation } from "../../core/session-state";
import { computeHash, createInitialState } from "../../core/design-review/state";
import type { CoordinatorContext } from "../../core/design-review/coordinator";
import { coordinateDesignReview } from "../../core/design-review/coordinator";
import {
  isDesignReviewRoundBudgetExhausted,
  noteDesignReviewDispatch,
} from "../../core/auto-pipeline/round-budget";

const REVIEW_OP_ID = "op-review-round-budget";
const AUTO_JOB = {
  jobId: "alpha",
  jobPath: "docs/jobs/alpha.yaml",
  docIndex: 0,
  totalDocs: 1,
};

describe("round-budget — pure counting", () => {
  it("human mode (no autoJob) → null patch and never exhausted", () => {
    const meta = makeTestMeta();
    expect(noteDesignReviewDispatch(meta, 3)).toBeNull();
    expect(isDesignReviewRoundBudgetExhausted(meta)).toBe(false);
  });

  it("round undefined → null patch", () => {
    const meta = makeTestMeta({ autoJob: { ...AUTO_JOB, designReviewMaxRounds: 2 } });
    expect(noteDesignReviewDispatch(meta, undefined)).toBeNull();
  });

  it("first dispatch → +1 and records the round", () => {
    const meta = makeTestMeta({ autoJob: { ...AUTO_JOB, designReviewMaxRounds: 2 } });
    expect(noteDesignReviewDispatch(meta, 1)).toEqual({
      autoJob: { ...AUTO_JOB, designReviewMaxRounds: 2, designReviewRounds: 1, lastCountedDesignReviewRound: 1 },
    });
  });

  it("the same round twice counts once", () => {
    const meta = makeTestMeta({
      autoJob: { ...AUTO_JOB, designReviewMaxRounds: 5, designReviewRounds: 1, lastCountedDesignReviewRound: 1 },
    });
    expect(noteDesignReviewDispatch(meta, 1)).toBeNull();
  });

  it("increasing rounds count one per dispatch", () => {
    let auto = { ...AUTO_JOB, designReviewMaxRounds: 5, designReviewRounds: 0, lastCountedDesignReviewRound: 0 };
    for (const round of [1, 2, 3]) {
      const patch = noteDesignReviewDispatch(makeTestMeta({ autoJob: auto }), round);
      expect(patch).not.toBeNull();
      auto = (patch!.autoJob as typeof auto)!;
      expect(auto.designReviewRounds).toBe(round);
    }
  });

  it("a rewind (lower round number) never refunds budget", () => {
    const meta = makeTestMeta({
      autoJob: { ...AUTO_JOB, designReviewMaxRounds: 5, designReviewRounds: 3, lastCountedDesignReviewRound: 3 },
    });
    expect(noteDesignReviewDispatch(meta, 2)).toBeNull();
    expect(meta.autoJob?.designReviewRounds).toBe(3);
  });

  it("predicate is false before the threshold and true at it", () => {
    const at = (rounds: number, max: number | undefined) =>
      isDesignReviewRoundBudgetExhausted(
        makeTestMeta({ autoJob: { ...AUTO_JOB, designReviewRounds: rounds, designReviewMaxRounds: max } }),
      );
    expect(at(1, 3)).toBe(false);
    expect(at(2, 3)).toBe(false);
    expect(at(3, 3)).toBe(true);
    expect(at(4, 3)).toBe(true);
    // No threshold configured ⇒ budget not active.
    expect(at(99, undefined)).toBe(false);
  });
});

describe("round-budget — B2 end-to-end (coordinator)", () => {
  let tempDir: string;
  let planDoc: string;
  let planHash: string;
  let config: PipelineConfig;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-219-round-budget-"));
    planDoc = join(tempDir, "plan.md");
    const planContent = "# Test Plan\n\nContent here.";
    await writeFile(planDoc, planContent, "utf-8");
    planHash = computeHash(planContent);
    config = makeTestConfig({
      projectRoot: tempDir,
      maxLoopCycles: 3,
      stages: {
        ...makeTestConfig().stages,
        develop: {
          agentPath: "./agents/develop.md",
          skillPath: "develop/SKILL.md",
          nextStage: "completed",
          requireDomain: false,
        },
      },
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createMockSession(meta: SessionMeta) {
    let currentMeta = { ...meta };
    return {
      getMeta: () => currentMeta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        currentMeta = { ...currentMeta, ...patch };
        return currentMeta;
      },
      updateMetaVerified: (
        patch: Partial<SessionMeta>,
        expected: import("../../core/session-state").MetaCommitExpectation,
      ): import("../../types").ReliableMetaCommitResult => {
        const conflict = matchCommitExpectation(currentMeta, expected);
        if (conflict) return { status: "conflict", reason: conflict };
        currentMeta = { ...currentMeta, ...patch };
        return { status: "persisted", meta: currentMeta };
      },
    };
  }

  function coordinatorCtx(meta: SessionMeta): CoordinatorContext {
    return {
      config,
      session: createMockSession(meta),
      ui: { notify: () => {} },
      pi: { sendUserMessage: () => {} },
      spawnOverride: async () => ({
        spawned: true,
        fallback: false,
        deferred: false,
        agentId: "agent-round-budget",
        dispatchOutcome: "spawned_id" as const,
      }),
    };
  }

  async function writePassReport(input?: { operationId?: string; round?: number }): Promise<void> {
    await writeFile(
      join(tempDir, `Design_Review_${input?.round ?? 1}_plan_Design.md`),
      reviewReportContent({
        pipelineId: "pipe-test-001",
        planDoc,
        round: input?.round ?? 1,
        operationId: input?.operationId ?? REVIEW_OP_ID,
        inputHash: planHash,
        verdict: "PASS",
      }),
      "utf-8",
    );
  }

  it("Nth PASS advances to develop even when the budget is already used up", async () => {
    await writePassReport();
    const drState = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-test-001" });
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: {
        ...drState,
        phase: "review_running",
        round: 1,
        operation: boundReviewOperation(REVIEW_OP_ID, planHash),
      },
      loopCycleCount: 0,
      autoJob: { ...AUTO_JOB, designReviewMaxRounds: 1, designReviewRounds: 1, lastCountedDesignReviewRound: 1 },
    });
    const ctx = coordinatorCtx(meta);

    const result = await coordinateDesignReview(ctx, meta, "settle");

    // handleReviewRunning CONSUMES a dispatched round — it must never freeze.
    expect(result.status === "handled" && result.action === "advanced").toBe(true);
    expect(ctx.session.getMeta()!.currentStage).toBe("develop");
  });

  it("the (N+1)th DISPATCH freezes with design_review_budget_exhausted", async () => {
    const drState = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-test-001" });
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: { ...drState, phase: "review_ready", round: 2 },
      loopCycleCount: 0,
      autoJob: { ...AUTO_JOB, designReviewMaxRounds: 1, designReviewRounds: 1, lastCountedDesignReviewRound: 1 },
    });
    const ctx = coordinatorCtx(meta);

    const result = await coordinateDesignReview(ctx, meta, "settle");

    expect(result).toEqual({
      status: "handled",
      action: "frozen",
      reason: "design_review_budget_exhausted",
    });
  });

  it("a first dispatch under a 1-round budget is NOT frozen; consuming it counts exactly once", async () => {
    const drState = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-test-001" });
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: { ...drState, phase: "review_ready", round: 1 },
      loopCycleCount: 0,
      autoJob: { ...AUTO_JOB, designReviewMaxRounds: 1, designReviewRounds: 0, lastCountedDesignReviewRound: 0 },
    });
    const ctx = coordinatorCtx(meta);

    const dispatched = await coordinateDesignReview(ctx, meta, "settle");
    expect(dispatched).not.toEqual({
      status: "handled",
      action: "frozen",
      reason: "design_review_budget_exhausted",
    });

    // The counter advances when the dispatched round's outcome is consumed
    // (single coordination entry, deduped by round number) — never at the
    // dispatch call itself, and never twice.
    const runningMeta = ctx.session.getMeta()!;
    const runningOp = runningMeta.designReview?.operation;
    await writePassReport({ operationId: runningOp?.operationId, round: runningMeta.designReview?.round });
    const consumed = await coordinateDesignReview(ctx, runningMeta, "settle");
    expect(consumed.status === "handled" && consumed.action === "advanced").toBe(true);
    expect(ctx.session.getMeta()!.autoJob?.designReviewRounds).toBe(1);
    expect(ctx.session.getMeta()!.autoJob?.lastCountedDesignReviewRound).toBe(1);
  });

  it("human mode keeps the coordinator behaviour unchanged (no auto freeze)", async () => {
    const drState = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-test-001" });
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: { ...drState, phase: "review_ready", round: 2 },
      loopCycleCount: 0,
    });
    const ctx = coordinatorCtx(meta);

    const result = await coordinateDesignReview(ctx, meta, "settle");

    expect(result).not.toEqual({
      status: "handled",
      action: "frozen",
      reason: "design_review_budget_exhausted",
    });
    expect(ctx.session.getMeta()!.autoJob).toBeUndefined();
  });
});
