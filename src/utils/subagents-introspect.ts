/**
 * @module subagents-introspect
 * Read-only probe for the pi-subagents manager singleton.
 *
 * Phase 4 (171) Q7-A: provides an authoritative "is an agent running?" check
 * by reading `globalThis[Symbol.for("pi-subagents:manager")]` — the in-process
 * manager registry documented in pi-subagents docs/rpc.md §The manager registry.
 *
 * Fail-safe: when the singleton is unavailable (not installed, filtered, or API drift),
 * returns "unknown" / null so callers degrade to secondary indicators (activeSpawns)
 * and ultimately to "do not block" (fail-open).
 *
 * Live statuses: queued | running | steered (per AgentRecord.status in types.ts:174).
 */

/** Manager singleton symbol (shared with pi-subagents extension) */
const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

/** Agent statuses considered "live" (actively occupying a slot) */
const LIVE_STATUSES = new Set(["queued", "running", "steered"]);

/** Minimal interface for the manager registry (fail-safe on field drift) */
interface ManagerRegistry {
  getRecord?: (id: string) => { status?: string } | undefined;
  hasRunning?: () => boolean;
}

/**
 * Probes the state of a specific agent by its record ID.
 *
 * @param agentId - The subagent record ID to probe
 * @returns "live" | "settled" | "unknown"
 */
export function probeAgentState(agentId: string): "live" | "settled" | "unknown" {
  try {
    const manager = (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] as ManagerRegistry | undefined;
    if (!manager || typeof manager.getRecord !== "function") return "unknown";

    const record = manager.getRecord(agentId);
    if (!record) return "settled";
    if (record.status && LIVE_STATUSES.has(record.status)) return "live";
    return "settled";
  } catch {
    return "unknown";
  }
}

/**
 * Checks whether any top-level agent is currently running.
 *
 * @returns true if at least one agent is live, false if none, null if probe unavailable
 */
export function anyTopLevelRunning(): boolean | null {
  try {
    const manager = (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] as ManagerRegistry | undefined;
    if (!manager || typeof manager.hasRunning !== "function") return null;
    return manager.hasRunning();
  } catch {
    return null;
  }
}
