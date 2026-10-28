/**
 * @module pending-spawn-stall
 * 217 Phase 1 (T1.1, F3): surface an unconsumed owner spawn queue as a bounded,
 * ONE-shot stall event.
 *
 * Incident (217): a child enqueued `pendingSpawns[fix]` but the owner was never
 * woken — the queue sat invisible for ten deduped wake attempts. This watchdog
 * turns "queued but not consumed" into visible evidence within
 * `spawnWaitTimeoutMs ?? DEFAULT_SPAWN_WAIT_TIMEOUT_MS` (216 R6-2 semantics:
 * `requestedAt` is the dedup key; zero new constants, zero new meta fields).
 */

import type { PipelineConfig, PipelineStage, SessionMeta } from "../types";
import { DEFAULT_SPAWN_WAIT_TIMEOUT_MS } from "../constants";
import { probeAgentState } from "../utils/subagents-introspect";
import { resolveOwnerDelivery } from "./owner-delivery-registry";
import type { DeliveryOutcome } from "./owner-delivery";

export interface PendingSpawnStallDeps {
  getMeta: () => SessionMeta | undefined;
  getConfig: () => PipelineConfig;
  deliver: (summary: string, meta: SessionMeta) => DeliveryOutcome;
  fallbackNotify: (stage: PipelineStage, message: string) => void;
  audit: (event: string, payload: Record<string, unknown>) => void;
}

/** Module-level deps, refreshed per hook invocation (same pattern as owner-wake). */
let deps: PendingSpawnStallDeps | null = null;
const activeWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

/** Installs (or clears, with `null`) the stall watchdog deps. */
export function setPendingSpawnStallDeps(next: PendingSpawnStallDeps | null): void { deps = next; }

/**
 * Arms ONE deadline per (pipelineId, stage, requestedAt). `requestedAt` is the
 * existing dedup key: a re-enqueue of the same target keeps it (216 R6-2), so a
 * repeated arm is a no-op; a replaced request produces a new key.
 */
export function armPendingSpawnStall(pipelineId: string, stage: PipelineStage, requestedAt: number): void {
  const key = `${pipelineId}:${stage}:${requestedAt}`;
  if (activeWatchdogs.has(key)) return;
  const windowMs = deps?.getConfig().spawnWaitTimeoutMs ?? DEFAULT_SPAWN_WAIT_TIMEOUT_MS;
  const delayMs = Math.max(0, requestedAt + windowMs - Date.now());
  activeWatchdogs.set(key, setTimeout(() => { fire(key, stage, requestedAt); }, delayMs));
}

/** One-shot fire: audit + deliver + one visible hint, then disarm itself. */
function fire(key: string, stage: PipelineStage, requestedAt: number): void {
  activeWatchdogs.delete(key);
  const current = deps;                              // re-read: deps refresh per hook
  if (!current) return;
  const meta = current.getMeta();
  if (!meta) return;
  const entry = meta.pendingSpawns?.[stage];
  if (!entry || entry.requestedAt !== requestedAt) return;   // consumed or replaced
  const liveAgentId = meta.activeSpawns?.[stage]?.agentId;
  if (liveAgentId && probeAgentState(liveAgentId) === "live") return; // progress, not a stall

  current.audit("pending_spawn_stalled", {
    pipelineId: meta.pipelineId, stage, agentName: entry.agentName,
    requestedAt: String(entry.requestedAt), ageMs: String(Date.now() - entry.requestedAt),
    attempts: String(entry.attempts),
  });
  current.deliver(
    `The ${stage} stage spawn request has been queued for ${Math.round((Date.now() - entry.requestedAt) / 1000)}s without being consumed. Run /pipeline-resume if no dialog appears.`,
    meta,
  );
  const owner = resolveOwnerDelivery(meta).handle;
  const message = `${stage} stage is queued but no executor was started. Run /pipeline-resume.`;
  try { owner ? owner.notify(message) : current.fallbackNotify(stage, message); } catch { /* fail-open */ }
}

/** Test-only: clear all armed deadlines. */
export function __resetPendingSpawnStall(): void {
  for (const timer of activeWatchdogs.values()) clearTimeout(timer);
  activeWatchdogs.clear();
  deps = null;
}
