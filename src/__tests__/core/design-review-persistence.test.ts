import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { DesignReviewState, SessionMeta, DesignReviewOperation } from "../../types";
import { commitDesignReviewState, matchCommitExpectation } from "../../core/session-state";
import {
  prepareDesignReviewOperation,
  commitDesignReviewOperation,
  writebackDesignReviewResult,
  isCurrentOperation,
  formatDesignReviewSpawnDescription,
  formatDesignReviewSpawnPrompt,
} from "../../core/design-review/dispatch";
import { createInitialState } from "../../core/design-review/state";

describe("Phase 2: Design Review Persistence", () => {
  describe("commitDesignReviewState", () => {
    let mockSession: {
      getMeta: () => SessionMeta | undefined;
      updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
      updateMetaVerified?: (
        patch: Partial<SessionMeta>,
        expected: import("../../core/session-state").MetaCommitExpectation,
      ) => import("../../types").ReliableMetaCommitResult;
    };
    let testMeta: SessionMeta;
    let testState: DesignReviewState;

    /** 192 Phase 1: strict-capable mock (healthy shared store semantics) */
    function attachStrict(session: typeof mockSession) {
      session.updateMetaVerified = mock((patch, expected) => {
        const conflict = matchCommitExpectation(testMeta, expected);
        if (conflict) return { status: "conflict" as const, reason: conflict };
        testMeta = { ...testMeta, ...patch };
        return { status: "persisted" as const, meta: testMeta };
      });
    }

    beforeEach(() => {
      testMeta = {
        currentStage: "design-review",
        stageStartTime: Date.now(),
        pipelineId: "test-pipeline",
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        domain: {
          id: "test-domain",
          version: "1.0.0",
          skillPath: "/tmp/test-skill",
        },
      };

      testState = createInitialState("docs/plan.md", "menu", "hash-123");

      mockSession = {
        getMeta: mock(() => testMeta),
        updateMeta: mock((patch) => {
          testMeta = { ...testMeta, ...patch };
          return testMeta;
        }),
      };
      attachStrict(mockSession);
    });

    test("should commit state successfully", () => {
      const result = commitDesignReviewState(mockSession, testState);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.authorizationId).toBe(testState.authorizationId);
        expect(result.state.round).toBe(1);
        expect(result.state.phase).toBe("review_ready");
      }
    });

    test("should fail when no meta exists", () => {
      mockSession.getMeta = mock(() => undefined);

      const result = commitDesignReviewState(mockSession, testState);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("no_meta");
      }
    });

    test("192 Phase 1: adapters WITHOUT the strict interface are unavailable (fail-closed)", () => {
      delete mockSession.updateMetaVerified;

      const result = commitDesignReviewState(mockSession, testState);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("unavailable");
      }
    });

    test("192 Phase 1: shared-write failure surfaces as unavailable, never success", () => {
      mockSession.updateMetaVerified = mock(() => ({
        status: "unavailable" as const,
        reason: "shared_write_failed",
      }));

      const result = commitDesignReviewState(mockSession, testState);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("unavailable");
        expect(result.detail).toBe("shared_write_failed");
      }
    });

    test("192 Phase 1: stale expectation (same auth/round, older revision) conflicts", () => {
      const result = commitDesignReviewState(mockSession, testState, {
        pipelineId: "test-pipeline",
        stateUpdatedAt: testState.updatedAt - 10_000,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("conflict");
      }
    });

    test("should detect authorization conflict", () => {
      // First commit
      commitDesignReviewState(mockSession, testState);

      // Try to commit with different authorization
      const differentState = createInitialState("docs/plan.md", "menu", "hash-456");

      const result = commitDesignReviewState(mockSession, differentState);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("conflict");
      }
    });

    test("should detect round regression", () => {
      // Commit round 2
      const round2State = { ...testState, round: 2 };
      commitDesignReviewState(mockSession, round2State);

      // Try to commit round 1 (regression)
      const result = commitDesignReviewState(mockSession, testState);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("conflict");
      }
    });

    test("should allow round progression", () => {
      // Commit round 1
      commitDesignReviewState(mockSession, testState);

      // Commit round 2 (progression)
      const round2State = { ...testState, round: 2 };
      const result = commitDesignReviewState(mockSession, round2State);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.round).toBe(2);
      }
    });
  });

  describe("prepareDesignReviewOperation", () => {
    let testState: DesignReviewState;

    beforeEach(() => {
      testState = createInitialState("docs/plan.md", "menu", "hash-123");
    });

    test("should create new operation for review", () => {
      const op = prepareDesignReviewOperation(testState, "review", Date.now());

      expect(op).toBeDefined();
      expect(op?.kind).toBe("review");
      expect(op?.attempt).toBe(1);
      expect(op?.dispatchState).toBe("pending");
    });

    test("should create new operation for update", () => {
      // Set state to update_ready phase (required for update operations)
      testState.phase = "update_ready";

      const op = prepareDesignReviewOperation(testState, "update", Date.now());

      expect(op).toBeDefined();
      expect(op?.kind).toBe("update");
      expect(op?.attempt).toBe(1);
    });

    test("should increment attempt on retry", () => {
      const stageVisitId = Date.now();
      
      // First attempt
      const op1 = prepareDesignReviewOperation(testState, "review", stageVisitId);
      expect(op1?.attempt).toBe(1);

      // Simulate operation in state
      testState.operation = op1;

      // Retry with same stage visit
      const op2 = prepareDesignReviewOperation(testState, "review", stageVisitId);
      expect(op2?.attempt).toBe(2);
      expect(op2?.operationId).toBe(op1?.operationId);
    });

    test("should create new operation for different stage visit", () => {
      const op1 = prepareDesignReviewOperation(testState, "review", 1000);
      testState.operation = op1;

      // Different stage visit = new operation
      const op2 = prepareDesignReviewOperation(testState, "review", 2000);
      expect(op2?.operationId).not.toBe(op1?.operationId);
    });

    test("should return undefined for invalid transition", () => {
      // Set state to review_running (can't start another review)
      testState.phase = "review_running";

      const op = prepareDesignReviewOperation(testState, "review", Date.now());
      expect(op).toBeUndefined();
    });

    test("should return undefined when authorization is invalid", () => {
      testState.phase = "finished";

      const op = prepareDesignReviewOperation(testState, "review", Date.now());
      expect(op).toBeUndefined();
    });
  });

  describe("writebackDesignReviewResult", () => {
    let mockSession: {
      getMeta: () => SessionMeta | undefined;
      updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
      updateMetaVerified?: (
        patch: Partial<SessionMeta>,
        expected: import("../../core/session-state").MetaCommitExpectation,
      ) => import("../../types").ReliableMetaCommitResult;
    };
    let testMeta: SessionMeta;
    let testState: DesignReviewState;
    let testOp: DesignReviewOperation;

    beforeEach(() => {
      testState = createInitialState("docs/plan.md", "menu", "hash-123");
      testState.phase = "review_running";
      testOp = {
        operationId: "op-123",
        kind: "review",
        stageVisitId: Date.now(),
        attempt: 1,
        dispatchState: "dispatched",
        agentId: "agent-456",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      testState.operation = testOp;

      testMeta = {
        currentStage: "design-review",
        stageStartTime: Date.now(),
        pipelineId: "test-pipeline",
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        maxLoops: 3,
        domain: {
          id: "test-domain",
          version: "1.0.0",
          skillPath: "/tmp/test-skill",
        },
        designReview: testState,
      };

      mockSession = {
        getMeta: mock(() => testMeta),
        updateMeta: mock((patch) => {
          testMeta = { ...testMeta, ...patch };
          return testMeta;
        }),
        // 192 Phase 1: strict-capable writeback needs the strict interface
        updateMetaVerified: mock((patch, expected) => {
          const conflict = matchCommitExpectation(testMeta, expected);
          if (conflict) return { status: "conflict" as const, reason: conflict };
          testMeta = { ...testMeta, ...patch };
          return { status: "persisted" as const, meta: testMeta };
        }),
      };
    });

    test("should writeback dispatched status", () => {
      const result = writebackDesignReviewResult(
        mockSession,
        testOp.operationId,
        "agent-789",
        "dispatched"
      );

      expect(result).toBeDefined();
      expect(result?.operation?.dispatchState).toBe("dispatched");
      expect(result?.operation?.agentId).toBe("agent-789");
    });

    test("should writeback completed status", () => {
      const result = writebackDesignReviewResult(
        mockSession,
        testOp.operationId,
        undefined,
        "completed"
      );

      expect(result).toBeDefined();
      expect(result?.operation?.dispatchState).toBe("completed");
      expect(result?.operation?.settledAt).toBeDefined();
    });

    test("should writeback failed status", () => {
      const result = writebackDesignReviewResult(
        mockSession,
        testOp.operationId,
        undefined,
        "failed"
      );

      expect(result).toBeDefined();
      expect(result?.operation?.dispatchState).toBe("failed");
    });

    test("should reject stale operation", () => {
      const result = writebackDesignReviewResult(
        mockSession,
        "different-op-id",
        "agent-789",
        "dispatched"
      );

      expect(result).toBeUndefined();
    });

    test("should fail when dispatched without agentId", () => {
      const result = writebackDesignReviewResult(
        mockSession,
        testOp.operationId,
        undefined,
        "dispatched"
      );

      expect(result).toBeUndefined();
    });
  });

  describe("isCurrentOperation", () => {
    let testState: DesignReviewState;
    let testOp: DesignReviewOperation;

    beforeEach(() => {
      testState = createInitialState("docs/plan.md", "menu", "hash-123");
      testOp = {
        operationId: "op-123",
        kind: "review",
        stageVisitId: Date.now(),
        attempt: 1,
        dispatchState: "dispatched",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      testState.operation = testOp;
    });

    test("should return true for matching operation", () => {
      const result = isCurrentOperation(testState, testOp.operationId, 1);
      expect(result).toBe(true);
    });

    test("should return false for different operation", () => {
      const result = isCurrentOperation(testState, "different-op", 1);
      expect(result).toBe(false);
    });

    test("should return false for different round", () => {
      const result = isCurrentOperation(testState, testOp.operationId, 2);
      expect(result).toBe(false);
    });

    test("should return false when no operation exists", () => {
      testState.operation = undefined;
      const result = isCurrentOperation(testState, testOp.operationId, 1);
      expect(result).toBe(false);
    });
  });

  describe("formatDesignReviewSpawnDescription", () => {
    test("should format review description", () => {
      const desc = formatDesignReviewSpawnDescription(
        "review",
        "docs/plan.md",
        1,
        "op-12345678"
      );
      expect(desc).toContain("design review");
      expect(desc).toContain("round 1");
      expect(desc).toContain("op-12345");
    });

    test("should format update description", () => {
      const desc = formatDesignReviewSpawnDescription(
        "update",
        "docs/review-1.md",
        2,
        "op-87654321"
      );
      expect(desc).toContain("plan update");
      expect(desc).toContain("round 2");
    });
  });

  describe("formatDesignReviewSpawnPrompt", () => {
    test("should encode spaces in path", () => {
      const prompt = formatDesignReviewSpawnPrompt(
        "review",
        "docs/my plan.md",
        1
      );
      expect(prompt).toBe("docs/my\\ plan.md 1");
    });

    test("should handle path without spaces", () => {
      const prompt = formatDesignReviewSpawnPrompt(
        "review",
        "docs/plan.md",
        1
      );
      expect(prompt).toBe("docs/plan.md 1");
    });
  });
});
