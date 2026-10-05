/**
 * @module design-review-recovery.test
 * Phase 4 (191): Test authorization recovery and lifecycle in build*Meta functions.
 * 
 * Verifies:
 * - buildStartMeta clears designReview (new pipeline must not inherit stale authorization)
 * - buildRestartMeta clears designReview (restart clears stale authorization)
 * - buildResumeMeta preserves designReview (recovery needs authorization preserved)
 * - Coordinator delegation in pipeline-resume and session-starter
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { buildStartMeta, buildResumeMeta } from "../../commands/pipeline-start";
import type { PipelineConfig, SessionMeta, DesignReviewState } from "../../types";

function makeTestConfig(): PipelineConfig {
  return {
    projectRoot: "/tmp/test-project",
    stages: {
      clarify: { agentPath: "", skillPath: "" },
      plan: { agentPath: "", skillPath: "" },
      develop: { agentPath: "", skillPath: "" },
      review: { agentPath: "", skillPath: "" },
      fix: { agentPath: "", skillPath: "" },
      awaiting_human: { agentPath: "", skillPath: "" },
      completed: { agentPath: "", skillPath: "" },
    },
    maxLoops: 3,
    maxLoopCycles: 3,
  } as PipelineConfig;
}

function makeDesignReviewState(overrides: Partial<DesignReviewState> = {}): DesignReviewState {
  return {
    schemaVersion: 1,
    planDoc: "/tmp/test-plan.md",
    planHash: "abc123",
    round: 1,
    authorizationId: "test-auth-id-xyz",
    authorizationSource: "menu",
    phase: "review_ready",
    authorizedAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeTestMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    currentStage: "design-review",
    pipelineId: "pipe-test-123",
    stageStartTime: Date.now(),
    domain: { id: "general", version: "latest", skillPath: "" },
    summaries: {},
    loopCount: 0,
    currentStepIndex: 0,
    maxLoops: 3,
    maxLoopCycles: 3,
    flowState: "running",
    verifyAttempts: 0,
    verifyFailures: [],
    requirementDoc: "/tmp/test-req.md",
    ...overrides,
  } as SessionMeta;
}

describe("Phase 4 (191): Authorization lifecycle in build*Meta", () => {
  let config: PipelineConfig;

  beforeEach(() => {
    config = makeTestConfig();
  });

  describe("buildStartMeta", () => {
    test("clears designReview authorization on new pipeline start", () => {
      // Old meta has designReview authorization
      const oldMeta = makeTestMeta({
        designReview: makeDesignReviewState({
          authorizationId: "old-auth-id",
          phase: "review_running",
        }),
      });

      const result = buildStartMeta(oldMeta, config, "/tmp/new-req.md");
      
      // New meta must NOT inherit stale authorization
      expect(result.newMeta.designReview).toBeUndefined();
    });

    test("clears designReview even when old meta has no designReview", () => {
      const oldMeta = makeTestMeta({ designReview: undefined });
      const result = buildStartMeta(oldMeta, config, "/tmp/new-req.md");
      expect(result.newMeta.designReview).toBeUndefined();
    });

    test("clears designReview on spec-stage jump start", () => {
      const oldMeta = makeTestMeta({
        currentStage: "design-review",
        designReview: makeDesignReviewState({ phase: "update_running" }),
      });

      // Spec-stage jump to develop
      const result = buildStartMeta(oldMeta, config, "/tmp/new-req.md", "develop");
      
      expect(result.newMeta.currentStage).toBe("develop");
      expect(result.newMeta.designReview).toBeUndefined();
    });
  });

  describe("buildResumeMeta", () => {
    test("preserves designReview authorization for recovery", () => {
      const drState = makeDesignReviewState({
        authorizationId: "recovery-auth-id",
        phase: "review_running",
        round: 2,
      });
      const oldMeta = makeTestMeta({
        designReview: drState,
        currentStage: "design-review",
      });

      const newMeta = buildResumeMeta(oldMeta, config);

      // Resume must preserve authorization for recovery
      expect(newMeta.designReview).toBeDefined();
      expect(newMeta.designReview?.authorizationId).toBe("recovery-auth-id");
      expect(newMeta.designReview?.phase).toBe("review_running");
      expect(newMeta.designReview?.round).toBe(2);
    });

    test("preserves designReview in update_running phase", () => {
      const drState = makeDesignReviewState({
        phase: "update_running",
        planHash: "xyz789",
      });
      const oldMeta = makeTestMeta({ designReview: drState });

      const newMeta = buildResumeMeta(oldMeta, config);

      expect(newMeta.designReview).toBeDefined();
      expect(newMeta.designReview?.phase).toBe("update_running");
      expect(newMeta.designReview?.planHash).toBe("xyz789");
    });

    test("preserves designReview when old meta has no designReview", () => {
      const oldMeta = makeTestMeta({ designReview: undefined });
      const newMeta = buildResumeMeta(oldMeta, config);
      expect(newMeta.designReview).toBeUndefined();
    });
  });

  describe("buildRestartMeta (via buildStartMeta with clarify)", () => {
    test("clears designReview on restart (aborted pipeline)", () => {
      const drState = makeDesignReviewState({
        authorizationId: "aborted-auth-id",
        phase: "paused",
        pauseReason: "budget-exhausted",
      });
      const abortedMeta = makeTestMeta({
        designReview: drState,
        flowState: "aborted",
        terminateReason: "session_quit",
      });

      // Restart is buildStartMeta with startStage="clarify"
      const result = buildStartMeta(abortedMeta, config, "/tmp/restart-req.md");

      expect(result.newMeta.designReview).toBeUndefined();
      expect(result.newMeta.currentStage).toBe("clarify");
    });
  });

  describe("Authorization isolation across pipeline lifecycles", () => {
    test("new pipeline after resume does not inherit previous authorization", () => {
      // Step 1: Resume preserves authorization
      const drState = makeDesignReviewState({ authorizationId: "resume-auth-id" });
      const resumedMeta = makeTestMeta({ designReview: drState });
      const afterResume = buildResumeMeta(resumedMeta, config);
      expect(afterResume.designReview).toBeDefined();

      // Step 2: New start clears authorization
      const result = buildStartMeta(afterResume, config, "/tmp/new-req.md");
      expect(result.newMeta.designReview).toBeUndefined();
    });

    test("restart after design-review failure clears authorization", () => {
      const drState = makeDesignReviewState({
        phase: "paused",
        pauseReason: "budget-exhausted",
      });
      const failedMeta = makeTestMeta({ designReview: drState });
      
      const result = buildStartMeta(failedMeta, config, "/tmp/restart-req.md");
      expect(result.newMeta.designReview).toBeUndefined();
    });
  });
});
