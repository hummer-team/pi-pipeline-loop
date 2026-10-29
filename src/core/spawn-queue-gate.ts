/**
 * @module spawn-queue-gate
 * 218 Phase 1 (T1.2, Q12-A + C): "the plugin already queued this stage" IS
 * ownership — the 20261028 incident's five-second twin window came from the
 * model being invited to "process pending spawn requests" while
 * `pendingSpawns[stage]` was already scheduled for auto-dispatch.
 *
 * The gate maps the queue state to one of three verdicts:
 * - `pass`: no ownership signal (no entry / foreign pipeline / other agent)
 *   — existing 3c/3d/3e gates keep their semantics.
 * - `block`: the plugin owns the queue and WILL dispatch at end of turn.
 *   Blocking is NOT a violation (F.1: unconditional semantics, independent
 *   of `suppressDuplicateSpawn`).
 * - `authorize`: the wait window expired WITHOUT consumption
 *   (`stalledAt` set, `dispatchConsumedAt` absent) — release exactly ONE
 *   manual dispatch. Consumption is pessimistic: tool-guard writes
 *   `dispatchConsumedAt` itself (it cannot observe dispatch success) and the
 *   consume side drops the entry on the next owner settle (T1.1), so a failed
 *   manual spawn never becomes a silent plugin twin — it converges to the
 *   visible `/pipeline-resume` path.
 */

import type { PendingSpawnEntry, PipelineStage, SessionMeta } from "../types";

export type QueueGateDecision =
  | { action: "pass" }
  | { action: "block"; reason: string; entry: PendingSpawnEntry }
  | { action: "authorize"; entry: PendingSpawnEntry };

/**
 * 218 Q12-A+C: "the plugin already queued this stage" is ownership.
 * Blocking is NOT a violation; an authorization is consumed pessimistically
 * (tool-guard cannot observe dispatch success) and recorded for replay.
 */
export function evaluateSpawnQueueOwnership(
  meta: SessionMeta,
  stage: PipelineStage,
  requestedAgent: string,
): QueueGateDecision {
  const entry = meta.pendingSpawns?.[stage];
  if (!entry || entry.agentName !== requestedAgent) return { action: "pass" };
  // Cross-pipeline residue is NOT ownership (consumePendingSpawns discards it).
  if (entry.pipelineId && meta.pipelineId && entry.pipelineId !== meta.pipelineId) {
    return { action: "pass" };
  }
  if (entry.stalledAt !== undefined && entry.dispatchConsumedAt === undefined) {
    return { action: "authorize", entry };
  }
  return {
    action: "block",
    entry,
    reason: `the ${stage} executor "${entry.agentName}" is already in the plugin dispatch queue`,
  };
}
