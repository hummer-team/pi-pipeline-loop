/**
 * @module meta-reset
 * 203_Bug Phase 1 (RC2 + 复位统合): Single-source reset checklists for the
 * two "fresh start" cyclic scopes of the pipeline.
 *
 * There are THREE entry points sharing these lists (口径统一, no drift):
 *
 * 1. "Continue" (same pipelineId, same stage) — decision-menu `Resume`
 *    (executeDecision in flow-state.ts) and `/pipeline-resume --force-resume`
 *    route through the same decision. Uses {@link buildContinueResetFields}.
 *
 * 2. "New period" (menu restart / start fresh / resume-to-new) —
 *    `executeDecision("restart")`, `buildRestartMeta` / `buildStartMeta`
 *    (pipeline-start.ts). Uses {@link buildNewPeriodResetFields}.
 *
 * 3. `/pipeline-start` resume (same pipeline preserved) — `buildResumeMeta`
 *    merges the new-period clears while PRESERVING pipelineId / currentStage /
 *    designReview (recovery semantics unchanged).
 *
 * collider note: `updateMeta` merges patches by spread, so a field only lands
 * as "reset" when the patch carries it. Cyclic counters not present here
 * would survive a resume and disable the next threshold freeze
 * (the RC1-class defect this module closes).
 */

import type { SessionMeta, PipelineConfig, PipelineStage } from "../types";
import { DEFAULT_MAX_LOOP_CYCLES } from "../constants";

/**
 * Fields reset when the human chooses "continue" (same pipelineId, same stage).
 * Covers all per-cycle/per-stage computation counters so the pipeline can hit
 * its thresholds again cleanly after resuming (acceptance: 回归初始值).
 *
 * @param meta - Current SessionMeta snapshot (currently UNUSED for the list —
 *               kept for signature symmetry/future conditional resets)
 * @param config - PipelineConfig for maxLoopCycles derivation
 */
export function buildContinueResetFields(
  _meta: SessionMeta | undefined,
  config: PipelineConfig,
): Partial<SessionMeta> {
  return {
    // Flow gate
    flowState: "running",
    blockedReason: undefined,

    // Per-step / per-stage counters
    loopCount: 0,
    verifyAttempts: 0,
    verifyFailures: [],
    violations: [],
    precheckBlocked: undefined,
    transientRetryCount: undefined,
    dismissCount: 0,
    confirmRejections: undefined,

    // Loop-cycle budget scope (per-period; must re-arm thresholds)
    loopCycleCount: 0,
    loopBudgetExtensionCount: 0,
    loopRewindCount: 0,
    loopBudgetWarned: false,
    maxLoopCycles: config.maxLoopCycles ?? DEFAULT_MAX_LOOP_CYCLES,

    // Escalation / wake one-shot flags
    menuEscalationPending: false,
    terminalWake: undefined,

    // Verification bookkeeping
    lastVerifyResult: undefined,
  };
}

/**
 * Fields reset when a NEW period starts (menu restart / start fresh /
 * resume-to-new). Superset of {@link buildContinueResetFields} plus stage-chain
 * /spawn-residue /design-review clears. Does NOT touch pipelineId (assigned by
 * the caller), requirementDoc, domain, or currentModel.
 *
 * @param meta - Current SessionMeta snapshot (signature symmetric)
 * @param config - PipelineConfig for maxLoopCycles derivation
 */
export function buildNewPeriodResetFields(
  _meta: SessionMeta | undefined,
  config: PipelineConfig,
): Partial<SessionMeta> {
  return {
    ...buildContinueResetFields(_meta, config),

    // Fresh stage chain
    currentStage: "clarify" as PipelineStage,
    previousStage: undefined,
    stageStartTime: Date.now(),
    currentStepIndex: 0,
    summaries: {},
    verifyConfigError: undefined,

    // Legacy terminal markers
    terminated: undefined,
    terminateReason: undefined,
    terminalCompact: undefined,

    // Confirm-gate deferral window
    confirmGateDeferredAt: undefined,

    // Spawn residue (RC2: cross-period residue breaks re-dispatch)
    pendingSpawns: {},
    spawnedStages: undefined,
    activeSpawns: undefined,

    // Design-review session state
    designReview: undefined,
    designReviewRecheck: undefined,

    // Stage visit chain
    stageVisitOrder: ["clarify"] as PipelineStage[],

    // Handoff artifacts
    contextFiles: undefined,

    // Per-turn idempotency flags
    advancedThisTurn: undefined,
    reviewConclusionDeclared: undefined,
  };
}
