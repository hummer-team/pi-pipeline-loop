/**
 * @module subagent-lifecycle-registry
 * Phase 0 / 200_Bug (G2-1, G2-2): In-memory subagent lifecycle registry with audit log.
 *
 * Subscribes to pi-subagents events (`subagents:created`, `subagents:completed`,
 * `subagents:failed`) and maintains a keyed registry of lifecycle entries.
 *
 * - `registerStarted`: records a subagent creation (startedAt set, status = "active").
 * - `registerTerminal`: records completion or failure (terminalAt set, status = "terminal").
 * - `snapshotForStage`: returns all entries for a given pipeline+stage.
 * - `findTerminal`: checks if a specific agentId has reached terminal state.
 *
 * Every state transition writes an audit log line via `safeWriteAuditLog`.
 *
 * Fail-safe: all subscription and registration errors are caught silently —
 * lifecycle tracking must never crash the pipeline or block subagent spawns.
 *
 * ## Owner meta access (SDK limitation workaround)
 *
 * The pi SDK `ExtensionAPI` does NOT expose a `session` property. The
 * `subagents:*` events are global events — they have no per-session `ctx`
 * parameter, so there is no direct path to the owner session meta from the
 * event listener alone.
 *
 * To work around this, the `createPipeline` factory updates a module-level
 * accessor (`_ownerMetaAccessor`) from within each hook callback, where the
 * real `ExtensionContext.sessionManager` is available via `buildRuntimeCtx`.
 * Event handlers read `currentStage` and `pipelineId` through this accessor.
 * This is safe because:
 *   - Hooks run on every owner interaction, keeping the accessor fresh.
 *   - Only one pipeline session is active per process at any given time.
 *   - If no hook has run yet (accessor is null), registration silently no-ops
 *     for stage/pipelineId (fail-safe: no false registrations on a cold start).
 */

import type { SessionMeta } from "../types";
import { safeWriteAuditLog } from "./auditLog";

/**
 * A single subagent lifecycle entry in the in-memory registry.
 * Keyed by agentId (the subagent's unique identifier).
 */
export interface SubagentLifecycleEntry {
  /** Agent type name (e.g. "develop-agent", "code-review-agent") */
  agentType: string;
  /** Subagent unique identifier (from subagents:created event) */
  agentId: string;
  /** Pipeline stage when the subagent was created (if available) */
  stage?: string;
  /** Lifecycle status */
  status: "active" | "terminal";
  /** Timestamp when the subagent was created */
  startedAt: string;
  /** Timestamp when the subagent reached terminal state (null if still active) */
  terminalAt?: string;
  /** Terminal reason: "completed" or "failed" or error message */
  reason?: string;
  /** Pipeline ID this subagent belongs to (if available) */
  pipelineId?: string;
}

/** In-memory registry: agentId → lifecycle entry */
const registry = new Map<string, SubagentLifecycleEntry>();

/**
 * Terminal observer registry: Phase 1 can subscribe to terminal events.
 * Called after each terminal registration.
 */
type TerminalObserver = (entry: SubagentLifecycleEntry) => void;
const terminalObservers: Set<TerminalObserver> = new Set();

/**
 * Registers a terminal observer. Called after each terminal event registration.
 * Phase 1 (G1-1/G1-2) uses this to check if owner wake is needed.
 *
 * @param observer - Function to call with the terminal entry
 * @returns Cleanup function that removes the observer
 */
export function registerTerminalObserver(observer: TerminalObserver): () => void {
  terminalObservers.add(observer);
  return () => { terminalObservers.delete(observer); };
}

/** Notify all registered terminal observers of a terminal event */
function notifyTerminalObservers(entry: SubagentLifecycleEntry): void {
  for (const observer of terminalObservers) {
    try { observer(entry); } catch { /* observer errors must not break registration */ }
  }
}

/**
 * Module-level reference to the most recent owner session meta accessor.
 *
 * Updated on every hook invocation — always reflects the latest owner state.
 * Null until the first hook fires (cold-start fail-safe: no-op registration).
 */
let _ownerMetaAccessor: (() => SessionMeta | undefined) | null = null;

/**
 * Updates the module-level owner session meta accessor.
 * Called by the `createPipeline` factory from within hook callbacks where
 * the real `ExtensionContext` (and thus `sessionManager`) is available.
 *
 * @param accessor - Function returning the latest SessionMeta snapshot
 */
export function setOwnerMetaAccessor(
  accessor: (() => SessionMeta | undefined) | null,
): void {
  _ownerMetaAccessor = accessor;
}

/**
 * Registers a subagent creation event.
 *
 * Sets status = "active", startedAt = now. If an entry already exists for
 * this agentId, it is overwritten (defensive: re-creation after crash).
 *
 * @param agentType - Agent type name (e.g. "develop-agent")
 * @param agentId - Subagent unique identifier
 * @param stage - Current pipeline stage (optional)
 * @param pipelineId - Current pipeline ID (optional)
 */
export function registerStarted(
  agentType: string,
  agentId: string,
  stage?: string,
  pipelineId?: string,
): void {
  const now = new Date().toISOString();
  const entry: SubagentLifecycleEntry = {
    agentType,
    agentId,
    stage,
    status: "active",
    startedAt: now,
    pipelineId,
  };
  registry.set(agentId, entry);

  // Audit log — fire-and-forget
  safeWriteAuditLog("subagent_lifecycle", {
    event: "started",
    agentType,
    agentId,
    stage: stage ?? "",
    pipelineId: pipelineId ?? "",
    startedAt: now,
  });
}

/**
 * Registers a subagent terminal event (completed or failed).
 *
 * If the agentId is not in the registry, creates a minimal entry
 * (defensive: terminal event arrived without a prior created event).
 *
 * @param agentType - Agent type name
 * @param agentId - Subagent unique identifier
 * @param status - Terminal status (always "terminal")
 * @param reason - Terminal reason: "completed", "failed", or error message
 * @param stage - Pipeline stage (optional, for late-arriving entries)
 * @param pipelineId - Pipeline ID (optional)
 */
export function registerTerminal(
  agentType: string,
  agentId: string,
  status: "terminal",
  reason?: string,
  stage?: string,
  pipelineId?: string,
): void {
  const now = new Date().toISOString();
  const existing = registry.get(agentId);

  if (existing) {
    existing.status = "terminal";
    existing.terminalAt = now;
    existing.reason = reason;
    // Fill in optional fields if not already set
    if (!existing.stage && stage) existing.stage = stage;
    if (!existing.pipelineId && pipelineId) existing.pipelineId = pipelineId;
  } else {
    // Defensive: create a minimal entry for orphaned terminal events
    registry.set(agentId, {
      agentType,
      agentId,
      stage,
      status: "terminal",
      startedAt: now,
      terminalAt: now,
      reason,
      pipelineId,
    });
  }

  // Audit log — fire-and-forget
  safeWriteAuditLog("subagent_lifecycle", {
    event: "terminal",
    agentType,
    agentId,
    status,
    reason: reason ?? "",
    stage: stage ?? "",
    pipelineId: pipelineId ?? "",
    terminalAt: now,
  });

  // Notify terminal observers (Phase 1 G1-1/G1-2 wake logic)
  notifyTerminalObservers(existing ?? registry.get(agentId)!);
}

/**
 * Returns all lifecycle entries for a given pipeline and stage.
 *
 * Used by G1 wake-up logic to check if all executors for a stage
 * have reached terminal state.
 *
 * @param pipelineId - Pipeline ID to filter by
 * @param stage - Stage name to filter by
 * @returns Array of matching entries
 */
export function snapshotForStage(
  pipelineId: string,
  stage: string,
): SubagentLifecycleEntry[] {
  const results: SubagentLifecycleEntry[] = [];
  for (const entry of registry.values()) {
    if (entry.pipelineId === pipelineId && entry.stage === stage) {
      results.push(entry);
    }
  }
  return results;
}

/**
 * Checks if a specific agentId has reached terminal state.
 *
 * Used by G1 to determine if the subagent that just terminated
 * should trigger an owner wake-up.
 *
 * @param agentId - Subagent unique identifier
 * @returns The lifecycle entry if found and terminal, undefined otherwise
 */
export function findTerminal(agentId: string): SubagentLifecycleEntry | undefined {
  const entry = registry.get(agentId);
  if (entry && entry.status === "terminal") {
    return entry;
  }
  return undefined;
}

/**
 * Returns a snapshot of the entire registry (for diagnostics).
 *
 * @returns Array of all lifecycle entries
 */
export function snapshotAll(): SubagentLifecycleEntry[] {
  return Array.from(registry.values());
}

/**
 * Subscribes to pi-subagents lifecycle events and populates the registry.
 *
 * Listens to:
 * - `subagents:created` → registerStarted
 * - `subagents:completed` → registerTerminal (reason = "completed")
 * - `subagents:failed` → registerTerminal (reason = "failed")
 *
 * Fail-safe: subscription errors are caught silently. The registry simply
 * won't be populated if events are unavailable.
 *
 * @param pi - Extension API handle (structural: needs `events.on`)
 * @returns Cleanup function that unsubscribes all listeners
 */
export function wireSubagentLifecycleListeners(
  pi: unknown,
): () => void {
  const bus = (pi as { events?: { on?: (event: string, handler: (payload: unknown) => void) => unknown } } | undefined)?.events;
  if (!bus || typeof bus.on !== "function") return () => {};

  const cleanups: Array<() => void> = [];

  try {
    // subagents:created → register as started
    const offCreated = bus.on("subagents:created", (payload: unknown) => {
      try {
        const event = payload as { id?: string; type?: string };
        if (!event.id || !event.type) return;
        
        // Get current stage and pipelineId from the owner meta accessor
        const meta = _ownerMetaAccessor?.();
        const stage = meta?.currentStage;
        const pipelineId = meta?.pipelineId;
        
        registerStarted(event.type, event.id, stage, pipelineId);
      } catch {
        // Fail-safe: never crash on event handling
      }
    });
    if (typeof offCreated === "function") cleanups.push(offCreated as () => void);

    // subagents:completed → register as terminal (completed)
    const offCompleted = bus.on("subagents:completed", (payload: unknown) => {
      try {
        const event = payload as { id?: string; type?: string };
        if (!event.id) return;
        
        // Get current stage and pipelineId from the owner meta accessor
        const meta = _ownerMetaAccessor?.();
        const stage = meta?.currentStage;
        const pipelineId = meta?.pipelineId;
        
        registerTerminal(
          event.type ?? "unknown",
          event.id,
          "terminal",
          "completed",
          stage,
          pipelineId,
        );
      } catch {
        // Fail-safe
      }
    });
    if (typeof offCompleted === "function") cleanups.push(offCompleted as () => void);

    // subagents:failed → register as terminal (failed)
    const offFailed = bus.on("subagents:failed", (payload: unknown) => {
      try {
        const event = payload as { id?: string; type?: string; requestId?: string };
        const agentId = event.id ?? event.requestId;
        if (!agentId) return;
        
        // Get current stage and pipelineId from the owner meta accessor
        const meta = _ownerMetaAccessor?.();
        const stage = meta?.currentStage;
        const pipelineId = meta?.pipelineId;
        
        registerTerminal(
          event.type ?? "unknown",
          agentId,
          "terminal",
          "failed",
          stage,
          pipelineId,
        );
      } catch {
        // Fail-safe
      }
    });
    if (typeof offFailed === "function") cleanups.push(offFailed as () => void);
  } catch {
    // Fail-safe: subscription failure must not crash the pipeline
    return () => {};
  }

  return () => {
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* best-effort */ }
    }
  };
}

/** Test-only reset: clears the entire registry, accessor, and observers. */
export function __resetLifecycleRegistry(): void {
  registry.clear();
  _ownerMetaAccessor = null;
  terminalObservers.clear();
}
