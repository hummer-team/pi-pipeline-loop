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

/**
 * Minimal interface for the manager registry (fail-safe on field drift).
 *
 * 218 Q19-B: `listRecords`/`listAgents` are NOT exposed by pi-subagents 0.22.0
 * (docs/rpc.md §The manager registry); do not depend on them. The only
 * reachable members are `getRecord(id)` and `hasRunning()`.
 */
interface ManagerRegistry {
  getRecord?: (id: string) => { status?: string; sessionFile?: string } | undefined;
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

// 218 Q19-B: `findLiveAgentByName` (Phase 0 / 182) was DELETED here.
// It depended on `manager.listRecords`, which pi-subagents 0.22.0 never
// exposed — the probe was constant `null`, and every caller silently
// degraded to "not live" (incident 20261028: a manually dispatched twin
// was invisible to the plugin). Same-stage liveness evidence now comes
// exclusively from the event ledger (`src/utils/spawn-ledger.ts`,
// `activeSpawns[*].source === "event"` + `probeAgentState(agentId)`).

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
  /** 218 Q19-B: enumeration is not exposed upstream, so duplicate ids are
   *  not determinable — this flag is permanently false; callers judge on
   *  `found`/`status`. */
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
    // 218 Q19-B: the old `listRecords` ambiguity guard was removed — the
    // upstream registry exposes no enumeration, so duplicate ids are NOT
    // determinable and `ambiguous` stays false by construction. Callers judge
    // on `found`/`status` only.
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
