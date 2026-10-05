/**
 * @module design-review-invalidation.test
 * Phase 4-2 (191): Test authorization invalidation logic.
 * 
 * Verifies that design-review authorization is properly invalidated when:
 * - User quits the pipeline
 * - Session shuts down
 * - User executes skip/rollback/abort/choose_stage decisions
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { executeDecision } from "../../core/flow-state";
import type { PipelineConfig, SessionMeta, DesignReviewState } from "../../types";
import { makeTestMeta, makeTestConfig } from "../helpers";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDesignReviewState(overrides: Partial<DesignReviewState> = {}): DesignReviewState {
  return {
    schemaVersion: 1,
    planDoc: "/tmp/plan.md",
    planHash: "abc123",
    round: 1,
    authorizationId: "test-auth-id",
    authorizationSource: "menu",
    phase: "review_ready",
    authorizedAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeCtx(
  meta: SessionMeta,
): { session: { getMeta: () => SessionMeta; updateMeta: (patch: Partial<SessionMeta>) => SessionMeta }; updates: Partial<SessionMeta>[] } {
  const updates: Partial<SessionMeta>[] = [];
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        updates.push(patch);
        Object.assign(meta, patch);
        return meta;
      },
    },
    updates,
  };
}

// ─── Authorization Invalidation ──────────────────────────────────────────────

describe("Phase 4-2 (191): Authorization invalidation", () => {
  let config: PipelineConfig;

  beforeEach(() => {
    config = makeTestConfig();
  });

  describe("executeDecision", () => {
    it("skip: invalidates design-review authorization", async () => {
      const meta = makeTestMeta({
        flowState: "blocked",
        currentStage: "design-review",
        designReview: makeDesignReviewState(),
      });
      const ctx = makeCtx(meta);

      expect(meta.designReview).toBeDefined();

      const result = await executeDecision(ctx, meta, "skip", config);

      expect(result.success).toBe(true);
      // Authorization should be invalidated
      expect(meta.designReview).toBeUndefined();
    });

    it("rollback: invalidates design-review authorization", async () => {
      const meta = makeTestMeta({
        flowState: "blocked",
        currentStage: "design-review",
        previousStage: "plan",
        designReview: makeDesignReviewState(),
      });
      const ctx = makeCtx(meta);

      expect(meta.designReview).toBeDefined();

      const result = await executeDecision(ctx, meta, "rollback", config);

      expect(result.success).toBe(true);
      // Authorization should be invalidated
      expect(meta.designReview).toBeUndefined();
    });

    it("abort: invalidates design-review authorization", async () => {
      const meta = makeTestMeta({
        flowState: "blocked",
        currentStage: "design-review",
        designReview: makeDesignReviewState(),
      });
      const ctx = makeCtx(meta);

      expect(meta.designReview).toBeDefined();

      const result = await executeDecision(ctx, meta, "abort", config);

      expect(result.success).toBe(true);
      // Authorization should be invalidated
      expect(meta.designReview).toBeUndefined();
    });

    it("choose_stage (non-design-review): invalidates design-review authorization", async () => {
      const meta = makeTestMeta({
        flowState: "blocked",
        currentStage: "design-review",
        designReview: makeDesignReviewState(),
      });
      const ctx = makeCtx(meta);

      expect(meta.designReview).toBeDefined();

      const result = await executeDecision(ctx, meta, "choose_stage", config, {
        targetStage: "plan",
      });

      expect(result.success).toBe(true);
      // Authorization should be invalidated when choosing non-design-review stage
      expect(meta.designReview).toBeUndefined();
    });

    it("choose_stage (design-review): does NOT invalidate existing authorization", async () => {
      const authState = makeDesignReviewState();
      const meta = makeTestMeta({
        flowState: "blocked",
        currentStage: "plan",
        designReview: authState,
      });
      const ctx = makeCtx(meta);

      expect(meta.designReview).toBeDefined();

      const result = await executeDecision(ctx, meta, "choose_stage", config, {
        targetStage: "design-review",
      });

      expect(result.success).toBe(true);
      // Authorization should NOT be invalidated when choosing design-review stage
      // (new authorization will be required by session-starter/coordinator)
      expect(meta.designReview).toBeDefined();
      expect(meta.designReview?.authorizationId).toBe(authState.authorizationId);
    });

    it("resume: does NOT invalidate design-review authorization", async () => {
      const meta = makeTestMeta({
        flowState: "blocked",
        currentStage: "design-review",
        designReview: makeDesignReviewState(),
      });
      const ctx = makeCtx(meta);

      expect(meta.designReview).toBeDefined();

      const result = await executeDecision(ctx, meta, "resume", config);

      expect(result.success).toBe(true);
      // Authorization should NOT be invalidated on resume
      // (recovery path needs authorization preserved)
      expect(meta.designReview).toBeDefined();
    });

    it("restart: does NOT invalidate design-review authorization (handled by buildStartMeta)", async () => {
      const meta = makeTestMeta({
        flowState: "blocked",
        currentStage: "design-review",
        designReview: makeDesignReviewState(),
      });
      const ctx = makeCtx(meta);

      expect(meta.designReview).toBeDefined();

      const result = await executeDecision(ctx, meta, "restart", config);

      expect(result.success).toBe(true);
      // Authorization is cleared by buildStartMeta, not by executeDecision
      // So it should still be present here (but will be cleared when new pipeline starts)
      expect(meta.designReview).toBeDefined();
    });
  });

  describe("No authorization state", () => {
    it("skip: handles missing designReview gracefully", async () => {
      const meta = makeTestMeta({
        flowState: "blocked",
        currentStage: "plan",
        designReview: undefined,
      });
      const ctx = makeCtx(meta);

      expect(meta.designReview).toBeUndefined();

      const result = await executeDecision(ctx, meta, "skip", config);

      expect(result.success).toBe(true);
      // Should not crash when no authorization exists
      expect(meta.designReview).toBeUndefined();
    });
  });
});
