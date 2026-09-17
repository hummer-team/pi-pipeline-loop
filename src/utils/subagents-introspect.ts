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
  /** Phase 0 (182): optional method for enumerating all records (name-based lookup). */
  listRecords?: () => Array<{ id?: string; name?: string; status?: string }>;
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

/**
 * Phase 0 (182): Finds a live agent by name from the manager registry.
 *
 * Used to detect out-of-band (manual/external) agents that share the same
 * name as the plugin's expected stage executor. When a live match is found,
 * the plugin should defer/avoid spawning a duplicate.
 *
 * Fail-open: returns null when:
 * - Manager singleton is unavailable (SDK not installed)
 * - `listRecords` is not exposed (API drift)
 * - No matching live record found
 *
 * @param name - The agent name to search for
 * @returns Object with agentId if found, null otherwise
 */
export function findLiveAgentByName(name: string): { agentId: string } | null {
  try {
    const manager = (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] as ManagerRegistry | undefined;
    if (!manager || typeof manager.listRecords !== "function") return null;

    const records = manager.listRecords();
    if (!Array.isArray(records)) return null;

    for (const record of records) {
      if (record.name === name && record.status && LIVE_STATUSES.has(record.status) && record.id) {
        return { agentId: record.id };
      }
    }
    return null;
  } catch {
    return null;
  }
}
