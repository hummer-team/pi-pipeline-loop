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
  /**
   * 218 Q23-A: stamp `stalledAt`/`dispatchAuthorizedAt` onto the queue entry
   * when the wait window expires (the manual-dispatch gate 3f only releases on
   * this mark). Assembled in `src/index.ts`; the watchdog lives in `core/` so
   * the write goes through dependency injection, never a direct meta handle.
   */
  updateMeta: (patch: Partial<SessionMeta>) => void;
}

/** Module-level deps, refreshed per hook invocation (same pattern as owner-wake). */
let deps: PendingSpawnStallDeps | null = null;
const activeWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * 217 fix (review round 2, issue 1): keys whose deadline already fired AND
 * reported a stall. 216 R6-2: an idempotent re-enqueue of the same target
 * KEEPS `requestedAt`, so the same key is re-armed after its timer fired —
 * without this record the clamped `delayMs` (now 0) would immediately
 * re-report the same stalled entry. "ONE-shot" therefore holds PER ENTRY,
 * not merely per concurrent arm; records are dropped by
 * `clearPendingSpawnStall` when the pipeline lifecycle ends.
 */
const reportedStalls = new Set<string>();

/** Installs (or clears, with `null`) the stall watchdog deps. */
export function setPendingSpawnStallDeps(next: PendingSpawnStallDeps | null): void { deps = next; }

/**
 * Arms ONE deadline per (pipelineId, stage, requestedAt). `requestedAt` is the
 * existing dedup key: a re-enqueue of the same target keeps it (216 R6-2), so a
 * repeated arm is a no-op; a replaced request produces a new key. A key whose
 * stall was already REPORTED is a permanent no-op until the entry is gone and
 * a fresh request is enqueued under a new `requestedAt`.
 */
export function armPendingSpawnStall(pipelineId: string, stage: PipelineStage, requestedAt: number): void {
  const key = `${pipelineId}:${stage}:${requestedAt}`;
  if (activeWatchdogs.has(key) || reportedStalls.has(key)) return;
  const windowMs = deps?.getConfig().spawnWaitTimeoutMs ?? DEFAULT_SPAWN_WAIT_TIMEOUT_MS;
  const delayMs = Math.max(0, requestedAt + windowMs - Date.now());
  const timer = setTimeout(() => { fire(key, stage, requestedAt); }, delayMs);
  // 217 fix (review round 2, issue 1): the watchdog must never keep the host
  // event loop alive — a one-shot/CLI host has to be able to exit while a
  // stall window is still pending (Phase 1 acceptance: "no residual timers").
  (timer as unknown as { unref?: () => void }).unref?.();
  activeWatchdogs.set(key, timer);
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

  // 218 Q23-A: stamp the authorization lifecycle ONTO THE ENTRY before the
  // audit line, so the 3f manual-dispatch gate can release exactly one spawn
  // for this queued target. `requestedAt` stays untouched (same dedup key).
  const stalledAt = Date.now();
  current.updateMeta({
    pendingSpawns: {
      ...(meta.pendingSpawns ?? {}),
      [stage]: { ...entry, stalledAt, dispatchAuthorizedAt: stalledAt },
    },
  });

  current.audit("pending_spawn_stalled", {
    pipelineId: meta.pipelineId, stage, agentName: entry.agentName,
    requestedAt: String(entry.requestedAt), ageMs: String(Date.now() - entry.requestedAt),
    attempts: String(entry.attempts),
    stalledAt: String(stalledAt),
    // 218 review #7: the field is persisted together with `stalledAt` and read
    // by the 3f manual gate — surface it so replay can confirm the
    // authorization actually landed (it previously had no read point at all).
    dispatchAuthorizedAt: String(stalledAt),
  });
  current.deliver(
    `The ${stage} stage spawn request has been queued for ${Math.round((Date.now() - entry.requestedAt) / 1000)}s without being consumed. Run /pipeline-resume if no dialog appears.`,
    meta,
  );
  const owner = resolveOwnerDelivery(meta).handle;
  const message = `${stage} stage is queued but no executor was started. Run /pipeline-resume.`;
  try { owner ? owner.notify(message) : current.fallbackNotify(stage, message); } catch { /* fail-open */ }
  // 217 fix (review round 2, issue 1): record ONLY after a confirmed report —
  // early returns above (consumed / replaced / live) leave no record, so a
  // legitimate re-arm for the same key stays possible.
  reportedStalls.add(key);
}

/**
 * 217 fix (review round 2, issue 1): production cleanup point — drop EVERY
 * armed deadline and reported-stall record of ONE pipeline. Called from
 * `session_shutdown` when the pipeline lifecycle ends (dormant/terminal
 * teardown, owner quit/new abort); a child panel close must NOT clear it,
 * because a queued entry still needs its stall visibility.
 */
export function clearPendingSpawnStall(pipelineId: string): void {
  if (!pipelineId) return;
  const prefix = `${pipelineId}:`;
  for (const [key, timer] of activeWatchdogs) {
    if (key.startsWith(prefix)) {
      clearTimeout(timer);
      activeWatchdogs.delete(key);
    }
  }
  for (const key of reportedStalls) {
    if (key.startsWith(prefix)) reportedStalls.delete(key);
  }
}

/** Test-only: clear all armed deadlines. */
export function __resetPendingSpawnStall(): void {
  for (const timer of activeWatchdogs.values()) clearTimeout(timer);
  activeWatchdogs.clear();
  reportedStalls.clear();
  deps = null;
}
