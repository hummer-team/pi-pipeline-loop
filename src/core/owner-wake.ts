/**
 * @module owner-wake
 * Phase 1 / 200_Bug (G1-1, G1-2): Terminal event-driven owner wake.
 *
 * When a subagent reaches terminal state, check if the owner should be woken
 * via pi.sendUserMessage(followUp). Wake conditions (203_Bug Phase 0:
 * reason check is a blacklist — only `stopped`/empty/unknown are exempt):
 *
 * 1. Terminal reason exempt-set: `stopped` (and explicit empty/unknown) skip wake.
 * 2. Terminal agentId must match an activeSpawns[*].agentId (stage executor).
 * 3. No in-flight executors: all other activeSpawns agentIds must be non-live
 *    (probe via probeAgentState).
 * 4. Unprocessed pipeline work: pendingSpawns non-empty OR current stage not closed.
 *
 * Dedup: terminalWake: { agentId, stage, visitOrder, at } in SessionMeta.
 *
 * @see docs/design/200_Bug_plan.md#Phase 1
 */

import type { SessionMeta, PipelineStage } from "../types";
import type { DeliveryOutcome } from "./owner-delivery";
import { registerTerminalObserver, type SubagentLifecycleEntry } from "../utils/subagent-lifecycle-registry";
import { probeAgentState } from "../utils/subagents-introspect";
import { shouldEmitWithinWindow } from "../utils/audit-throttle";
import { AUDIT_THROTTLE_WINDOW_MS } from "../constants";

/**
 * 203_Bug Phase 0: Terminal-reason normalization switched from whitelist to
 * blacklist. Only `stopped` (plus explicit empty/unknown) are exempt from
 * waking. Any other observed reason (including the previously unchecked
 * "terminal" caused by SDK `subagents:*` payload field mismatch) proceeds to
 * activeSpawns matching; the raw value is always audited.
 */
const WAKE_EXEMPT_REASONS = new Set(["stopped"]);

/**
 * Owner wake observer dependencies.
 */
export interface OwnerWakeDeps {
  /** Read current SessionMeta */
  getMeta: () => SessionMeta | undefined;
  /** Update SessionMeta (for dedup) */
  updateMeta: (patch: Partial<SessionMeta>) => void;
  /** LEGACY fallback channel (kept for tests/embedders that predate 217). */
  sendFollowUp: (summary: string) => void;
  /** 217 F2: target-resolving delivery; preferred when present. */
  deliver?: (summary: string, meta: SessionMeta) => DeliveryOutcome;
  /** 217 Q8-A: one visible hint when delivery failed (throttled by caller). */
  notifyHint?: (stage: PipelineStage) => void;
  /** Audit log writer */
  audit: (event: string, payload: Record<string, unknown>) => void;
  /** Phase 2 / 200_Bug: Fallback path - immediate status bar refresh at terminal event */
  syncStatusBar: () => void;
}

/**
 * Module-level owner wake deps accessor.
 * Updated on every hook invocation to ensure we always have the latest session context.
 * Works around SDK limitation: no session context in global events.
 */
let _ownerWakeDeps: OwnerWakeDeps | null = null;

/**
 * Sets the owner wake deps accessor.
 * Called on every hook invocation to keep deps fresh.
 *
 * @param deps - Owner wake dependencies (null clears the accessor)
 */
export function setOwnerWakeDeps(deps: OwnerWakeDeps | null): void {
  _ownerWakeDeps = deps;
}

/**
 * Registers the owner wake observer.
 * Called once during plugin init (owner instance only).
 *
 * @returns Cleanup function that removes the observer
 */
export function registerOwnerWakeObserver(): () => void {
  return registerTerminalObserver((entry: SubagentLifecycleEntry) => {
    try {
      if (!_ownerWakeDeps) return;
      evaluateWake(entry, _ownerWakeDeps);
    } catch {
      // Fail-safe: observer errors must not crash the pipeline
    }
  });
}

/**
 * Evaluates whether owner wake is needed for a terminal event.
 */
function evaluateWake(
  entry: SubagentLifecycleEntry,
  deps: OwnerWakeDeps,
): void {
  const meta = deps.getMeta();
  if (!meta) return;

  const { agentId, agentType, reason, stage: entryStage } = entry;
  const pipelineId = meta.pipelineId;

  // Predicate 1: 203_Bug Phase 0 — normalized blacklist. Only `stopped`
  // (and explicit empty/unknown) are exempt; every other reason proceeds to
  // activeSpawns matching. Raw value kept in the audit for observability.
  const normalizedReason = (reason ?? "").trim().toLowerCase();
  if (
    normalizedReason === ""
    || normalizedReason === "unknown"
    || WAKE_EXEMPT_REASONS.has(normalizedReason)
  ) {
    deps.audit("owner_wake_skipped", {
      agentId,
      reason: "status_exempt",
      status: reason ?? "",
      rawStatus: reason ?? "",
      pipelineId: pipelineId ?? "",
    });
    return;
  }

  // Predicate 2: Terminal agentId must match an activeSpawns[*].agentId
  const activeSpawns = meta.activeSpawns ?? {};
  const matchingStage = Object.entries(activeSpawns).find(
    ([, spawn]) => spawn.agentId === agentId,
  )?.[0] as PipelineStage | undefined;

  if (!matchingStage) {
    deps.audit("owner_wake_skipped", {
      agentId,
      reason: "not_stage_executor",
      pipelineId: pipelineId ?? "",
    });
    return;
  }

  // Predicate 3: No in-flight executors (all other activeSpawns agentIds must be non-live)
  const otherAgentIds = Object.entries(activeSpawns)
    .filter(([s]) => s !== matchingStage)
    .map(([, spawn]) => spawn.agentId)
    .filter((id): id is string => !!id);

  const hasLivePeer = otherAgentIds.some((peerId) => {
    const state = probeAgentState(peerId);
    return state === "live";
  });

  if (hasLivePeer) {
    deps.audit("owner_wake_skipped", {
      agentId,
      reason: "has_live_peer",
      pipelineId: pipelineId ?? "",
    });
    return;
  }

  // Phase 2 / 200_Bug: Fallback path - immediate status bar refresh at terminal event
  // This ensures status bar updates even if main path (child context) cannot reach owner TUI
  try {
    deps.syncStatusBar();
  } catch {
    // fail-open: UI errors must not block owner wake logic
  }

  // Predicate 4: Unprocessed pipeline work
  const pendingSpawns = meta.pendingSpawns ?? {};
  const hasPendingSpawns = Object.keys(pendingSpawns).length > 0;
  const currentStageClosed = meta.summaries?.[matchingStage]?.status === "valid";

  if (!hasPendingSpawns && currentStageClosed) {
    deps.audit("owner_wake_skipped", {
      agentId,
      reason: "no_pending_work",
      pipelineId: pipelineId ?? "",
    });
    return;
  }

  // Dedup: check if we've already fired for this (agentId + stage + visitOrder)
  const visitOrder = meta.stageVisitOrder?.length ?? 0;
  const existingWake = meta.terminalWake;
  if (
    existingWake &&
    existingWake.agentId === agentId &&
    existingWake.stage === matchingStage &&
    existingWake.visitOrder === visitOrder
  ) {
    deps.audit("owner_wake_skipped", {
      agentId,
      reason: "dedup",
      pipelineId: pipelineId ?? "",
    });
    return;
  }

  // 217 F2: delivery FIRST, stamp AFTER success. The incident
  // (`pipe-1792915432897-hxekq4`) stamped `terminalWake` before delivering to
  // the wrong session, so every later terminal event hit the dedup guard
  // (`owner_wake_skipped reason=dedup` × 10) and the owner was never woken.
  const summary = buildWakeSummary(agentId, matchingStage, pipelineId, hasPendingSpawns);
  const outcome: DeliveryOutcome = deps.deliver
    ? deps.deliver(summary, meta)
    : (() => { deps.sendFollowUp(summary); return { delivered: true, via: "deps_fallback" as const }; })();

  // 217 F2: a FAILED delivery must not consume the dedup stamp — a later terminal
  // event (or the stall watchdog) may still reach a live owner.
  if (!outcome.delivered) {
    const throttleKey = `owner_wake_undeliverable:${pipelineId ?? ""}:${matchingStage}`;
    if (shouldEmitWithinWindow(throttleKey, AUDIT_THROTTLE_WINDOW_MS)) {
      deps.audit("owner_wake_undeliverable", {
        agentId, stage: matchingStage, pipelineId: pipelineId ?? "",
        targetSessionFile: outcome.targetSessionFile ?? "",
        reason: outcome.reason ?? "delivery_failed",
        via: outcome.via,
      });
      try { deps.notifyHint?.(matchingStage); } catch { /* fail-open: hint must not break wake */ }
    }
    return;
  }

  deps.updateMeta({ terminalWake: { agentId, stage: matchingStage, visitOrder, at: Date.now() } });
  deps.audit("owner_wake_on_terminal", {
    agentId, agentType: agentType ?? "", stage: matchingStage, status: reason ?? "",
    pipelineId: pipelineId ?? "", visitOrder, stageName: entryStage ?? "",
    delivered: "true", via: outcome.via,
    targetSessionFile: outcome.targetSessionFile ?? "",
    actualSessionFile: outcome.actualSessionFile ?? "",
  });
}

/**
 * Builds the wake summary message for the owner.
 */
function buildWakeSummary(
  agentId: string,
  stage: PipelineStage,
  pipelineId: string | undefined,
  hasPendingSpawns: boolean,
): string {
  const parts = [
    `Subagent "${agentId}" (stage: ${stage}) has reached terminal state.`,
  ];

  if (hasPendingSpawns) {
    parts.push("There are pending spawn requests that need processing.");
  } else {
    parts.push("The current stage has not been closed yet.");
  }

  if (pipelineId) {
    parts.push(`Pipeline: ${pipelineId}`);
  }

  parts.push("Please review and take appropriate action.");

  return parts.join(" ");
}
