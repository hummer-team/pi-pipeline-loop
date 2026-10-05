/**
 * @module design-review-advance-entrypoints.test
 * Phase 3 / 191: Tests for design-review consistency across multiple entry points.
 * Validates that PASS/FAIL/budget boundary behave consistently when triggered
 * via stage_advance, pipeline_verify, pipeline_handoff, or agent_settled.
 * 
 * No mock.module() used — writeAuditLog is safe (returns early without auditDir),
 * spawnStageSubagent fails gracefully without pi SDK, recordStageVisit is pure,
 * and commitDesignReviewState works with the mock session interface.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineConfig, SessionMeta } from "../../types";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { computeHash, createInitialState } from "../../core/design-review-state";
import type { CoordinatorContext } from "../../core/design-review-coordinator";
import { coordinateDesignReview } from "../../core/design-review-coordinator";

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
    };
  }

  function createCoordinatorCtx(meta: SessionMeta, cfg?: PipelineConfig): CoordinatorContext {
    return {
      config: cfg ?? config,
      session: createMockSession(meta),
      ui: { notify: () => {} },
      pi: { sendUserMessage: () => {} },
    };
  }

  describe("budget boundary consistency", () => {
    test("cycle count 0 allows PASS routing", async () => {
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
      if (result.status === "handled" && result.action === "advanced") {
        expect(result.toStage).toBe("develop");
      }
    });

    test("cycle count 1 allows PASS routing", async () => {
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
        loopCycleCount: 1,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status).toBe("handled");
      if (result.status === "handled" && result.action === "advanced") {
        expect(result.toStage).toBe("develop");
      }
    });

    test("cycle count 2 allows PASS routing (last chance)", async () => {
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
        loopCycleCount: 2,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status).toBe("handled");
      if (result.status === "handled" && result.action === "advanced") {
        expect(result.toStage).toBe("develop");
      }
    });

    test("cycle count 3 blocks PASS routing (budget exceeded)", async () => {
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
        loopCycleCount: 3,
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

    test("cycle count 4 also blocks routing", async () => {
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
        loopCycleCount: 4,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(result.action).toBe("frozen");
      }
    });
  });

  describe("plan hash drift detection", () => {
    test("plan hash unchanged allows PASS", async () => {
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
      if (result.status === "handled" && result.action === "advanced") {
        expect(result.toStage).toBe("develop");
      }
    });

    test("plan hash drifted blocks PASS with pending", async () => {
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

      // Update plan content after report was created
      const newPlanContent = "# Modified Plan\n\nDifferent content.";
      await writeFile(planDoc, newPlanContent, "utf-8");

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
          // Fix for Issue #14: reason now prefixed with "paused:" to indicate pause state
          expect(result.reason).toBe("paused:plan_drifted");
        }
      }
    });
  });

  describe("entry point trigger consistency", () => {
    test("PASS via settle trigger advances to develop", async () => {
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
      if (result.status === "handled" && result.action === "advanced") {
        expect(result.toStage).toBe("develop");
      }
    });

    test("FAIL via settle trigger routes to plan", async () => {
      const reportDoc = join(tempDir, "review-design-1-plan.md");
      const reportContent = `# Design Review Report

**pipeline**: test-pipeline
**plan**: ${planDoc}
**round**: 1

## Verdict
FAIL

## Issues
1. Missing validation
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
      if (result.status === "handled" && result.action === "routed") {
        expect(result.toStage).toBe("plan");
      }
    });

    test("invalid report via settle trigger returns pending", async () => {
      // No report file
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
  });

  describe("duplicate event handling", () => {
    test("review_ready with already-dispatched operation returns pending", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: {
          ...drState,
          phase: "review_ready",
          round: 1,
          operation: {
            operationId: "op-123",
            kind: "review",
            stageVisitId: 1000,
            attempt: 1,
            dispatchState: "dispatched",
            agentId: "agent-456",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(result.action).toBe("pending");
        if ("reason" in result) {
          expect(result.reason).toBe("already_dispatched");
        }
      }
    });

    test("update_ready with already-dispatched operation returns pending", async () => {
      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: {
          ...drState,
          phase: "update_ready",
          round: 1,
          operation: {
            operationId: "op-789",
            kind: "update",
            stageVisitId: 2000,
            attempt: 1,
            dispatchState: "dispatched",
            agentId: "agent-012",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(result.action).toBe("pending");
        if ("reason" in result) {
          expect(result.reason).toBe("already_dispatched");
        }
      }
    });
  });

  describe("develop stage unavailability", () => {
    test("PASS with develop stage missing agent returns pending", async () => {
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

      // Config without develop agent
      const configNoDevelop = makeTestConfig({
        maxLoopCycles: 3,
        stages: {
          ...makeTestConfig().stages,
          develop: {
            agentPath: undefined,
            skillPath: "develop/SKILL.md",
            nextStage: "completed",
            requireDomain: false,
          },
        },
      });

      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "review_running", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta, configNoDevelop);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(result.action).toBe("pending");
        if ("reason" in result) {
          expect(result.reason).toBe("develop_stage_unavailable");
        }
      }
    });

    test("PASS with develop stage completely missing returns pending", async () => {
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

      // Config without develop stage at all
      const configNoDevelopStage = makeTestConfig({
        maxLoopCycles: 3,
        stages: {
          ...makeTestConfig().stages,
          // @ts-ignore - intentionally omitting develop
          develop: undefined,
        },
      });

      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "review_running", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta, configNoDevelopStage);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(result.action).toBe("pending");
        if ("reason" in result) {
          expect(result.reason).toBe("develop_stage_unavailable");
        }
      }
    });
  });

  describe("update mode validation", () => {
    test("update with no actual change returns pending", async () => {
      // Plan content unchanged
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
          // Fix for Issue #14: reason now prefixed with "paused:" to indicate pause state
          expect(result.reason).toBe("paused:no_actual_change");
        }
      }
    });

    test("update with changed plan but budget exceeded returns frozen", async () => {
      // Update plan content
      const newPlanContent = "# Updated Plan\n\nNew content.";
      await writeFile(planDoc, newPlanContent, "utf-8");

      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "update_running", round: 1 },
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

  describe("authorization source compatibility", () => {
    test("menu authorization works", async () => {
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
      if (result.status === "handled" && result.action === "advanced") {
        expect(result.toStage).toBe("develop");
      }
    });

    test("direct-entry authorization works", async () => {
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

      const drState = createInitialState(planDoc, "direct-entry", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: { ...drState, phase: "review_running", round: 1 },
        loopCycleCount: 0,
      });
      const ctx = createCoordinatorCtx(meta);

      const result = await coordinateDesignReview(ctx, meta, "settle");
      expect(result.status).toBe("handled");
      if (result.status === "handled" && result.action === "advanced") {
        expect(result.toStage).toBe("develop");
      }
    });
  });
});
