/**
 * @module spawn-cleanup
 * Phase 4 / 175: Shared helpers for clearing active spawn records from session meta.
 *
 * Extracted to avoid duplication between session-shutdown.ts (child shutdown
 * state-aware cleanup) and subagent-rpc.ts (lifecycle settle cleanup).
 * Both modules need to immutably remove a stage entry from activeSpawns and
 * optionally from spawnedStages.
 *
 * Plan Phase 4 Task 2: "提取与 clearActiveSpawn 共用的 helper 至 session-state
 * 或 utils，禁复制" (Extract shared helper for clearActiveSpawn to session-state
 * or utils; no duplication).
 */

import type { PipelineStage, SessionMeta } from "../types";

/**
 * Session interface required for spawn cleanup operations.
 * Compatible with both RuntimeCtx.session and test mocks.
 */
interface SessionLike {
  getMeta: () => SessionMeta | undefined;
  updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
}

/**
 * 192 Phase 1 (task 7): optional identity that a cleanup must match.
 * - Without `expected`: legacy unconditional cleanup (backward compatible).
 * - With `expected`: the entry is deleted ONLY when its agentId /
 *   operationContext.operationId match — a late callback of a superseded
 *   operation can never wipe the CURRENT spawn record.
 */
export interface SpawnCleanupExpectation {
  /** Trusted agent id the stored entry must carry */
  agentId?: string;
  /** Design-review operation id the stored entry must carry */
  operationId?: string;
}

/** True when the stored entry satisfies the expectation (or none given). */
function matchesExpectation(
  entry: { agentId?: string; operationContext?: { operationId: string } } | undefined,
  expected?: SpawnCleanupExpectation,
): boolean {
  if (!expected) return true;
  if (!entry) return false;
  if (expected.agentId !== undefined && entry.agentId !== expected.agentId) return false;
  if (expected.operationId !== undefined && entry.operationContext?.operationId !== expected.operationId) return false;
  return true;
}

/**
 * Clears the activeSpawns entry for a specific stage.
 * No-op if no entry exists for the stage.
 *
 * @param session - Session with getMeta/updateMeta interface
 * @param stage - Pipeline stage whose spawn record should be removed
 * @param expected - 192 Phase 1: optional identity the entry must match
 */
export function clearActiveSpawnRecord(
  session: SessionLike,
  stage: PipelineStage,
  expected?: SpawnCleanupExpectation,
): void {
  const meta = session.getMeta();
  if (!meta?.activeSpawns?.[stage]) return;
  if (!matchesExpectation(meta.activeSpawns[stage], expected)) {
    // The stored entry belongs to a DIFFERENT spawn/operation — leave it.
    return;
  }
  const cleared = { ...meta.activeSpawns };
  delete cleared[stage];
  session.updateMeta({ activeSpawns: cleared });
}

/**
 * Clears both activeSpawns and spawnedStages entries for a specific stage.
 * Used when a stage is completed and all its spawn tracking should be removed.
 * No-op if neither entry exists.
 *
 * 192 Phase 1: `expected` applies to the activeSpawns side (identity match);
 * spawnedStages (a plain visit stamp) is cleared regardless when present,
 * matching the stage-exit semantics callers rely on.
 *
 * @param session - Session with getMeta/updateMeta interface
 * @param stage - Pipeline stage whose records should be removed
 * @param expected - Optional identity for the activeSpawns entry
 */
export function clearStageSpawnRecords(
  session: SessionLike,
  stage: PipelineStage,
  expected?: SpawnCleanupExpectation,
): void {
  const meta = session.getMeta();
  if (!meta) return;

  const patch: Partial<SessionMeta> = {};
  let changed = false;

  if (meta.activeSpawns?.[stage] && matchesExpectation(meta.activeSpawns[stage], expected)) {
    const clearedSpawns = { ...meta.activeSpawns };
    delete clearedSpawns[stage];
    patch.activeSpawns = clearedSpawns;
    changed = true;
  }

  if (meta.spawnedStages?.[stage] !== undefined) {
    const clearedSpawned = { ...meta.spawnedStages };
    delete clearedSpawned[stage];
    patch.spawnedStages = clearedSpawned;
    changed = true;
  }

  if (changed) {
    session.updateMeta(patch);
  }
}
