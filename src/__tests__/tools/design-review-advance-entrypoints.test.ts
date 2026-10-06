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

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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
import { computeHash, createInitialState } from "../../core/design-review/state";
import type { CoordinatorContext } from "../../core/design-review/coordinator";
import { coordinateDesignReview } from "../../core/design-review/coordinator";

const OP_ID = "op-entry-review-1";

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

  describe("update mode validation", () => {
    test("update with no actual change returns pending", async () => {
      const drState = createInitialState(planDoc, "menu", planHash, undefined, { pipelineId: "pipe-test-001" });
      const meta = makeTestMeta({
        currentStage: "design-review",
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
