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
  getRecord?: (id: string) => { status?: string; sessionFile?: string } | undefined;
  hasRunning?: () => boolean;
  /** Phase 0 (182): optional method for enumerating all records (name-based lookup). */
  listRecords?: () => Array<{ id?: string; name?: string; status?: string; sessionFile?: string }>;
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

/**
 * 194 Phase 0 (C3): narrow identity evidence for ONE full agent id, read from
 * the manager registry only. `found:false` / `ambiguous:true` / a missing
 * `sessionFile` are all ABSENT evidence: authority must fail closed.
 */
export interface AgentSessionEvidence {
  /** The full id that was probed */
  readonly agentId: string;
  /** True when the registry holds exactly one top-level record for this id */
  readonly found: boolean;
  /** Bounded liveness view (registry statuses are mapped, never invented) */
  readonly status: "live" | "settled" | "unknown";
  /** Raw registry status string when available (audit honesty) */
  readonly recordStatus?: string;
  /** Session file recorded by the runtime — only registry-sourced evidence */
  readonly sessionFile?: string;
  /** True when the id enumerates more than once (never identity) */
  readonly ambiguous: boolean;
}

/**
 * 194 Phase 0 (C3): narrow runtime evidence for ONE full agent id.
 *
 * Why this exists: a closed-loop executor may only be authorized from
 * registry evidence — `getRecord(fullId)` (filtered to top-level records by
 * pi-subagents, so another owner's child cannot leak) plus the record's
 * `sessionFile`. A short id / handle / `active_agent` prompt text is NEVER
 * identity evidence: an unresolvable id simply comes back `found:false`, and
 * the caller must fail closed instead of guessing.
 *
 * Fail-safe: an unavailable registry or API drift yields `status:"unknown"`
 * with no sessionFile — callers treat that as ABSENT evidence (pause / deny),
 * never as proof of settling.
 *
 * @param agentId - The FULL id returned by the trusted RPC reply
 */
export function probeAgentSessionEvidence(agentId: string): AgentSessionEvidence {
  const base: Omit<AgentSessionEvidence, "status" | "found" | "ambiguous"> = { agentId };
  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    return { ...base, found: false, status: "unknown", ambiguous: false };
  }
  try {
    const manager = (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] as ManagerRegistry | undefined;
    if (!manager || typeof manager.getRecord !== "function") {
      return { ...base, found: false, status: "unknown", ambiguous: false };
    }
    const record = manager.getRecord(agentId);
    if (!record) {
      // No live record: either settled-and-evicted or the id is not a full
      // registry id. Evidence is absent either way — never a trusted terminal.
      return { ...base, found: false, status: "unknown", ambiguous: false };
    }
    const status = typeof record.status === "string" ? record.status : undefined;
    const resolved: AgentSessionEvidence = {
      agentId,
      found: true,
      status: status === undefined ? "unknown" : LIVE_STATUSES.has(status) ? "live" : "settled",
      ambiguous: false,
      ...(status !== undefined ? { recordStatus: status } : {}),
      ...(typeof record.sessionFile === "string" && record.sessionFile.length > 0
        ? { sessionFile: record.sessionFile }
        : {}),
    };
    // Ambiguity guard: an id that enumerates more than once is never identity.
    if (typeof manager.listRecords === "function") {
      try {
        const records = manager.listRecords();
        if (Array.isArray(records)) {
          const matches = records.filter((r) => r && r.id === agentId).length;
          if (matches > 1) return { ...resolved, ambiguous: true, status: "unknown", sessionFile: undefined };
        }
      } catch {
        // Enumeration drift: keep getRecord evidence, ambiguity stays false.
      }
    }
    return resolved;
  } catch {
    return { ...base, found: false, status: "unknown", ambiguous: false };
  }
}

/** Map one registry record status onto a bounded executor terminal status. */
export function toExecutorTerminalStatus(
  recordStatus: string | undefined,
): "running" | "completed" | "failed" | "aborted" | "unknown" {
  if (recordStatus === undefined) return "unknown";
  if (LIVE_STATUSES.has(recordStatus)) return "running";
  if (recordStatus === "completed") return "completed";
  if (recordStatus === "error") return "failed";
  if (recordStatus === "aborted" || recordStatus === "stopped") return "aborted";
  return "unknown";
}
