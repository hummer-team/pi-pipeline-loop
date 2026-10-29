/**
 * @module spawn-ledger
 * 218 P0: the ONE spawn ledger writer. `activeSpawns[stage]` is the single
 * "already live" truth, fed by three sources:
 *   1. plugin RPC reply id (`subagent-rpc` writeGuard — existing, unmarked ⇒
 *      legacy/"rpc" display per 218 T0.1);
 *   2. `subagents:started` (covers RPC / Agent-tool / scheduler / queue→running);
 *   3. `subagents:created` (carries `isBackground` into the audit trail only —
 *      never onto `ActiveSpawnEntry`; background-only today, an enrichment,
 *      never the source).
 *
 * Boundaries (Q16 / 4.6-2):
 * - Events arrive AFTER dispatch → the ledger can never replace the queue
 *   ownership gate (Phase 1).
 * - A ledger entry with an agentId is only evidence when `probeAgentState(id)`
 *   says live; age alone never proves liveness except for `reserved` (<60s).
 *
 * Layering (global constraint 7): this is a `utils/` module — no runtime
 * import from `../core/**`. Config and the owner session are injected as
 * module-level accessors from the composition root (`src/index.ts`), the same
 * process-wide "one active pipeline session" assumption already codified by
 * `setOwnerMetaAccessor` in `subagent-lifecycle-registry.ts`.
 * 218 round-3 review #7: the ledger↔registry edge is ONE-WAY — the registry
 * feeds this module; the terminal callback below is EXPORTED as a factory and
 * subscribed by `src/index.ts`, so this module imports nothing from the
 * registry and the utils-internal runtime cycle is gone.
 *
 * Fail-safe: missing accessors or malformed events degrade to silent no-ops —
 * ledger bookkeeping must never break dispatch.
 */

import type { PipelineConfig, PipelineStage, SessionMeta } from "../types";
import { ACTIVE_SPAWN_TTL_MS } from "../constants";
import { safeWriteAuditLog } from "./auditLog";
import { resolveAgentMention } from "./subagent-rpc";
import { probeAgentState } from "./subagents-introspect";
// 218 round-3 review #7 (Low): NO import from `./subagent-lifecycle-registry`
// — the registry feeds THIS module (one-way edge) and the composition root
// subscribes the terminal callback exported below. A runtime require in this
// direction would create a utils-internal cycle whose behaviour depends on
// which side loads first.

/** A single `activeSpawns` entry (structural view of the meta map value). */
type ActiveSpawnEntry = NonNullable<SessionMeta["activeSpawns"]>[PipelineStage];
/** The `activeSpawns` map itself. */
type ActiveSpawnsMap = NonNullable<SessionMeta["activeSpawns"]>;

export interface SpawnLedgerSession {
  getMeta: () => SessionMeta | undefined;
  updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
}

/**
 * Owner-scoped session writer installed from the hook bridge.
 * Child hooks must NOT install it (the ledger belongs to the owner session).
 * Null until the first owner hook fires (cold start ⇒ all writers no-op).
 */
let _ledgerSession: SpawnLedgerSession | null = null;

/** Factory-scoped config for name→stage resolution; one per plugin instance. */
let _ledgerConfig: PipelineConfig | null = null;

/** Installs (or clears) the owner session writer. Owner hook bridge only. */
export function setSpawnLedgerSession(session: SpawnLedgerSession | null): void {
  _ledgerSession = session;
}

/** Installs (or clears) the factory config. Called once per plugin instance. */
export function setSpawnLedgerConfig(config: PipelineConfig | null): void {
  _ledgerConfig = config;
}

/**
 * True stage ownership for an agent name: iterates `config.stages` and
 * compares `resolveAgentMention(config, stage)`. First exact match wins when
 * two stages share an agent name. Reads the module-level config installed by
 * `setSpawnLedgerConfig`; missing config ⇒ null (caller falls back).
 *
 * Stage names are NEVER hardcoded here — resolution goes through the config
 * so renamed/added stages keep working without a code change.
 */
export function stageOfExecutorName(agentName: string): PipelineStage | null {
  const config = _ledgerConfig;
  if (!config || !agentName) return null;
  for (const stageKey of Object.keys(config.stages) as PipelineStage[]) {
    if (resolveAgentMention(config, stageKey) === agentName) return stageKey;
  }
  return null;
}

/**
 * Writes/refreshes the ledger entry for the event's executor stage.
 * Identity is append-by-id, never merge: an existing entry carrying a
 * DIFFERENT agentId is never overwritten, and an id that already lives in
 * another stage only gets its `startedAt` refreshed (the stage key NEVER
 * migrates — the R11 mirror protection, so a stage advance cannot move the
 * evidence under a different name).
 *
 * Config + owner session come from the module-level accessors installed by
 * the composition root; missing accessors ⇒ silent no-op (fail-safe).
 *
 * @param event - Raw `subagents:started` / `subagents:created` payload (structural)
 * @param kind - Which event fed the write ("created" is enrichment-only for background spawns)
 */
export function recordSpawnFromEvent(
  event: { id?: string; type?: string; description?: string; isBackground?: boolean },
  kind: "started" | "created",
): void {
  const session = _ledgerSession;
  if (!session || !_ledgerConfig) return; // fail-safe: cold start / non-owner
  const agentId = typeof event.id === "string" ? event.id : "";
  const agentName = typeof event.type === "string" ? event.type : "";
  if (!agentId || !agentName) return;
  const meta = session.getMeta();
  if (!meta) return;
  const ledger = meta.activeSpawns ?? {};

  // 1. Identity-first: is this id already recorded (any stage)?
  const owningStage = (Object.keys(ledger) as PipelineStage[]).find(
    (s) => ledger[s]?.agentId === agentId,
  );

  if (owningStage) {
    const entry = ledger[owningStage]!;
    if (entry.agentName !== agentName) {
      // D1: dispatch fell through to a different type than the ledger recorded.
      // Observe only — evidence stays bound to the agentId, we never guess a
      // new stage and never migrate the existing entry.
      void safeWriteAuditLog("spawn_type_fallback_detected", {
        pipelineId: meta.pipelineId ?? "",
        stage: owningStage,
        agentId,
        agentName,
        ledgerAgentName: entry.agentName,
        kind,
      });
    }
    // Refresh liveness age; stage key, name and source stay untouched.
    const latest = session.getMeta();
    const cur = latest?.activeSpawns?.[owningStage];
    if (!cur) return; // cleared concurrently — nothing to refresh
    session.updateMeta({
      activeSpawns: {
        ...(latest?.activeSpawns ?? {}),
        [owningStage]: { ...cur, startedAt: Date.now() },
      },
    });
    void safeWriteAuditLog("spawn_ledger_event_written", {
      pipelineId: meta.pipelineId ?? "",
      stage: owningStage,
      agentId,
      agentName: cur.agentName,
      source: cur.source ?? "rpc",
      kind,
      refreshed: "true",
      // `created` enrichment semantics ride the audit only — the entry's
      // identity fields (agentId/stage/source) stay untouched.
      ...(event.isBackground !== undefined ? { isBackground: String(event.isBackground) } : {}),
    });
    return;
  }

  // 2. New identity → the event name must resolve to a configured stage,
  //    otherwise this is not a pipeline executor and gets no evidence.
  const stage = stageOfExecutorName(agentName);
  if (!stage) return;
  const existing = ledger[stage];
  // 218 review #3 + round-3 review #4: BOTH placeholder shapes are replaceable
  // by a genuine event id — SYNTHETIC ids (`takeover-…` / `dispatch:…`, the 3d
  // takeover / self-reserve paths) AND the ID-LESS `reserved:true` entry the
  // RPC `writeReserved` writes before the reply. A `started`/`created` event
  // must UPGRADE the slot in both cases, otherwise the ledger keeps a `reserved`
  // marker (and for synthetic ids an unclerable one) until TTL, contradicting
  // the "marker must not survive" contract below.
  const existingId = existing?.agentId;
  const isPlaceholder =
    !existingId ||
    existingId.startsWith("takeover-") ||
    existingId.startsWith("dispatch:");
  if (existingId && !isPlaceholder && existingId !== agentId) {
    // A DIFFERENT real agentId in this slot: never overwrite (218 T0.3).
    return;
  }
  const nextEntry: ActiveSpawnEntry = isPlaceholder
    ? // Placeholder replacement (covers synthetic-id AND id-less shapes):
      // FULL rewrite. The `reserved` marker, the absent/synthetic id and the
      // synthetic age must not survive — the event itself is the liveness
      // proof now. A bound operationContext still rides along.
      {
        agentName,
        agentId,
        startedAt: Date.now(),
        source: "event",
        ...(existing?.operationContext ? { operationContext: existing.operationContext } : {}),
      }
    : // Same REAL identity already on the slot: merge-refresh keeps the
      // original fields (RPC-writeGuard entries carry no `source`).
      {
        ...(existing ?? {}),
        agentName,
        agentId,
        startedAt: Date.now(),
        source: "event",
      };
  const latest = session.getMeta();
  session.updateMeta({
    activeSpawns: {
      ...(latest?.activeSpawns ?? {}),
      [stage]: nextEntry,
    },
  });
  void safeWriteAuditLog("spawn_ledger_event_written", {
    pipelineId: meta.pipelineId ?? "",
    stage,
    agentId,
    agentName,
    source: "event",
    kind,
    ...(event.isBackground !== undefined ? { isBackground: String(event.isBackground) } : {}),
  });
}

/**
 * Removes the ledger entry whose `agentId` matches exactly.
 * Entries with a DIFFERENT agentId on the same stage are left untouched
 * (regression guard for the 192 conditional-cleanup contract).
 * No-op when the id is absent or no session accessor is installed.
 */
export function clearSpawnByAgentId(agentId: string): void {
  const session = _ledgerSession;
  if (!session || !agentId) return;
  const meta = session.getMeta();
  if (!meta?.activeSpawns) return;
  const next: ActiveSpawnsMap = { ...meta.activeSpawns };
  const clearedStages: PipelineStage[] = [];
  for (const stageKey of Object.keys(next) as PipelineStage[]) {
    if (next[stageKey]?.agentId === agentId) {
      delete next[stageKey];
      clearedStages.push(stageKey);
    }
  }
  if (clearedStages.length === 0) return;
  session.updateMeta({ activeSpawns: next });
  for (const stage of clearedStages) {
    void safeWriteAuditLog("spawn_ledger_cleared", {
      pipelineId: meta.pipelineId ?? "",
      stage,
      agentId,
    });
  }
}

/**
 * TTL + restart reconciliation for every ledger entry:
 * - probe live  → keep
 * - probe settled → delete (authoritative terminal, no TTL wait)
 * - probe unknown (or id-less) → keep while age < ACTIVE_SPAWN_TTL_MS, else delete
 *
 * `now` is injectable for deterministic tests (no timers, no clock mocking).
 * Audits `spawn_ledger_reconciled` with kept/cleared/total. Callers throttle
 * (`shouldEmitWithinWindow`) — the function itself is a pure sweep.
 */
export function reconcileActiveSpawns(now: number = Date.now()): void {
  const session = _ledgerSession;
  if (!session) return;
  const meta = session.getMeta();
  if (!meta?.activeSpawns) return;
  const ledger = meta.activeSpawns;
  const stages = Object.keys(ledger) as PipelineStage[];
  if (stages.length === 0) return;

  const next: ActiveSpawnsMap = { ...ledger };
  let kept = 0;
  let cleared = 0;
  for (const stage of stages) {
    const entry = ledger[stage];
    if (!entry) continue;
    const probe = entry.agentId ? probeAgentState(entry.agentId) : "unknown";
    if (probe === "live") {
      kept++;
      continue;
    }
    if (probe === "settled") {
      delete next[stage];
      cleared++;
      continue;
    }
    // "unknown": age-bounded only — a dead id must not strand the ledger.
    if (now - entry.startedAt < ACTIVE_SPAWN_TTL_MS) {
      kept++;
    } else {
      delete next[stage];
      cleared++;
    }
  }

  if (cleared > 0) {
    session.updateMeta({ activeSpawns: next });
  }
  void safeWriteAuditLog("spawn_ledger_reconciled", {
    pipelineId: meta.pipelineId ?? "",
    kept: String(kept),
    cleared: String(cleared),
    total: String(stages.length),
  });
}

/**
 * Minimal structural shape the ledger reads from a terminal lifecycle entry.
 * Declared LOCALLY (218 round-3 review #7): `spawn-ledger` imports nothing
 * from `subagent-lifecycle-registry` — the full `SubagentLifecycleEntry` is
 * structurally assignable to this, so the registry→ledger edge stays one-way
 * and the utils-internal runtime cycle is gone.
 */
export interface SpawnLedgerTerminalSignal {
  agentId?: string;
}

/**
 * 218 P0 (T0.5): the ledger's terminal-observer CALLBACK factory — a terminal
 * agentId clears its entry (`spawn_ledger_cleared`), so "already live"
 * evidence never outlives the executor.
 *
 * REGISTRATION ORDER IS A CONTRACT (218 T0.5, wired at `src/index.ts`):
 * terminal observers run synchronously in insertion order
 * (`subagent-lifecycle-registry.ts`). This callback MUST be handed to
 * `registerTerminalObserver` AFTER `registerOwnerWakeObserver()` — the wake
 * decision reads the ledger (predicates 2/3); clearing first would make wake
 * behavior depend on registration order instead of evidence.
 *
 * @returns Observer callback to subscribe via `registerTerminalObserver`
 */
export function createSpawnLedgerTerminalObserver(): (entry: SpawnLedgerTerminalSignal) => void {
  return (entry: SpawnLedgerTerminalSignal): void => {
    try {
      if (!entry.agentId) return;
      clearSpawnByAgentId(entry.agentId);
    } catch {
      // Fail-safe: ledger bookkeeping must never break lifecycle registration.
    }
  };
}

/** Test-only reset: clears installed accessors (mirrors __resetLifecycleRegistry). */
export function __resetSpawnLedger(): void {
  _ledgerSession = null;
  _ledgerConfig = null;
}
