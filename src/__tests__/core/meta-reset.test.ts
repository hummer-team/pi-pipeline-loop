/**
 * Unit tests for the single-source reset checklists (203_Bug Phase 1).
 * Covers: continue reset field coverage, new-period superset, maxLoopCycles
 * fallback to config/default, and the pipelineId exclusion invariant.
 */
import { describe, it, expect } from 'bun:test';
import {
  buildContinueResetFields,
  buildNewPeriodResetFields,
} from '../../core/meta-reset';
import { makeTestConfig, makeTestMeta } from '../helpers';
import { DEFAULT_MAX_LOOP_CYCLES } from '../../constants';
import type { SessionMeta, PipelineConfig } from '../../types';

describe('meta-reset (203_Bug Phase 1)', () => {
  const staleMeta: SessionMeta = makeTestMeta({
    flowState: "blocked",
    blockedReason: "max_loop_cycles",
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
    currentStage: "review",
  } as Partial<SessionMeta>);

  describe('buildContinueResetFields', () => {
    it('resets all cyclic computation counters to initial values (§3 table)', () => {
      const check = buildContinueResetFields(staleMeta, makeTestConfig());

      expect(check.flowState).toBe("running");
      expect(check.blockedReason).toBeUndefined();
      expect(check.loopCount).toBe(0);
      expect(check.verifyAttempts).toBe(0);
      expect(check.verifyFailures).toEqual([]);
      expect(check.violations).toEqual([]);
      expect(check.precheckBlocked).toBeUndefined();
      expect(check.transientRetryCount).toBeUndefined();
      expect(check.dismissCount).toBe(0);
      expect(check.confirmRejections).toBeUndefined();
      expect(check.loopCycleCount).toBe(0);
      expect(check.loopBudgetExtensionCount).toBe(0);
      expect(check.loopRewindCount).toBe(0);
      expect(check.loopBudgetWarned).toBe(false);
      expect(check.menuEscalationPending).toBe(false);
      expect(check.terminalWake).toBeUndefined();
      expect(check.lastVerifyResult).toBeUndefined();
    });

    it('maxLoopCycles falls back to config.maxLoopCycles when set', () => {
      const config = { ...makeTestConfig(), maxLoopCycles: 4 } as PipelineConfig;
      const check = buildContinueResetFields(staleMeta, config);
      expect(check.maxLoopCycles).toBe(4);
    });

    it('maxLoopCycles falls back to DEFAULT_MAX_LOOP_CYCLES when unset', () => {
      const config = { ...makeTestConfig(), maxLoopCycles: undefined } as PipelineConfig;
      const check = buildContinueResetFields(staleMeta, config);
      expect(check.maxLoopCycles).toBe(DEFAULT_MAX_LOOP_CYCLES);
    });
  });

  describe('buildNewPeriodResetFields', () => {
    const check = buildNewPeriodResetFields(staleMeta, makeTestConfig());

    it('is a superset of the continue checklist', () => {
      const continueFields = buildContinueResetFields(staleMeta, makeTestConfig());
      for (const key of Object.keys(continueFields)) {
        expect(check).toHaveProperty(key);
      }
    });

    it('resets stage-chain / residue / design-review fields (§3 table)', () => {
      expect(check.currentStage).toBe("clarify");
      expect(check.previousStage).toBeUndefined();
      expect(check.currentStepIndex).toBe(0);
      expect(check.summaries).toEqual({});
      expect(check.verifyConfigError).toBeUndefined();
      expect(check.terminated).toBeUndefined();
      expect(check.terminateReason).toBeUndefined();
      expect(check.terminalCompact).toBeUndefined();
      expect(check.confirmGateDeferredAt).toBeUndefined();
      expect(check.pendingSpawns).toEqual({});
      expect(check.spawnedStages).toBeUndefined();
      expect(check.activeSpawns).toBeUndefined();
      expect(check.designReview).toBeUndefined();
      expect(check.designReviewRecheck).toBeUndefined();
      expect(check.stageVisitOrder).toEqual(["clarify"]);
      expect(check.contextFiles).toBeUndefined();
      expect(check.advancedThisTurn).toBeUndefined();
      expect(check.reviewConclusionDeclared).toBeUndefined();
    });

    it('does NOT include pipelineId (assigned by the caller)', () => {
      expect(check).not.toHaveProperty("pipelineId");
    });
  });
});
