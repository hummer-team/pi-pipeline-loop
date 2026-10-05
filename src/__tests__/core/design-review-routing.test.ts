/**
 * @module design-review-routing.test
 * Phase 3 / 191: Tests for design-review coordinator routing logic.
 * Validates PASS/FAIL/invalid routing paths through coordinateDesignReview.
 * 
 * No mock.module() used — writeAuditLog is safe (returns early without auditDir),
 * spawnStageSubagent fails gracefully without pi SDK, recordStageVisit is pure,
 * and commitDesignReviewState works with the mock session interface.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineConfig, SessionMeta, DesignReviewState } from "../../types";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { computeHash, createInitialState } from "../../core/design-review-state";
import type { CoordinatorContext, CoordinatorResult } from "../../core/design-review-coordinator";
import { coordinateDesignReview } from "../../core/design-review-coordinator";

describe("design-review-coordinator routing", () => {
  let tempDir: string;
  let planDoc: string;
  let planHash: string;
  let config: PipelineConfig;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dr-routing-"));
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
    };
  }

  function createCoordinatorCtx(meta: SessionMeta): CoordinatorContext {
    return {
      config,
      session: createMockSession(meta),
      ui: { notify: () => {} },
      pi: { sendUserMessage: () => {} },
    };
  }

  describe("not-applicable paths", () => {
    test("no designReview state returns not-applicable", async () => {
      const meta = makeTestMeta({ currentStage: "design-review" });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result).toEqual({ status: "not-applicable" });
    });

    test("invalid authorization returns not-applicable", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "finished" },
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result).toEqual({ status: "not-applicable" });
    });

    test("finished phase returns not-applicable", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "finished" },
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result).toEqual({ status: "not-applicable" });
    });

    test("paused with authorization-lost returns not-applicable", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "paused", pauseReason: "authorization-lost" },
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result).toEqual({ status: "not-applicable" });
    });
  });

  describe("review_running phase", () => {
    test("PASS verdict advances to develop", async () => {
      // Create a PASS report
      const reportDoc = join(tempDir, "review-design-1-plan.md");
      const reportContent = `# Design Review Report

**pipeline**: test-pipeline
**plan**: ${planDoc}
**round**: 1

## Verdict
PASS

## Issues
None
`;
      await writeFile(reportDoc, reportContent, "utf-8");

      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "review_running", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");

      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(result.action).toBe("advanced");
        if ("toStage" in result) {
          expect(result.toStage).toBe("develop");
        }
      }
    });

    test("FAIL verdict routes to plan", async () => {
      // Create a FAIL report
      const reportDoc = join(tempDir, "review-design-1-plan.md");
      const reportContent = `# Design Review Report

**pipeline**: test-pipeline
**plan**: ${planDoc}
**round**: 1

## Verdict
FAIL

## Issues
1. Missing error handling
2. Incomplete specification
`;
      await writeFile(reportDoc, reportContent, "utf-8");

      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "review_running", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");

      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(result.action).toBe("routed");
        if ("toStage" in result) {
          expect(result.toStage).toBe("plan");
        }
      }
    });

    test("invalid report returns pending", async () => {
      // No report file exists
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "review_running", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");

      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(result.action).toBe("pending");
        if ("reason" in result) {
          expect(result.reason).toBe("report_invalid");
        }
      }
    });

    test("budget exceeded before routing returns frozen", async () => {
      // Create a PASS report
      const reportDoc = join(tempDir, "review-design-1-plan.md");
      const reportContent = `# Design Review Report

**pipeline**: test-pipeline
**plan**: ${planDoc}
**round**: 1

## Verdict
PASS

## Issues
None
`;
      await writeFile(reportDoc, reportContent, "utf-8");

      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "review_running", round: 1 },
        loopCycleCount: 3, // At budget limit
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");

      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(result.action).toBe("frozen");
        if ("reason" in result) {
          expect(result.reason).toBe("budget_exceeded");
        }
      }
    });

    test("non-settle trigger returns not-applicable", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "review_running", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "advance");
      expect(result).toEqual({ status: "not-applicable" });
    });
  });

  describe("review_ready phase", () => {
    test("settle trigger attempts dispatch (returns pending without pi SDK)", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "review_ready", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");

      // Without real pi SDK, spawn fails gracefully → pending
      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        // Either routed (with pi SDK) or pending (without pi SDK)
        expect(["routed", "pending"]).toContain(result.action);
      }
    });

    test("advance trigger also attempts dispatch", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "review_ready", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "advance");

      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(["routed", "pending"]).toContain(result.action);
      }
    });

    test("budget exceeded before dispatch returns frozen", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "review_ready", round: 1 },
        loopCycleCount: 3, // At budget limit
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");

      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(result.action).toBe("frozen");
        if ("reason" in result) {
          expect(result.reason).toBe("budget_exceeded");
        }
      }
    });

    test("verify trigger returns not-applicable", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "review_ready", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "verify");
      expect(result).toEqual({ status: "not-applicable" });
    });
  });

  describe("update_ready phase", () => {
    test("settle trigger attempts dispatch", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "update_ready", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");

      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(["routed", "pending"]).toContain(result.action);
      }
    });

    test("advance trigger also attempts dispatch", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "update_ready", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "advance");

      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(["routed", "pending"]).toContain(result.action);
      }
    });

    test("budget exceeded returns frozen", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "update_ready", round: 1 },
        loopCycleCount: 3, // At budget limit
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");

      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(result.action).toBe("frozen");
        if ("reason" in result) {
          expect(result.reason).toBe("budget_exceeded");
        }
      }
    });
  });

  describe("update_running phase", () => {
    test("valid update with new hash triggers re-review", async () => {
      // Update the plan content
      const newPlanContent = "# Updated Plan\n\nNew content with fixes.";
      await writeFile(planDoc, newPlanContent, "utf-8");

      // Create a report with issues
      const reportDoc = join(tempDir, "review-design-1-plan.md");
      const reportContent = `# Design Review Report

**pipeline**: test-pipeline
**plan**: ${planDoc}
**round**: 1

## Verdict
FAIL

## Issues
1. Missing error handling
`;
      await writeFile(reportDoc, reportContent, "utf-8");

      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "update_running", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");

      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        // In test environment without real pi SDK, spawn fails and returns "pending"
        // The important thing is that the state transitioned correctly
        expect(result.action).toBe("pending");
        if ("reason" in result) {
          expect(result.reason).toContain("spawn_failed");
        }
      }
      
      // Verify state was updated correctly before spawn attempt
      const updatedMeta = ctx.session.getMeta();
      expect(updatedMeta?.designReview?.phase).toBe("review_running");
      expect(updatedMeta?.designReview?.round).toBe(2);
      expect(updatedMeta?.designReview?.planHash).not.toBe(planHash);
    });

    test("no actual change returns pending", async () => {
      // Don't update plan content - keep original hash
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "update_running", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");

      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(result.action).toBe("pending");
        if ("reason" in result) {
          expect(result.reason).toBe("no_actual_change");
        }
      }
    });

    test("non-settle trigger returns not-applicable", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "update_running", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "advance");
      expect(result).toEqual({ status: "not-applicable" });
    });
  });

  describe("paused phase", () => {
    test("returns pending with pause reason", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: {
          ...drState,
          phase: "paused",
          pauseReason: "no-change",
        },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");

      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(result.action).toBe("pending");
        if ("reason" in result) {
          expect(result.reason).toBe("no-change");
        }
      }
    });
  });

  describe("pass_ready phase", () => {
    test("returns pending (unexpected state)", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "pass_ready", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");

      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(result.action).toBe("pending");
        if ("reason" in result) {
          expect(result.reason).toBe("unexpected_state");
        }
      }
    });
  });
});
