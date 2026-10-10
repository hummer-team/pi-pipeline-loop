/**
 * @module stage-visit
 * Shared helper for recording stage visits in stageVisitOrder.
 *
 * Consolidates the cycle detection and visit order maintenance logic that was
 * previously duplicated across pipeline-handoff, stage-advancer, routeConfirmReject,
 * and verify-advance. All four entry points call this helper before updateMeta.
 *
 * Semantics (matching original handoff L93-120):
 * - First visit to a stage: append to stageVisitOrder, loopCycleCount = 0
 * - Revisit: loopCycleCount + 1, append; if cycleCount >= maxLoopCycles → ok: false
 *   (caller responsible for freezeAndPrompt and aborting the transition)
 * - Target "completed" is appended like any other stage
 */

import type { SessionMeta, PipelineStage } from "../types";
import { DEFAULT_MAX_LOOP_CYCLES } from "../constants";

/**
 * Result of recording a stage visit.
 *
 * - ok: true — caller should merge `patch` into updateMeta and proceed.
 * - ok: false — max loop cycles reached; caller should freeze and abort transition.
 *   `patch` still contains the updated stageVisitOrder/loopCycleCount for audit.
 *   `wouldFreeze: true` signals that the caller must call freezeAndPrompt.
 */
export type StageVisitResult =
  | { ok: true; patch: Partial<SessionMeta> }
  | { ok: false; patch: Partial<SessionMeta>; wouldFreeze: true };

/**
 * Records a stage visit and returns the meta patch to apply.
 *
 * This is the single source of truth for stageVisitOrder maintenance across
 * all four transition entry points (handoff, stage_advance, confirm reject,
 * verify-advance auto-advance).
 *
 * @param meta - Current session metadata (read-only; not mutated)
 * @param nextStage - The stage being transitioned to
 * @param maxCycles - Maximum allowed loop cycles (from meta or config)
 * @returns StageVisitResult with patch to merge into updateMeta
 */
export function recordStageVisit(
  meta: SessionMeta,
  nextStage: PipelineStage,
  maxCycles: number,
): StageVisitResult {
  const visitOrder = meta.stageVisitOrder ?? [];

  if (visitOrder.includes(nextStage)) {
    // Revisit: increment cycle count
    const cycleCount = (meta.loopCycleCount ?? 0) + 1;
    const newVisitOrder = [...visitOrder, nextStage];

    const patch: Partial<SessionMeta> = {
      loopCycleCount: cycleCount,
      stageVisitOrder: newVisitOrder,
    };

    if (cycleCount >= maxCycles) {
      return { ok: false, patch, wouldFreeze: true };
    }

    return { ok: true, patch };
  }

  // First visit: append and reset cycle count
  const newVisitOrder = [...visitOrder, nextStage];
  const patch: Partial<SessionMeta> = {
    loopCycleCount: 0,
    stageVisitOrder: newVisitOrder,
  };

  return { ok: true, patch };
}

/**
 * Phase 0 (195_Bug): Three-level fallback accessor for loop budget.
 * Single source of truth for maxLoopCycles resolution:
 * 1. meta.maxLoopCycles (session-level override)
 * 2. config.maxLoopCycles (config-level default)
 * 3. DEFAULT_MAX_LOOP_CYCLES (hardcoded fallback)
 * 
 * Usage: All modules reading loop budget should call this instead of
 * directly accessing meta.maxLoopCycles or config.maxLoopCycles.
 * This prevents budget inflation and ensures consistent resolution.
 */
export function effectiveMax(
  meta: Partial<SessionMeta>,
  config: { maxLoopCycles?: number }
): number {
  return meta.maxLoopCycles ?? config.maxLoopCycles ?? DEFAULT_MAX_LOOP_CYCLES;
}
