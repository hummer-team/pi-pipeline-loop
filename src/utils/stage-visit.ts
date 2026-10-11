/**
 * @module stage-visit
 * Shared helper for recording stage visits in stageVisitOrder.
 *
 * Consolidates the cycle detection and visit order maintenance logic that was
 * previously duplicated across pipeline-handoff, stage-advancer, routeConfirmReject,
 * and verify-advance. All four entry points call this helper before updateMeta.
 *
 * Phase 3 (195_Bug): Counting semantics changed from "any revisit counts" to
 * "only rework edges count" via classifyVisitEdge predicate (C0-C4).
 * - C0 first: target not visited yet → reset count, don't count
 * - C1 forward: config-defined forward edge → don't count
 * - C2 backward: ordinal regression → count (+1)
 * - C3 loop_return: config rework entry → count (+1)
 * - C4 unclassified: fallback → don't count (with audit)
 */

import type { SessionMeta, PipelineStage, PipelineConfig } from "../types";
import { safeWriteAuditLog } from "./auditLog";
import { shouldEmitWithinWindow } from "./audit-throttle";
import { DEFAULT_MAX_LOOP_CYCLES, CANONICAL_STAGE_ORDER } from "../constants";

/**
 * Phase 3 (195_Bug): Edge classification for stage transitions.
 * Evaluated in order C0→C1→C2→C3→C4; first match wins.
 */
export type VisitEdgeKind = "first" | "forward" | "backward" | "loop_return" | "unclassified";

/**
 * Result of recording a stage visit.
 *
 * - ok: true — caller should merge `patch` into updateMeta and proceed.
 * - ok: false — max loop cycles reached; caller should freeze and abort transition.
 *   `patch` still contains the updated stageVisitOrder/loopCycleCount for audit.
 *   `wouldFreeze: true` signals that the caller must call freezeAndPrompt.
 * - edgeKind: which branch of classifyVisitEdge matched
 * - counted: whether this edge incremented loopCycleCount
 */
export type StageVisitResult =
  | { ok: true; patch: Partial<SessionMeta>; edgeKind: VisitEdgeKind; counted: boolean }
  | { ok: false; patch: Partial<SessionMeta>; wouldFreeze: true; edgeKind: VisitEdgeKind; counted: boolean };

/**
 * Phase 3 (195_Bug): Classify a stage transition edge into one of five branches.
 *
 * Evaluated sequentially; first match wins:
 * - C0 (first): target ∉ stageVisitOrder → "first", not counted (new stage, reset budget)
 * - C1 (forward): target === config.stages[source].nextStage → "forward", not counted
 * - C2 (backward): ordinal(target) < ordinal(source) → "backward", counted
 * - C3 (loop_return): config.stages[target].nextStage === source → "loop_return", counted
 * - C4 (unclassified): fallback → "unclassified", not counted
 *
 * @param meta - Pick of currentStage + stageVisitOrder from session meta
 * @param config - PipelineConfig for stage chain lookups
 * @param target - The stage being transitioned to
 * @returns kind + whether this edge should increment loopCycleCount
 */
export function classifyVisitEdge(
  meta: Pick<SessionMeta, "currentStage" | "stageVisitOrder">,
  config: PipelineConfig | undefined,
  target: PipelineStage,
): { kind: VisitEdgeKind; counted: boolean } {
  const source = meta.currentStage;
  const visitOrder = meta.stageVisitOrder ?? [];

  // C0: first visit — target not in history
  if (!visitOrder.includes(target)) {
    return { kind: "first", counted: false };
  }

  // C1: forward edge — config-defined nextStage chain
  const sourceNext = config?.stages[source]?.nextStage;
  if (target === sourceNext) {
    return { kind: "forward", counted: false };
  }

  // C2: backward edge — ordinal regression in canonical order
  const sourceOrdinal = CANONICAL_STAGE_ORDER.indexOf(source);
  const targetOrdinal = CANONICAL_STAGE_ORDER.indexOf(target);
  if (sourceOrdinal >= 0 && targetOrdinal >= 0 && targetOrdinal < sourceOrdinal) {
    return { kind: "backward", counted: true };
  }

  // C3: loop_return — entering a stage whose config.nextStage points back to source
  const targetNext = config?.stages[target]?.nextStage;
  if (targetNext === source) {
    return { kind: "loop_return", counted: true };
  }

  // C4: unclassified fallback
  return { kind: "unclassified", counted: false };
}

/**
 * Records a stage visit and returns the meta patch to apply.
 *
 * Phase 3 (195_Bug): Uses classifyVisitEdge to determine whether this transition
 * should increment loopCycleCount (only C2 backward / C3 loop_return count).
 *
 * @param meta - Current session metadata (read-only; not mutated)
 * @param nextStage - The stage being transitioned to
 * @param maxCycles - Maximum allowed loop cycles
 * @param config - PipelineConfig for edge classification
 * @returns StageVisitResult with patch, edgeKind, and counted flag
 */
export function recordStageVisit(
  meta: SessionMeta,
  nextStage: PipelineStage,
  maxCycles: number,
  config: PipelineConfig | undefined,
): StageVisitResult {
  const visitOrder = meta.stageVisitOrder ?? [];
  const edge = classifyVisitEdge(
    { currentStage: meta.currentStage, stageVisitOrder: visitOrder },
    config,
    nextStage,
  );

  const newVisitOrder = [...visitOrder, nextStage];

  if (edge.kind === "first") {
    // C0: first visit — reset cycle count (new stage, budget restarts)
    const patch: Partial<SessionMeta> = {
      loopCycleCount: 0,
      stageVisitOrder: newVisitOrder,
    };
    return { ok: true, patch, edgeKind: edge.kind, counted: false };
  }

  if (edge.counted) {
    // C2/C3: rework edge — increment cycle count
    const cycleCount = (meta.loopCycleCount ?? 0) + 1;
    const patch: Partial<SessionMeta> = {
      loopCycleCount: cycleCount,
      stageVisitOrder: newVisitOrder,
    };
    if (cycleCount >= maxCycles) {
      return { ok: false, patch, wouldFreeze: true, edgeKind: edge.kind, counted: true };
    }
    return { ok: true, patch, edgeKind: edge.kind, counted: true };
  }

  // C4: unclassified edge audit (throttled per pipelineId, one-time semantics)
  if (edge.kind === "unclassified") {
    const throttleKey = `${meta.pipelineId}:unclassified`;
    if (shouldEmitWithinWindow(throttleKey, 60000)) {
      void safeWriteAuditLog("visit_edge_unclassified", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        source: meta.currentStage,
        target: nextStage,
      });
    }
  }

  // C1/C4: non-counting edge — keep existing cycle count
  const patch: Partial<SessionMeta> = {
    loopCycleCount: meta.loopCycleCount ?? 0,
    stageVisitOrder: newVisitOrder,
  };
  return { ok: true, patch, edgeKind: edge.kind, counted: false };
}

/**
 * Phase 3 (195_Bug): Derive the gate stage of the current rework loop.
 *
 * Scans stageVisitOrder from tail backward, looking for the most recent
 * counted edge (C2 backward or C3 loop_return). Returns the source stage
 * of that edge (= the gate where the freeze should occur).
 *
 * Constraints (I2): result must ∈ config.stages keys and ∉ {completed, awaiting_human}.
 * Returns null if no valid counted edge is found.
 *
 * @param meta - SessionMeta with stageVisitOrder
 * @param config - PipelineConfig for edge classification
 * @returns The gate stage, or null if none found
 */
export function deriveReworkLoopGate(
  meta: Pick<SessionMeta, "stageVisitOrder">,
  config: PipelineConfig | undefined,
): PipelineStage | null {
  const visitOrder = meta.stageVisitOrder ?? [];
  if (visitOrder.length < 2) {
    return null;
  }

  // Scan from tail backward: find the most recent counted edge
  for (let i = visitOrder.length - 1; i >= 1; i--) {
    const target = visitOrder[i];
    const source = visitOrder[i - 1];
    const edge = classifyVisitEdge(
      { currentStage: source, stageVisitOrder: visitOrder.slice(0, i) },
      config,
      target,
    );
    if (edge.counted) {
      // I2 constraint: the RESULT (returned source stage) must be a valid
      // configured stage and not a terminal/non-rework stage. Guard is on
      // `source` because the plan mandates "result ∉ {completed,
      // awaiting_human}" (Rev.4 :267); Phase 6 menu provisioning relies on
      // null => the rewind exit is not offered.
      if (
        config?.stages[source] &&
        source !== "completed" &&
        source !== "awaiting_human"
      ) {
        return source;
      }
    }
  }

  return null;
}

/**
 * Phase 0 (195_Bug): Three-level fallback accessor for loop budget.
 * Single source of truth for maxLoopCycles resolution:
 * 1. meta.maxLoopCycles (session-level override)
 * 2. config.maxLoopCycles (config-level default)
 * 3. DEFAULT_MAX_LOOP_CYCLES (hardcoded fallback)
 */
export function effectiveMax(
  meta: Partial<SessionMeta>,
  config: { maxLoopCycles?: number } | undefined
): number {
  return meta.maxLoopCycles ?? config?.maxLoopCycles ?? DEFAULT_MAX_LOOP_CYCLES;
}

/**
 * Calculate remaining rework rounds using the unified formula from plan :318.
 * 
 * Formula: remainingRounds = effectiveMax(meta, config) − loopCycleCount − c0Used
 * 
 * Where c0Used is derived from deriveReworkLoopGate:
 * - If deriveReworkLoopGate returns non-null (in rework loop), c0Used = 1
 * - If deriveReworkLoopGate returns null (in design-review cycle), c0Used = 0
 * 
 * Value table (max=5, N5):
 * - Not started: 5/5 (count=0, c0Used=0)
 * - R1 in progress: 4/5 (count=0, c0Used=1)
 * - R4 completed: 1/5 (count=3, c0Used=1, warning)
 * - R5 completed: 0/5 (count=4, c0Used=1, freeze)
 * 
 * @param meta - SessionMeta with loopCycleCount and stageVisitOrder
 * @param config - PipelineConfig for effectiveMax calculation
 * @returns Number of remaining rework rounds
 */
export function remainingRoundsOf(
  meta: Pick<SessionMeta, "maxLoopCycles" | "loopCycleCount" | "stageVisitOrder" | "currentStage">,
  config: PipelineConfig | undefined
): number {
  const max = effectiveMax(meta, config);
  const count = meta.loopCycleCount ?? 0;
  const gate = deriveReworkLoopGate(meta, config);
  const c0Used = gate !== null ? 1 : 0;
  return max - count - c0Used;
}
