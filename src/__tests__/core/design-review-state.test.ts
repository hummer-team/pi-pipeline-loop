/**
 * Unit tests for design-review state management pure functions.
 * Phase 0 / 191: Tests report path derivation, round allocation,
 * authorization validity, state transitions, and identity predicates.
 */

import { describe, expect, test } from "bun:test";
import {
  generateUUID,
  computeHash,
  deriveReportPath,
  isReportForRound,
  allocateNextRound,
  isAuthorizationValid,
  isValidTransition,
  createInitialState,
  createOperation,
  transitionPhase,
  updateDispatchState,
  canDispatch,
  isSameOperation,
  hasPlanDrifted,
  isSameAuthorizationContext,
} from "../../core/design-review-state";
import type { DesignReviewState, DesignReviewOperation } from "../../types";

describe("design-review-state pure functions", () => {
  describe("generateUUID", () => {
    test("generates valid UUID v4 format", () => {
      const uuid = generateUUID();
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    test("generates unique UUIDs", () => {
      const uuids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        uuids.add(generateUUID());
      }
      expect(uuids.size).toBe(100);
    });
  });

  describe("computeHash", () => {
    test("computes SHA-256 hash of content", () => {
      const hash = computeHash("test content");
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    test("same content produces same hash", () => {
      const hash1 = computeHash("test");
      const hash2 = computeHash("test");
      expect(hash1).toBe(hash2);
    });

    test("different content produces different hash", () => {
      const hash1 = computeHash("test1");
      const hash2 = computeHash("test2");
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("deriveReportPath", () => {
    test("derives report path from plan path and round", () => {
      const planDoc = "/project/docs/design/plan.md";
      const reportPath = deriveReportPath(planDoc, 1);
      expect(reportPath).toBe("/project/docs/design/review-design-1-plan.md");
    });

    test("handles round 2", () => {
      const planDoc = "/project/docs/design/plan.md";
      const reportPath = deriveReportPath(planDoc, 2);
      expect(reportPath).toBe("/project/docs/design/review-design-2-plan.md");
    });

    test("handles complex plan filename", () => {
      const planDoc = "/project/docs/design/191_Feat_plan.md";
      const reportPath = deriveReportPath(planDoc, 3);
      expect(reportPath).toBe("/project/docs/design/review-design-3-191_Feat_plan.md");
    });
  });

  describe("isReportForRound", () => {
    test("returns true for matching report path", () => {
      const planDoc = "/project/docs/design/plan.md";
      const reportPath = "/project/docs/design/review-design-1-plan.md";
      expect(isReportForRound(reportPath, planDoc, 1)).toBe(true);
    });

    test("returns false for non-matching round", () => {
      const planDoc = "/project/docs/design/plan.md";
      const reportPath = "/project/docs/design/review-design-2-plan.md";
      expect(isReportForRound(reportPath, planDoc, 1)).toBe(false);
    });

    test("handles relative vs absolute paths", () => {
      const planDoc = "docs/design/plan.md";
      const reportPath = "docs/design/review-design-1-plan.md";
      expect(isReportForRound(reportPath, planDoc, 1)).toBe(true);
    });
  });

  describe("allocateNextRound", () => {
    test("returns 1 for undefined state (first round)", () => {
      expect(allocateNextRound(undefined)).toBe(1);
    });

    test("returns next round based on current state", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      state.round = 1;
      expect(allocateNextRound(state)).toBe(2);
    });

    test("increments round correctly", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      state.round = 3;
      expect(allocateNextRound(state)).toBe(4);
    });
  });

  describe("isAuthorizationValid", () => {
    test("returns false for undefined state", () => {
      expect(isAuthorizationValid(undefined)).toBe(false);
    });

    test("returns true for valid state (review_ready)", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      expect(isAuthorizationValid(state)).toBe(true);
    });

    test("returns false for finished phase", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      state.phase = "finished";
      expect(isAuthorizationValid(state)).toBe(false);
    });

    test("returns false for paused with authorization-lost", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      state.phase = "paused";
      state.pauseReason = "authorization-lost";
      expect(isAuthorizationValid(state)).toBe(false);
    });

    test("returns true for paused with other reason", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      state.phase = "paused";
      state.pauseReason = "no-change";
      expect(isAuthorizationValid(state)).toBe(true);
    });
  });

  describe("isValidTransition", () => {
    test("allows review_ready → review_running", () => {
      expect(isValidTransition("review_ready", "review_running")).toBe(true);
    });

    test("allows review_running → pass_ready", () => {
      expect(isValidTransition("review_running", "pass_ready")).toBe(true);
    });

    test("allows review_running → update_ready", () => {
      expect(isValidTransition("review_running", "update_ready")).toBe(true);
    });

    test("allows update_running → review_ready (re-review after update)", () => {
      expect(isValidTransition("update_running", "review_ready")).toBe(true);
    });

    test("allows any phase → paused", () => {
      expect(isValidTransition("review_ready", "paused")).toBe(true);
      expect(isValidTransition("review_running", "paused")).toBe(true);
      expect(isValidTransition("update_ready", "paused")).toBe(true);
    });

    test("allows paused → active phases (recovery)", () => {
      expect(isValidTransition("paused", "review_ready")).toBe(true);
      expect(isValidTransition("paused", "update_ready")).toBe(true);
      expect(isValidTransition("paused", "pass_ready")).toBe(true);
    });

    test("disallows invalid transitions", () => {
      expect(isValidTransition("review_ready", "update_ready")).toBe(false);
      expect(isValidTransition("pass_ready", "review_ready")).toBe(false);
      expect(isValidTransition("finished", "review_ready")).toBe(false);
    });

    test("disallows transitions from finished", () => {
      expect(isValidTransition("finished", "review_ready")).toBe(false);
      expect(isValidTransition("finished", "paused")).toBe(false);
    });
  });

  describe("createInitialState", () => {
    test("creates state with review_ready phase", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      expect(state.phase).toBe("review_ready");
      expect(state.planDoc).toBe("/plan.md");
      expect(state.authorizationSource).toBe("menu");
      expect(state.planHash).toBe("hash123");
      expect(state.round).toBe(1);
    });

    test("generates unique authorizationId", () => {
      const state1 = createInitialState("/plan.md", "menu", "hash123");
      const state2 = createInitialState("/plan.md", "menu", "hash123");
      expect(state1.authorizationId).not.toBe(state2.authorizationId);
    });

    test("sets timestamps", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      expect(state.authorizedAt).toBeGreaterThan(0);
      expect(state.updatedAt).toBeGreaterThan(0);
      expect(state.updatedAt).toBeGreaterThanOrEqual(state.authorizedAt);
    });

    test("includes optional ownerSessionFile", () => {
      const state = createInitialState("/plan.md", "direct-entry", "hash123", "/session.json");
      expect(state.ownerSessionFile).toBe("/session.json");
    });

    test("resolves planDoc to absolute path", () => {
      const state = createInitialState("docs/plan.md", "menu", "hash123");
      expect(state.planDoc).toMatch(/^\//);
    });
  });

  describe("createOperation", () => {
    test("creates operation with pending dispatch state", () => {
      const op = createOperation("review", 123456, 1);
      expect(op.kind).toBe("review");
      expect(op.stageVisitId).toBe(123456);
      expect(op.attempt).toBe(1);
      expect(op.dispatchState).toBe("pending");
    });

    test("generates unique operationId", () => {
      const op1 = createOperation("review", 123456, 1);
      const op2 = createOperation("review", 123456, 1);
      expect(op1.operationId).not.toBe(op2.operationId);
    });

    test("includes inputHash when provided", () => {
      const op = createOperation("update", 123456, 1, "input-hash");
      expect(op.inputHash).toBe("input-hash");
    });

    test("sets createdAt timestamp", () => {
      const op = createOperation("review", 123456, 1);
      expect(op.createdAt).toBeGreaterThan(0);
    });
  });

  describe("transitionPhase", () => {
    test("transitions to valid target phase", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      const newState = transitionPhase(state, "review_running");
      expect(newState.phase).toBe("review_running");
      expect(newState.updatedAt).toBeGreaterThanOrEqual(state.updatedAt);
    });

    test("throws on invalid transition", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      expect(() => transitionPhase(state, "update_ready")).toThrow("Invalid design-review transition");
    });

    test("updates operation when provided", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      const op = createOperation("review", 123456, 1);
      const newState = transitionPhase(state, "review_running", op);
      expect(newState.operation).toBe(op);
    });

    test("sets pauseReason when transitioning to paused", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      const newState = transitionPhase(state, "paused", undefined, "no-change");
      expect(newState.phase).toBe("paused");
      expect(newState.pauseReason).toBe("no-change");
    });

    test("throws when transitioning to paused without reason", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      expect(() => transitionPhase(state, "paused")).toThrow("Pause reason required");
    });

    test("clears pauseReason when leaving paused", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      state.phase = "paused";
      state.pauseReason = "no-change";
      const newState = transitionPhase(state, "review_ready");
      expect(newState.pauseReason).toBeUndefined();
    });
  });

  describe("updateDispatchState", () => {
    test("updates dispatch state of current operation", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      const op = createOperation("review", 123456, 1);
      state.operation = op;
      
      const newState = updateDispatchState(state, "dispatched", "agent-123");
      expect(newState.operation!.dispatchState).toBe("dispatched");
      expect(newState.operation!.agentId).toBe("agent-123");
    });

    test("throws when no operation exists", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      expect(() => updateDispatchState(state, "dispatched")).toThrow("no operation exists");
    });

    test("throws when dispatched without agentId", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      state.operation = createOperation("review", 123456, 1);
      expect(() => updateDispatchState(state, "dispatched")).toThrow("Agent ID required");
    });

    test("sets settledAt when completed or failed", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      state.operation = createOperation("review", 123456, 1);
      
      const completed = updateDispatchState(state, "completed");
      expect(completed.operation!.settledAt).toBeGreaterThan(0);
      
      const failed = updateDispatchState(state, "failed");
      expect(failed.operation!.settledAt).toBeGreaterThan(0);
    });
  });

  describe("canDispatch", () => {
    test("returns false for undefined state", () => {
      expect(canDispatch(undefined)).toBe(false);
    });

    test("returns true for review_ready phase", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      expect(canDispatch(state)).toBe(true);
    });

    test("returns true for update_ready phase", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      state.phase = "update_ready";
      expect(canDispatch(state)).toBe(true);
    });

    test("returns true for pass_ready phase", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      state.phase = "pass_ready";
      expect(canDispatch(state)).toBe(true);
    });

    test("returns false for running phases", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      state.phase = "review_running";
      expect(canDispatch(state)).toBe(false);
    });

    test("returns false when operation is dispatched", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      const op = createOperation("review", 123456, 1);
      op.dispatchState = "dispatched";
      state.operation = op;
      expect(canDispatch(state)).toBe(false);
    });

    test("returns true when operation is completed", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      const op = createOperation("review", 123456, 1);
      op.dispatchState = "completed";
      state.operation = op;
      expect(canDispatch(state)).toBe(true);
    });
  });

  describe("isSameOperation", () => {
    test("returns true for same operationId", () => {
      const op1: DesignReviewOperation = {
        operationId: "op-123",
        kind: "review",
        stageVisitId: 123456,
        attempt: 1,
        dispatchState: "pending",
        createdAt: Date.now(),
      };
      const op2: DesignReviewOperation = { ...op1 };
      expect(isSameOperation(op1, op2)).toBe(true);
    });

    test("returns false for different operationId", () => {
      const op1: DesignReviewOperation = {
        operationId: "op-123",
        kind: "review",
        stageVisitId: 123456,
        attempt: 1,
        dispatchState: "pending",
        createdAt: Date.now(),
      };
      const op2: DesignReviewOperation = { ...op1, operationId: "op-456" };
      expect(isSameOperation(op1, op2)).toBe(false);
    });

    test("returns false when either is undefined", () => {
      const op: DesignReviewOperation = {
        operationId: "op-123",
        kind: "review",
        stageVisitId: 123456,
        attempt: 1,
        dispatchState: "pending",
        createdAt: Date.now(),
      };
      expect(isSameOperation(op, undefined)).toBe(false);
      expect(isSameOperation(undefined, op)).toBe(false);
      expect(isSameOperation(undefined, undefined)).toBe(false);
    });
  });

  describe("hasPlanDrifted", () => {
    test("returns false when hashes match", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      expect(hasPlanDrifted(state, "hash123")).toBe(false);
    });

    test("returns true when hashes differ", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      expect(hasPlanDrifted(state, "hash456")).toBe(true);
    });

    test("returns false when planHash is undefined", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      delete state.planHash;
      expect(hasPlanDrifted(state, "hash456")).toBe(false);
    });
  });

  describe("isSameAuthorizationContext", () => {
    test("returns true for same authorizationId, round, and planHash", () => {
      const state1 = createInitialState("/plan.md", "menu", "hash123");
      const state2 = { ...state1 };
      expect(isSameAuthorizationContext(state1, state2)).toBe(true);
    });

    test("returns false for different authorizationId", () => {
      const state1 = createInitialState("/plan.md", "menu", "hash123");
      const state2 = { ...state1, authorizationId: "different-id" };
      expect(isSameAuthorizationContext(state1, state2)).toBe(false);
    });

    test("returns false for different round", () => {
      const state1 = createInitialState("/plan.md", "menu", "hash123");
      const state2 = { ...state1, round: 2 };
      expect(isSameAuthorizationContext(state1, state2)).toBe(false);
    });

    test("returns false for different planHash", () => {
      const state1 = createInitialState("/plan.md", "menu", "hash123");
      const state2 = { ...state1, planHash: "hash456" };
      expect(isSameAuthorizationContext(state1, state2)).toBe(false);
    });

    test("returns false when either is undefined", () => {
      const state = createInitialState("/plan.md", "menu", "hash123");
      expect(isSameAuthorizationContext(state, undefined)).toBe(false);
      expect(isSameAuthorizationContext(undefined, state)).toBe(false);
      expect(isSameAuthorizationContext(undefined, undefined)).toBe(false);
    });
  });
});
