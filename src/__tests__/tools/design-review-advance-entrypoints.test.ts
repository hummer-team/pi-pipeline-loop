/**
 * 192 Phase 3 rewrite: design-review consistency across entry points under
 * the trusted verification contract.
 *
 * All four triggers (settle/advance/verify/handoff) consume the SAME shared
 * verification outcome with the SAME budget semantics (F05); fixtures carry
 * the full identity contract (K07).
 *
 * No mock.module() used — writeAuditLog is safe (returns early without
 * auditDir); controlled spawnOverride returns verifiable agentIds.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineConfig, SessionMeta } from "../../types";
import {
  makeTestConfig,
  makeTestMeta,
  reviewReportContent,
  boundReviewOperation,
} from "../helpers";
import { matchCommitExpectation } from "../../core/session-state";
import { clearAllDecisionTimers } from "../../core/flow-state";
import { computeHash, createInitialState } from "../../core/design-review/state";
import type { CoordinatorContext } from "../../core/design-review/coordinator";
import { coordinateDesignReview } from "../../core/design-review/coordinator";
import { createPipelineVerify } from "../../tools/pipeline-verify";
import { createPipelineHandoff } from "../../tools/pipeline-handoff";
import { createStageAdvancer } from "../../core/stage-advancer";

const OP_ID = "op-entry-review-1";

afterAll(() => {
  // 193: tests here may freeze with a pending decision; clear retry timers so
  // real-timer backoff chains never leak across test files in one bun process.
  clearAllDecisionTimers();
});

describe("design-review multi-entrypoint consistency", () => {
  let tempDir: string;
  let planDoc: string;
  let planHash: string;
  let config: PipelineConfig;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dr-entrypoints-"));
    planDoc = join(tempDir, "plan.md");
    const planContent = "# Test Plan\n\nContent here.";
    await writeFile(planDoc, planContent, "utf-8");
    planHash = computeHash(planContent);

    config = makeTestConfig({
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

  function createCoordinatorCtx(meta: SessionMeta, cfg?: PipelineConfig): CoordinatorContext {
    return {
      config: cfg ?? config,
      session: createMockSession(meta),
      ui: { notify: () => {} },
      pi: { sendUserMessage: () => {} },
      spawnOverride: async () => ({
        spawned: true,
        fallback: false,
        deferred: false,
        agentId: "agent-entry-1",
        dispatchOutcome: "spawned_id" as const,
      }),
    };
  }

  async function writePassReport(): Promise<void> {
    const reportDoc = join(tempDir, "review-design-1-plan.md");
    await writeFile(reportDoc, reviewReportContent({
      pipelineId: "pipe-test-001",
      planDoc,
      round: 1,
      operationId: OP_ID,
      inputHash: planHash,
      verdict: "PASS",
    }), "utf-8");
  }

  function reviewRunningMeta(loopCycleCount: number): SessionMeta {
    const drState = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-test-001" });
    return makeTestMeta({
      currentStage: "design-review",
      designReview: {
        ...drState,
        phase: "review_running",
        round: 1,
        operation: boundReviewOperation(OP_ID, planHash),
      },
      loopCycleCount,
    });
  }

  describe("budget boundary consistency", () => {
    for (const count of [0, 1, 2]) {
      test(`cycle count ${count} allows PASS routing`, async () => {
        await writePassReport();
        const meta = reviewRunningMeta(count);
        const ctx = createCoordinatorCtx(meta);
        const result = await coordinateDesignReview(ctx, meta, "settle");
        expect(result.status === "handled" && result.action === "advanced").toBe(true);
      });
    }

    test("cycle count at max freezes before routing", async () => {
      await writePassReport();
      const meta = reviewRunningMeta(3);
      const ctx = createCoordinatorCtx(meta);
      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status === "handled" && result.action === "frozen").toBe(true);
      // Frozen verdict must not consume the report path
      expect(ctx.session.getMeta()!.designReview?.phase).toBe("review_running");
    });
  });

  /**
   * 192 Phase 3 task 10 (issue-1 fix): ready phases must NOT return
   * not-applicable for verify/handoff triggers — an active authorized loop
   * consumes those triggers as pending with zero dispatch and zero stage
   * movement, so pipeline_verify / pipeline_handoff cannot fall through to
   * their ordinary-stage branches (interface constraint: ready/running/
   * pass_ready/paused all handled).
   */
  describe("ready-phase gating (192 Phase 3 task 10 / F05)", () => {
    function readyMeta(phase: "review_ready" | "update_ready"): SessionMeta {
      const drState = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-test-001" });
      return makeTestMeta({
        currentStage: phase === "review_ready" ? "design-review" : "plan",
        designReview: { ...drState, phase, round: 1 },
        loopCycleCount: 0,
      });
    }

    for (const phase of ["review_ready", "update_ready"] as const) {
      test(`${phase}: verify/handoff are handled as pending — zero dispatch, no state movement`, async () => {
        let spawnCalls = 0;
        const meta = readyMeta(phase);
        const ctx: CoordinatorContext = {
          config,
          session: createMockSession(meta),
          ui: { notify: () => {} },
          pi: { sendUserMessage: () => {} },
          spawnOverride: async () => {
            spawnCalls++;
            return {
              spawned: true,
              fallback: false,
              deferred: false,
              agentId: "agent-must-not-spawn",
              dispatchOutcome: "spawned_id" as const,
            };
          },
        };
        for (const trigger of ["verify", "handoff"] as const) {
          const result = await coordinateDesignReview(ctx, meta, trigger);
          // Explicitly handled/pending — never not-applicable (no ordinary fallback)
          expect(result.status === "handled" && result.action === "pending").toBe(true);
        }
        expect(spawnCalls).toBe(0);
        // Phase and stage untouched by the gated triggers
        expect(ctx.session.getMeta()?.designReview?.phase).toBe(phase);
        expect(ctx.session.getMeta()?.currentStage).toBe(meta.currentStage);
        // No operation was created by the blocked triggers
        expect(ctx.session.getMeta()?.designReview?.operation).toBeUndefined();
      });
    }

    test("absent designReview state keeps falling through (not this feature)", async () => {
      // Guard: the gating applies only to an ACTIVE authorized loop; a
      // session without design-review state must stay not-applicable.
      const meta = makeTestMeta({ currentStage: "design-review" });
      const ctx = {
        config,
        session: createMockSession(meta),
        ui: { notify: () => {} },
        pi: { sendUserMessage: () => {} },
      };
      const result = await coordinateDesignReview(ctx, meta, "verify");
      expect(result.status).toBe("not-applicable");
    });
  });

  describe("trigger consistency across entries (F05)", () => {
    test("settle/advance/verify/handoff all handle the same report identically", async () => {

      await writePassReport();
      const actions: string[] = [];
      for (const trigger of ["settle", "advance", "verify", "handoff"] as const) {
        const meta = reviewRunningMeta(0);
        const ctx = createCoordinatorCtx(meta);
        const result = await coordinateDesignReview(ctx, meta, trigger);
        expect(result.status).toBe("handled");
        if (result.status === "handled") actions.push(result.action);
      }
      // Every entry consumed the same way — none fell back to not-applicable
      expect(actions).toEqual(["advanced", "advanced", "advanced", "advanced"]);
    });

    test("identity-invalid report is verify_failed on every trigger", async () => {
      const reportDoc = join(tempDir, "review-design-1-plan.md");
      await writeFile(reportDoc, reviewReportContent({
        pipelineId: "foreign-pipeline",
        planDoc,
        round: 1,
        operationId: OP_ID,
        inputHash: planHash,
        verdict: "PASS",
      }), "utf-8");
      for (const trigger of ["settle", "advance", "verify", "handoff"] as const) {
        const meta = reviewRunningMeta(0);
        const ctx = createCoordinatorCtx(meta);
        const result = await coordinateDesignReview(ctx, meta, trigger);
        expect(result.status === "handled" && result.action === "verify_failed").toBe(true);
        expect(ctx.session.getMeta()!.currentStage).toBe("design-review");
      }
    });
  });

  describe("plan hash drift detection", () => {
    test("plan hash drifted blocks PASS with pending (no develop entry)", async () => {
      await writePassReport();
      // Drift the plan AFTER the report was produced: state.planHash stays,
      // file changes → handlePass drift path pauses (drift), never advances.
      await writeFile(planDoc, "# Test Plan\n\nTampered after review.\n", "utf-8");
      const meta = reviewRunningMeta(0);
      const ctx = createCoordinatorCtx(meta);
      const result = await coordinateDesignReview(ctx, meta, "settle");
      // Domain identity check still passes (report bound to authorized hash);
      // handlePass re-reads the plan and pauses on drift.
      expect(result.status === "handled" && result.action === "pending").toBe(true);
      expect(ctx.session.getMeta()!.currentStage).toBe("design-review");
      expect(ctx.session.getMeta()!.designReview?.pauseReason).toBe("drift");
    });
  });

  /**
   * 193 Phase 0 (task 5, acceptance "每入口一次预算、工具 success=false"):
   * every wired tool entry must report an invalid design-review report
   * HONESTLY — success=false, exactly ONE retry-budget attempt for the call,
   * the corrective guidance shown proactively, zero dispatch and zero stage
   * movement. The old mapping (`success = action !== frozen && !== pending`)
   * reported these failures as success and silently stopped the loop.
   */
  describe("honest failure results across tool entries (193 Phase 0)", () => {
    function makeToolCtx(meta: SessionMeta) {
      const session = createMockSession(meta);
      const notifications: string[] = [];
      return {
        session,
        ui: {
          notify: (msg: string) => {
            notifications.push(msg);
          },
          setStatus: () => {},
          select: async () => {
            throw new Error("a tool entry must not open the human menu below budget");
          },
        },
        pi: {
          sendUserMessage: () => {
            throw new Error("a tool entry must never wake the model");
          },
        },
        _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
        notifications,
      };
    }

    /** Report that parses as a review report but breaks the 193 structure contract. */
    async function writeContractInvalidReport(): Promise<void> {
      await writeFile(
        join(tempDir, "review-design-1-plan.md"),
        reviewReportContent({
          pipelineId: "pipe-test-001",
          planDoc,
          round: 1,
          operationId: OP_ID,
          inputHash: planHash,
          verdict: "PASS",
          includeSummarySection: false,
        }),
        "utf-8",
      );
    }

    function expectHonestFailure(
      result: Record<string, unknown>,
      session: ReturnType<typeof createMockSession>,
      notifications: string[],
    ): void {
      expect(result.success).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.action).toBe("verify_failed");
      const message = String(result.message);
      // concrete defect AND the corrective template render through the result
      expect(message).toContain("missing Summary section heading");
      expect(message).toContain("Identity this report MUST carry");
      expect(message).not.toContain("SKILL output format requirements");
      // exactly one budget attempt for this one call
      expect(session.getMeta()?.verifyAttempts).toBe(1);
      // zero dispatch, zero stage movement, review stays running
      expect(session.getMeta()?.currentStage).toBe("design-review");
      expect(session.getMeta()?.designReview?.phase).toBe("review_running");
      // tool entries never wake the model: guidance is shown proactively
      expect(notifications.some((n) => n.includes("Identity this report MUST carry"))).toBe(true);
    }

    test("pipeline_verify reports a contract-invalid report honestly", async () => {
      await writeContractInvalidReport();
      const ctx = makeToolCtx(reviewRunningMeta(0));
      const tool = createPipelineVerify(config);
      const result = (await tool.execute({}, ctx as never)) as Record<string, unknown>;
      expectHonestFailure(result, ctx.session, ctx.notifications);
    });

    test("stage_advance reports a contract-invalid report honestly", async () => {
      await writeContractInvalidReport();
      const ctx = makeToolCtx(reviewRunningMeta(0));
      const tool = createStageAdvancer(config);
      const result = (await tool.execute({}, ctx as never)) as Record<string, unknown>;
      expectHonestFailure(result, ctx.session, ctx.notifications);
    });

    test("pipeline_handoff reports a contract-invalid report honestly", async () => {
      await writeContractInvalidReport();
      const ctx = makeToolCtx(reviewRunningMeta(0));
      const tool = createPipelineHandoff(config);
      const result = (await tool.execute({ nextStage: "develop" }, ctx as never)) as Record<string, unknown>;
      expectHonestFailure(result, ctx.session, ctx.notifications);
    });

    test("a NEW call is a NEW attempt; the same call never double-counts", async () => {
      await writeContractInvalidReport();
      const ctx = makeToolCtx(reviewRunningMeta(0));
      const tool = createPipelineVerify(config);
      await tool.execute({}, ctx as never);
      await tool.execute({}, ctx as never);
      expect(ctx.session.getMeta()?.verifyAttempts).toBe(2);
    });
  });

  describe("update mode validation", () => {
    test("update with no actual change returns pending", async () => {
      const drState = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-test-001" });
      // Production layout: an authorized update runs in the PLAN stage — the
      // trusted update verification context exists only there.
      const meta = makeTestMeta({
        currentStage: "plan",
        designReview: {
          ...drState,
          phase: "update_running",
          round: 1,
          operation: {
            operationId: "op-entry-update-1",
            kind: "update" as const,
            stageVisitId: Date.now(),
            attempt: 1,
            dispatchState: "dispatched" as const,
            agentId: "agent-u",
            round: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
        loopCycleCount: 0,
      });
      // plan unchanged → no-change pause
      const ctx = createCoordinatorCtx(meta);
      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status === "handled" && result.action === "pending").toBe(true);
      expect(ctx.session.getMeta()!.designReview?.phase).toBe("paused");
    });
  });
});
