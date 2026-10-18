/**
 * Unit tests for pipeline-start builder reset-field consistency (203_Bug Phase 1).
 * buildRestartMeta / buildStartMeta / buildResumeMeta must merge the unified
 * new-period reset checklist (with their documented preservation contracts).
 */
import { describe, it, expect } from 'bun:test';
import { buildStartMeta, buildResumeMeta } from '../../commands/pipeline-start';
import { makeTestConfig, makeTestMeta } from '../helpers';
import { DEFAULT_MAX_LOOP_CYCLES } from '../../constants';
import type { SessionMeta } from '../../types';

describe('pipeline-start reset-field consistency (203_Bug Phase 1)', () => {
  /** Stale meta carrying residue the builders must clear. */
  const staleMeta: SessionMeta = makeTestMeta({
    flowState: "blocked",
    blockedReason: "max_loop_cycles",
    currentStage: "review",
    loopCycleCount: 7,
    loopBudgetExtensionCount: 2,
    loopRewindCount: 2,
    loopBudgetWarned: true,
    maxLoopCycles: 9,
    menuEscalationPending: true,
    dismissCount: 3,
    confirmRejections: 2,
    terminalWake: { agentId: "a", stage: "develop", visitOrder: 1, at: 1 },
    verifyAttempts: 4,
    verifyConfigError: true,
    terminated: true,
    terminateReason: "loop_overflow",
    confirmGateDeferredAt: { stage: "review", at: 1 },
    activeSpawns: { review: { agentName: "x", startedAt: 1 } },
    spawnedStages: { review: 1 },
    pendingSpawns: { review: { agentName: "x", requestedAt: 1, attempts: 0 } },
    contextFiles: { review: ["a.md"] },
    advancedThisTurn: true,
    reviewConclusionDeclared: true,
    // designReview must be present here so buildResumeMeta's preservation
    // contract ("keeps designReview") can be asserted meaningfully.
    designReview: { phase: "pass_ready" } as never,
  } as Partial<SessionMeta>);

  /** The unified new-period reset fields (single source). */
  function expectUnifiedResetFields(actual: Record<string, unknown>, label: string) {
    // Flow gate
    expect(actual.flowState).toBe("running");
    expect(actual.blockedReason).toBeUndefined();
    // Cyclic counters
    expect(actual.terminated).toBeUndefined();
    expect(actual.terminateReason).toBeUndefined();
    // Spawn residue
    expect(actual.spawnedStages).toBeUndefined();
    expect(actual.activeSpawns).toBeUndefined();
    expect(actual.pendingSpawns).toEqual({});
    // per-turn flags
    expect(actual.advancedThisTurn).toBeUndefined();
    expect(actual.reviewConclusionDeclared).toBeUndefined();
    void label;
  }

  describe('buildRestartMeta (via buildStartMeta complexity — restart is internal)', () => {
    it('buildStartMeta fresh (clarify) resets to unified checklist defaults', () => {
      const config = makeTestConfig();
      const { newMeta } = buildStartMeta(staleMeta, config, "docs/req.md");

      expectUnifiedResetFields(newMeta as unknown as Record<string, unknown>, "buildStartMeta");
      expect(newMeta.currentStage).toBe("clarify");
      expect(newMeta.loopCycleCount).toBe(0);
      expect(newMeta.loopBudgetExtensionCount).toBe(0);
      expect(newMeta.loopRewindCount).toBe(0);
      expect(newMeta.loopBudgetWarned).toBe(false);
      expect(newMeta.menuEscalationPending).toBe(false);
      expect(newMeta.maxLoopCycles).toBe(DEFAULT_MAX_LOOP_CYCLES);
      expect(newMeta.designReview).toBeUndefined();
      expect(newMeta.designReviewRecheck).toBeUndefined();
      expect(newMeta.stageVisitOrder).toEqual(["clarify"]);
    });

    it('buildStartMeta resets maxLoopCycles back to config', () => {
      const config = { ...makeTestConfig(), maxLoopCycles: 4 };
      const { newMeta } = buildStartMeta(staleMeta, config as never, "docs/req.md");
      expect(newMeta.maxLoopCycles).toBe(4);
    });

    it('buildStartMeta spec jump rebuilds the stage chain', () => {
      const config = makeTestConfig();
      const { newMeta } = buildStartMeta(staleMeta, config, "docs/req.md", "develop");
      expect(newMeta.currentStage).toBe("develop");
      // Canonical stage order from the test template: clarify→plan→design-review→develop
      expect(newMeta.stageVisitOrder).toEqual(["clarify", "plan", "design-review", "develop"]);
    });
  });

  describe('buildResumeMeta', () => {
    it('applies unified new-period clears while preserving identity fields', () => {
      const config = makeTestConfig();
      const newMeta = buildResumeMeta(staleMeta, config);

      expectUnifiedResetFields(newMeta as unknown as Record<string, unknown>, "buildResumeMeta");

      // Preservation contract
      expect(newMeta.pipelineId).toBe(staleMeta.pipelineId);
      expect(newMeta.currentStage).toBe(staleMeta.currentStage);
      expect(newMeta.designReview).toBeDefined();

      // Resume rebuild extras
      expect(newMeta.loopBudgetWarned).toBe(false);
      expect(newMeta.loopBudgetExtensionCount).toBe(0);
      expect(newMeta.loopRewindCount).toBe(0);
      expect(newMeta.menuEscalationPending).toBe(false);
      expect(newMeta.loopCount).toBe(0);
      expect(newMeta.currentStepIndex).toBe(0);
      expect(newMeta.stageVisitOrder).toContain(staleMeta.currentStage);
    });

    it('buildResumeMeta keeps maxLoopCycles from meta fallback chain (resume semantics)', () => {
      const config = { ...makeTestConfig(), maxLoopCycles: 4 };
      const newMeta = buildResumeMeta(staleMeta, config as never);
      // maxLoopCycles stays as-is (stale meta's 9) — resume preserves budget continuity
      expect(newMeta.maxLoopCycles).toBe(9);
    });
  });
});
