/**
 * Unit tests for the loop-budget warning window reset (203_Bug Phase 1).
 * `loopBudgetWarned` must reset when the budget window closes
 * (remainingRounds away from 1), so the NEXT approach to the threshold
 * warns again — one warning per window. Tests drive the exported helper
 * `buildLowBudgetWarning` directly (single-trigger logic only).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { buildLowBudgetWarning } from '../../core/prompt-injector';
import { makeTestConfig, makeTestMeta } from '../helpers';
import { __setSafeWriteAuditLogOverride } from '../../utils/auditLog';
import type { SessionMeta, PipelineConfig } from '../../types';

describe('prompt-injector budget window reset (203_Bug Phase 1)', () => {
  let auditEvents: Array<{ stage: string }>;
  const config: PipelineConfig = makeTestConfig();

  function makeCtx(meta: SessionMeta) {
    return {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => {
          Object.assign(meta, patch);
          return meta;
        },
      },
      ui: { notify: () => {} },
    } as never;
  }

  beforeEach(() => {
    auditEvents = [];
    __setSafeWriteAuditLogOverride(async (stage) => {
      auditEvents.push({ stage });
    });
  });

  afterEach(() => {
    __setSafeWriteAuditLogOverride(null);
  });

  it('window closed (remainingRounds !== 1) resets a stale warned flag; next approach warns again', async () => {
    // Window closed: loopCycleCount far below max; stale flag TRUE
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "running",
      loopCycleCount: 1,
      maxLoopCycles: 5,
      loopBudgetWarned: true,
    });

    await buildLowBudgetWarning(config, meta, makeCtx(meta));

    // The stale flag must be cleared by the window-close branch
    expect(meta.loopBudgetWarned).toBe(false);

    // Re-entry: no warn at remaining 4
    expect(auditEvents.some((e) => e.stage === "loop_budget_low")).toBe(false);
  });

  it('approaching remainingRounds === 1 warns once (flag re-armed)', async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "running",
      loopCycleCount: 4,
      maxLoopCycles: 5,
      loopBudgetWarned: false,
    });

    await buildLowBudgetWarning(config, meta, makeCtx(meta));

    expect(meta.loopBudgetWarned).toBe(true);
    expect(auditEvents.some((e) => e.stage === "loop_budget_low")).toBe(true);
  });

  it('no reset when flag already false (no-op)', async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "running",
      loopCycleCount: 1,
      maxLoopCycles: 5,
      loopBudgetWarned: false,
    });

    await buildLowBudgetWarning(config, meta, makeCtx(meta));

    expect(meta.loopBudgetWarned).toBe(false);
    expect(auditEvents.some((e) => e.stage === "loop_budget_low")).toBe(false);
  });

  it('warning suppression stays single-trigger while the window is open', async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "running",
      loopCycleCount: 4,
      maxLoopCycles: 5,
      loopBudgetWarned: true,
    });

    auditEvents.length = 0;
    await buildLowBudgetWarning(config, meta, makeCtx(meta));

    // Window still open + already warned → no second warn, flag stays true
    expect(meta.loopBudgetWarned).toBe(true);
    expect(auditEvents.some((e) => e.stage === "loop_budget_low")).toBe(false);
  });
});
