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
// 210 Phase 2: idle-clock renewal on child terminal events (requirement 5.4
// whitelist), reported through the leaf sink so `utils/` keeps zero runtime
// imports from `core/`.
import { reportStageProgress } from "./stage-progress-sink";
// 218 P0 (T0.3/T0.4): the spawn ledger writer — same-layer (utils) module, fed
// from these listeners. Config/session accessors are installed by index.ts.
import { recordSpawnFromEvent, stageOfExecutorName } from "./spawn-ledger";

/**
 * 203_Bug Phase 0: Builds a leak-safe key summary of a raw SDK event payload.
 * Emits only the keys (and value types), never the values themselves, so
 * payload content is never written to the audit log.
 *
 * @param payload - Raw event payload (structural)
 * @returns Comma-joined "key:type" list, or empty string when unindexable
 */
function summarizeKeys(payload: unknown): string {
  try {
    if (payload === null || typeof payload !== "object") {
      return typeof payload;
    }
    return Object.keys(payload as Record<string, unknown>)
      .map((key) => {
        const value = (payload as Record<string, unknown>)[key];
        return `${key}:${typeof value}`;
      })
      .join(",");
  } catch {
    return "";
  }
}

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
  /**
   * 218 Bug T0.8: WHEN the `stage` value was observed.
   * - "dispatch": captured at `started`/`created` registration — a genuine
   *   dispatch-time snapshot, safe to use for wake attribution after the
   *   ledger entry is gone.
   * - "terminal": stamped by the orphan-terminal defensive branch. At that
   *   point `currentStage` describes the OWNER session, not this agent, so
   *   wake attribution must NOT trust it (incident 19:15:49 lesson).
   */
  stageAt?: "dispatch" | "terminal";
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
 * @param stage - Resolved executor stage (218 review #1: undefined for
 *   non-executors — the owner's currentStage is NOT a valid substitute)
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
    stageAt: "dispatch",
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
 * @param rawPayload - 203_Bug Phase 0: raw SDK event payload (optional); a
 *   key-value summary is included in the `subagent_lifecycle` audit to expose
 *   field-mismatch root causes without leaking values.
 */
export function registerTerminal(
  agentType: string,
  agentId: string,
  status: "terminal",
  reason?: string,
  stage?: string,
  pipelineId?: string,
  rawPayload?: unknown,
): void {
  const now = new Date().toISOString();
  const existing = registry.get(agentId);

  if (existing) {
    existing.status = "terminal";
    existing.terminalAt = now;
    existing.reason = reason;
    // Fill in optional fields if not already set.
    // 218 review #1: a dispatch-time entry with NO stage was deliberately
    // left unattributable (non-executor). Backfilling the owner's TERMINAL-time
    // stage here would fabricate exactly the snapshot predicate 2 trusts —
    // only late-arriving terminal-stamped entries may receive a stage.
    if (!existing.stage && stage && existing.stageAt !== "dispatch") existing.stage = stage;
    if (!existing.pipelineId && pipelineId) existing.pipelineId = pipelineId;
  } else {
    // Defensive: create a minimal entry for orphaned terminal events
    registry.set(agentId, {
      agentType,
      agentId,
      stage,
      stageAt: "terminal",
      status: "terminal",
      startedAt: now,
      terminalAt: now,
      reason,
      pipelineId,
    });
  }

  // Audit log — fire-and-forget
  // 203_Bug Phase 0: additional rawPayload key summary (keys only, no values)
  // to diagnose SDK payload field mismatches without leaking content.
  safeWriteAuditLog("subagent_lifecycle", {
    event: "terminal",
    agentType,
    agentId,
    status,
    reason: reason ?? "",
    rawStatus: reason ?? "",
    stage: stage ?? "",
    pipelineId: pipelineId ?? "",
    terminalAt: now,
    ...(rawPayload !== undefined
      ? { rawPayload: summarizeKeys(rawPayload) }
      : {}),
  });

  // 210 Phase 2 (requirement 5.4 whitelist): a child reaching terminal state is
  // stage progress — renew the idle clock of the owning pipeline. `pipelineId`
  // may be absent on a late event, so fall back to the registered entry.
  reportStageProgress(pipelineId ?? existing?.pipelineId, "settle");

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
    // 218 P0 (T0.4): `started` is the ONLY event that covers EVERY top-level
    // dispatch (RPC / Agent tool / scheduler / queued→running). `created` is
    // background-only in 0.22.0, so it is an enrichment, not the source.
    //
    // Why `registerStarted` here matters (T0.8 dependency): the lifecycle
    // entry's `stage` was ONLY written by `subagents:created` before 218, and
    // RPC dispatches never emit `created`. Without this registration,
    // `registerTerminal` falls into the orphan branch and stamps the stage at
    // TERMINAL time — after the executor advanced its own stage (incident
    // 19:15:49: 5× owner_wake_skipped reason=not_stage_executor). The
    // dispatch-time snapshot written here is what wake attribution falls back
    // to when the ledger entry is already cleared (T0.8).
    const offStarted = bus.on("subagents:started", (payload: unknown) => {
      try {
        const event = payload as { id?: string; type?: string; description?: string; isBackground?: boolean };
        if (!event.id || !event.type) return;

        const meta = _ownerMetaAccessor?.();
        // 218 review #1: ONLY a name that resolves to a configured stage
        // executor may carry the dispatch-time snapshot. The old
        // `?? meta?.currentStage` fallback attributed every observed child
        // (manual `explore`, helper agents…) to whatever stage the owner
        // happened to be in, and wake predicate 2 trusted it — producing
        // false owner_wake_on_terminal. Non-executors stay stage-less;
        // pipelineId scoping (below) is unaffected.
        // `null` (not configurable) normalizes to `undefined` (unattributable).
        const stage = stageOfExecutorName(event.type) ?? undefined;
        registerStarted(event.type, event.id, stage, meta?.pipelineId);
        // Ledger write (config/session are module-level accessors installed
        // by the composition root; missing ⇒ silent no-op).
        recordSpawnFromEvent(event, "started");
      } catch {
        // Fail-safe: ledger bookkeeping must never break dispatch.
      }
    });
    if (typeof offStarted === "function") cleanups.push(offStarted as () => void);

    // subagents:created → register as started (background spawns only)
    const offCreated = bus.on("subagents:created", (payload: unknown) => {
      try {
        const event = payload as { id?: string; type?: string; isBackground?: boolean };
        if (!event.id || !event.type) return;

        // Get current stage and pipelineId from the owner meta accessor.
        // 218 T0.4 + review #1: same resolution as `started` — the agent name
        // is the ONLY stage evidence; there is no currentStage fallback, so a
        // non-executor `created` event stays unattributable by design.
        const meta = _ownerMetaAccessor?.();
        const stage = stageOfExecutorName(event.type) ?? undefined;
        const pipelineId = meta?.pipelineId;

        registerStarted(event.type, event.id, stage, pipelineId);
        // 218 T0.4: enrichment path — carries `isBackground` for background
        // spawns; the ledger writer never overwrites an existing agentId.
        recordSpawnFromEvent(event, "created");
      } catch {
        // Fail-safe: never crash on event handling
      }
    });
    if (typeof offCreated === "function") cleanups.push(offCreated as () => void);

    // subagents:completed → register as terminal (completed)
    const offCompleted = bus.on("subagents:completed", (payload: unknown) => {
      try {
        // 203_Bug Phase 0: defensively resolve the terminal reason — some SDK
        // payload shapes carry it as `reason`, others as `status` (field
        // mismatch defensiveness). Falls back to the event-name-derived value.
        const event = payload as { id?: string; type?: string; reason?: string; status?: string };
        if (!event.id) return;
        const rawReason = event.reason ?? event.status;

        // Get current stage and pipelineId from the owner meta accessor
        const meta = _ownerMetaAccessor?.();
        const stage = meta?.currentStage;
        const pipelineId = meta?.pipelineId;

        registerTerminal(
          event.type ?? "unknown",
          event.id,
          "terminal",
          rawReason !== undefined && rawReason !== "" ? rawReason : "completed",
          stage,
          pipelineId,
          event,
        );
      } catch {
        // Fail-safe
      }
    });
    if (typeof offCompleted === "function") cleanups.push(offCompleted as () => void);

    // subagents:failed → register as terminal (failed)
    const offFailed = bus.on("subagents:failed", (payload: unknown) => {
      try {
        // 203_Bug Phase 0: same defensive reason resolution as "completed".
        const event = payload as { id?: string; type?: string; requestId?: string; reason?: string; status?: string };
        const agentId = event.id ?? event.requestId;
        if (!agentId) return;
        const rawReason = event.reason ?? event.status;

        // Get current stage and pipelineId from the owner meta accessor
        const meta = _ownerMetaAccessor?.();
        const stage = meta?.currentStage;
        const pipelineId = meta?.pipelineId;

        registerTerminal(
          event.type ?? "unknown",
          agentId,
          "terminal",
          rawReason !== undefined && rawReason !== "" ? rawReason : "failed",
          stage,
          pipelineId,
          event,
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
