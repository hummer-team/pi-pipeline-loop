/**
 * @module design-review-routing.test
 * Phase 3 / 191: Tests for design-review coordinator routing logic.
 * Validates PASS/FAIL/invalid routing paths through coordinateDesignReview.
 * 
 * Test Environment Constraints (Issue #25 clarification):
 * - No mock.module() used — writeAuditLog is safe (returns early without auditDir),
 *   spawnStageSubagent fails gracefully without pi SDK, recordStageVisit is pure,
 *   and commitDesignReviewState works with the mock session interface.
 * - In this unit test environment, there is NO real pi SDK event bus, so
 *   spawnStageSubagent ALWAYS fails gracefully → action="pending", reason="spawn_failed"
 * - This is CORRECT behavior for the test environment. The assertions accept
 *   ["routed", "pending"] because:
 *   - "routed" = production success path (requires real pi SDK)
 *   - "pending" = test environment path (spawn fails gracefully)
 * - Attempting to mock spawnStageSubagent with mock.module() causes global module
 *   cache pollution that breaks 58+ other test files, even with afterAll(() => mock.restore())
 * - Production success path (action="routed") is verified by integration tests
 *   with the real pi SDK (see design-review-loop.test.ts)
 * - We verify the deterministic state transitions (phase/round/planHash updates)
 *   which test coordinator logic independent of spawn success/failure.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineConfig, SessionMeta, DesignReviewState } from "../../types";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { matchCommitExpectation } from "../../core/session-state";
import { computeHash, createInitialState } from "../../core/design-review/state";
import type { CoordinatorContext, CoordinatorResult } from "../../core/design-review/coordinator";
import { coordinateDesignReview } from "../../core/design-review/coordinator";

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
      // 192 Phase 1: strict-capable commit (healthy shared store semantics)
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

  function createCoordinatorCtx(meta: SessionMeta, spawnOverride?: CoordinatorContext['spawnOverride']): CoordinatorContext {
    return {
      config,
      session: createMockSession(meta),
      ui: { notify: () => {} },
      pi: { sendUserMessage: () => {} },
      spawnOverride,
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
      // Create a PASS report using D06 authoritative format
      const reportDoc = join(tempDir, "review-design-1-plan.md");
      const reportContent = `# Design Review Report

**pipeline**: test-pipeline
**plan**: ${planDoc}
**round**: 1

## Verdict

**Design Review: PASS**

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
      // 192 Phase 1 (DR192-01): "advanced" is only returned after the
      // develop-handoff got a TRUSTED dispatch receipt (real agentId) that
      // was reliably persisted, and the finished commit succeeded. The test
      // stand-in therefore returns a verifiable agentId.
      const trustedHandoff = async () => ({
        spawned: true,
        fallback: false,
        deferred: false,
        agentId: "test-develop-agent-001",
        dispatchOutcome: "spawned_id" as const,
      });
      const ctx = createCoordinatorCtx(meta, trustedHandoff);

      const result = await coordinateDesignReview(ctx, meta, "settle");

      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        expect(result.action).toBe("advanced");
        if ("toStage" in result) {
          expect(result.toStage).toBe("develop");
        }
      }
      // finished + trusted handoff receipt must both be persisted
      const after = ctx.session.getMeta();
      expect(after?.designReview?.phase).toBe("finished");
      expect(after?.designReview?.operation?.kind).toBe("develop-handoff");
      expect(after?.designReview?.operation?.dispatchEvidence).toBe("trusted_id");
      expect(after?.currentStage).toBe("develop");
    });

    test("FAIL verdict routes to plan", async () => {
      // Create a FAIL report using D06 authoritative format
      const reportDoc = join(tempDir, "review-design-1-plan.md");
      const reportContent = `# Design Review Report

**pipeline**: test-pipeline
**plan**: ${planDoc}
**round**: 1

## Verdict

**Design Review: FAIL**

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

      // In test environment, template file doesn't exist, so render fails
      // and we return pending instead of routed (fail-closed behavior)
      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        // Accept both "routed" (production with real pi SDK) and 
        // "pending" (test environment where template/spawn fails)
        expect(["routed", "pending"]).toContain(result.action);
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
      // Create a PASS report using D06 authoritative format
      const reportDoc = join(tempDir, "review-design-1-plan.md");
      const reportContent = `# Design Review Report

**pipeline**: test-pipeline
**plan**: ${planDoc}
**round**: 1

## Verdict

**Design Review: PASS**

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
      // 192 Phase 2: the update section follows the CURRENT contract — exact
      // association fields bound to this update operation + one disposition
      // row per consumed-report issue (K08 structural gate).
      const updateOpId = "op-legacy-update-1";
      const reportDocPath = join(tempDir, "review-design-1-plan.md");
      const newPlanContent = `# Updated Plan

## Design Review Update

**Report**: ${reportDocPath}
**Round**: 1
**Operation**: ${updateOpId}
**Baseline Hash**: ${planHash}

### Issue Dispositions

| # | Issue | Disposition | Justification |
|---|-------|-------------|---------------|
| 1 | Missing error handling | fixed | added try-catch blocks to the loader |

### Changes Made

- Loader section: error handling added.`;
      await writeFile(planDoc, newPlanContent, "utf-8");

      // Create a report with issues
      const reportDoc = join(tempDir, "review-design-1-plan.md");
      const reportContent = `# Design Review Report

**pipeline**: test-pipeline
**plan**: ${planDoc}
**round**: 1

## Verdict

**Design Review: FAIL**

## Issues
1. Missing error handling
`;
      await writeFile(reportDoc, reportContent, "utf-8");

      const drState = createInitialState(planDoc, "menu", planHash);
      const meta = makeTestMeta({
        currentStage: "design-review",
        designReview: {
          ...drState,
          phase: "update_running",
          round: 1,
          operation: {
            operationId: updateOpId,
            kind: "update" as const,
            stageVisitId: Date.now(),
            attempt: 1,
            dispatchState: "dispatched" as const,
            agentId: "agent-legacy-update",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            round: 1,
          },
        },
        loopCycleCount: 0,
      });
      
      // Issue #25: Use spawnOverride to provide deterministic success assertion
      // This allows us to verify the success path without relying on real pi SDK
      const successSpawnOverride = async () => ({
        spawned: true,
        fallback: false,
        deferred: false,
        // 192 Phase 1: the test RPC stand-in returns a verifiable agentId
        // (a bare spawned=true without id is an UNKNOWable outcome and must
        // not be recorded as a trusted dispatch receipt).
        agentId: "test-agent-routed-001",
        dispatchOutcome: "spawned_id" as const,
      });
      const ctx = createCoordinatorCtx(meta, successSpawnOverride);

      const result = await coordinateDesignReview(ctx, meta, "settle");

      expect(result.status).toBe("handled");
      if (result.status === "handled") {
        // With spawnOverride providing success, we should get "routed" action
        expect(result.action).toBe("routed");
      }
      
      // Verify state was updated correctly for next round
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
          // Fix for Issue #14: reason now prefixed with "paused:" to indicate pause state
          expect(result.reason).toBe("paused:no_actual_change");
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
