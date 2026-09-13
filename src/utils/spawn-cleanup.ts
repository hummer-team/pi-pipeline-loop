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
 * Clears the activeSpawns entry for a specific stage.
 * No-op if no entry exists for the stage.
 *
 * @param session - Session with getMeta/updateMeta interface
 * @param stage - Pipeline stage whose spawn record should be removed
 */
export function clearActiveSpawnRecord(session: SessionLike, stage: PipelineStage): void {
  const meta = session.getMeta();
  if (!meta?.activeSpawns?.[stage]) return;
  const cleared = { ...meta.activeSpawns };
  delete cleared[stage];
  session.updateMeta({ activeSpawns: cleared });
}

/**
 * Clears both activeSpawns and spawnedStages entries for a specific stage.
 * Used when a stage is completed and all its spawn tracking should be removed.
 * No-op if neither entry exists.
 *
 * @param session - Session with getMeta/updateMeta interface
 * @param stage - Pipeline stage whose records should be removed
 */
export function clearStageSpawnRecords(session: SessionLike, stage: PipelineStage): void {
  const meta = session.getMeta();
  if (!meta) return;

  const patch: Partial<SessionMeta> = {};
  let changed = false;

  if (meta.activeSpawns?.[stage]) {
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
