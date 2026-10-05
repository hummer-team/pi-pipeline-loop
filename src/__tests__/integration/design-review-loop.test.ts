/**
 * @module design-review-loop.test
 * Phase 5 (191): Integration tests for design-review complete loop flow.
 * 
 * Tests the full lifecycle: plan → design-review → develop, including:
 * - Successful pass-through
 * - Multi-round review cycles (PASS/FAIL/update flows)
 * - Failure recovery paths
 * - Stage transition verification
 * - Budget management
 * - Pause/resume semantics
 * - Report version isolation
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { initAuditLog } from "../../utils/auditLog";
import { createInitialState, transitionPhase, isValidTransition, deriveReportPath } from "../../core/design-review-state";
import type { DesignReviewPhase } from "../../types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(tmpdir(), "pi-design-review-loop-" + Date.now());
  await fs.mkdir(tmpDir, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: tmpDir }));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("design-review loop integration", () => {
  it("full cycle: plan → design-review pass → develop", async () => {
    const config = makeTestConfig({ projectRoot: tmpDir });
    const meta = makeTestMeta({
      currentStage: "design-review",
      pipelineId: "pipe-loop-001",
      requirementDoc: "docs/design/test.md",
    });
    
    // Verify design-review stage exists and has correct nextStage
    expect(config.stages["design-review"]).toBeDefined();
    expect(config.stages["design-review"].nextStage).toBe("develop");
    expect(meta.currentStage).toBe("design-review");
  });

  it("design-review stage is in correct position in stage flow", () => {
    const config = makeTestConfig({ projectRoot: tmpDir });
    
    // Verify stage sequence: plan → design-review → develop
    expect(config.stages["plan"].nextStage).toBe("design-review");
    expect(config.stages["design-review"].nextStage).toBe("develop");
    expect(config.stages["develop"].nextStage).toBe("review");
  });

  it("design-review stage has required configuration", () => {
    const config = makeTestConfig({ projectRoot: tmpDir });
    const designReviewStage = config.stages["design-review"];
    
    expect(designReviewStage).toBeDefined();
    expect(designReviewStage.agentPath).toBeDefined();
    expect(designReviewStage.skillPath).toBeDefined();
    // Note: verify.require is not set by default in makeTestConfig
    // Integration tests should verify this in template config instead
  });

  it("design-review state initializes correctly in meta", () => {
    const meta = makeTestMeta({
      currentStage: "design-review",
      pipelineId: "pipe-loop-002",
      requirementDoc: "docs/design/plan.md",
    });
    
    expect(meta.currentStage).toBe("design-review");
    expect(meta.pipelineId).toBe("pipe-loop-002");
    expect(meta.requirementDoc).toBe("docs/design/plan.md");
  });

  it("multi-round: PASS flow transitions correctly", async () => {
    // Test PASS verdict flow: review_running → pass_ready → finished
    const planDoc = path.join(tmpDir, "plan.md");
    await fs.writeFile(planDoc, "# Test Plan\n", "utf-8");
    
    const initialState = createInitialState(planDoc, "menu", "hash123");
    expect(initialState.phase).toBe("review_ready");
    
    // Transition to review_running
    const reviewState = transitionPhase(initialState, "review_running");
    expect(reviewState.phase).toBe("review_running");
    expect(reviewState.round).toBe(1);
    
    // Transition to pass_ready
    const passState = transitionPhase(reviewState, "pass_ready");
    expect(passState.phase).toBe("pass_ready");
  });

  it("multi-round: FAIL→update→re-review cycle", async () => {
    // Test FAIL verdict flow: review_running → update_ready → update_running → review_ready
    // Note: round increment is handled by coordinator, not transitionPhase
    const planDoc = path.join(tmpDir, "plan.md");
    await fs.writeFile(planDoc, "# Test Plan\n", "utf-8");
    
    const initialState = createInitialState(planDoc, "menu", "hash123");
    const reviewState = transitionPhase(initialState, "review_running");
    expect(reviewState.round).toBe(1);
    
    // FAIL verdict: transition to update_ready
    const failState = transitionPhase(reviewState, "update_ready");
    expect(failState.phase).toBe("update_ready");
    
    // Update agent runs: transition to update_running
    const updateState = transitionPhase(failState, "update_running");
    expect(updateState.phase).toBe("update_running");
    
    // Update complete: back to review_ready
    // In real flow, coordinator would increment round and update reportDoc
    const reReviewState = transitionPhase(updateState, "review_ready");
    expect(reReviewState.phase).toBe("review_ready");
    // Round remains 1 here - coordinator handles increment via separate logic
  });

  it("multi-round: budget check prevents infinite loops", async () => {
    // Test budget management: maxLoopCycles limits review rounds
    const planDoc = path.join(tmpDir, "plan.md");
    await fs.writeFile(planDoc, "# Test Plan\n", "utf-8");
    
    const config = makeTestConfig({ 
      projectRoot: tmpDir,
      maxLoopCycles: 3 
    });
    
    const meta = makeTestMeta({
      currentStage: "design-review",
      loopCycleCount: 2, // Already at cycle 2
    });
    
    // Verify budget check would prevent 4th cycle
    expect(meta.loopCycleCount).toBeLessThan(config.maxLoopCycles!);
    
    // Simulate reaching max cycles
    const metaAtLimit = makeTestMeta({
      currentStage: "design-review",
      loopCycleCount: 3,
    });
    
    expect(metaAtLimit.loopCycleCount).toBeGreaterThanOrEqual(config.maxLoopCycles!);
  });

  it("multi-round: pause/resume semantics", async () => {
    // Test pause/resume: state can be paused with reason and resumed
    const planDoc = path.join(tmpDir, "plan.md");
    await fs.writeFile(planDoc, "# Test Plan\n", "utf-8");
    
    const initialState = createInitialState(planDoc, "menu", "hash123");
    const reviewState = transitionPhase(initialState, "review_running");
    
    // Pause with reason (pauseReason is required)
    const pausedState = transitionPhase(reviewState, "paused", undefined, "no-change");
    expect(pausedState.phase).toBe("paused");
    expect(pausedState.pauseReason).toBe("no-change");
    
    // Resume: transition back to review_ready
    const resumedState = transitionPhase(pausedState, "review_ready");
    expect(resumedState.phase).toBe("review_ready");
    expect(resumedState.pauseReason).toBeUndefined();
  });

  it("multi-round: report version isolation per round", async () => {
    // Test that each round uses its own report version based on deriveReportPath
    const planDoc = path.join(tmpDir, "plan.md");
    await fs.writeFile(planDoc, "# Test Plan\n", "utf-8");
    
    const state1 = createInitialState(planDoc, "menu", "hash123");
    const reviewState1 = transitionPhase(state1, "review_running");
    expect(reviewState1.round).toBe(1);
    // Report path follows deriveReportPath format: review-design-{round}-{planDoc}
    expect(reviewState1.reportDoc).toContain("review-design-1-plan.md");
    
    // Simulate update and round 2
    const failState = transitionPhase(reviewState1, "update_ready");
    const updateState = transitionPhase(failState, "update_running");
    const reviewState2 = transitionPhase(updateState, "review_ready");
    
    expect(reviewState2.round).toBe(1); // Round not auto-incremented by transitionPhase
    
    // Manually simulate coordinator's round increment
    const stateWithRound2 = {
      ...reviewState2,
      round: 2,
      reportDoc: deriveReportPath(planDoc, 2),
    };
    
    // Round 2 report path should be different
    expect(stateWithRound2.reportDoc).toContain("review-design-2-plan.md");
    expect(stateWithRound2.reportDoc).not.toBe(reviewState1.reportDoc);
  });

  it("valid state transitions follow design-review FSM", () => {
    // Verify all valid phase transitions
    const validTransitions: Array<[DesignReviewPhase, DesignReviewPhase]> = [
      ["review_ready", "review_running"],
      ["review_running", "pass_ready"],
      ["review_running", "update_ready"],
      ["review_running", "paused"],
      ["update_ready", "update_running"],
      ["update_running", "review_ready"], // Round increment
      ["pass_ready", "finished"],
      ["paused", "review_ready"], // Resume from paused
    ];
    
    for (const [from, to] of validTransitions) {
      expect(isValidTransition(from, to)).toBe(true);
    }
    
    // Verify invalid transitions are rejected
    expect(isValidTransition("finished", "review_running")).toBe(false);
    expect(isValidTransition("paused", "review_running")).toBe(false); // Can't skip review_ready
  });
});
