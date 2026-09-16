/**
 * @module spawn-evidence
 * Shared evidence scanner for `activeSpawns` entries (Phase 2 / 179, G3).
 *
 * Historically the duplicate-spawn guard read a single stage key
 * (`meta.activeSpawns[currentStage]`), which created a cross-stage blind spot:
 * after advancing to a new stage, a still-live same-agent child from the
 * previous stage became invisible to the guard, producing same-agent twins.
 *
 * This module centralizes the scan so tool-guard (3c suppression) and the
 * subagent-rpc wait-and-settle pre-check share one implementation.
 *
 * Evidence model (unchanged semantics):
 * - Primary: entry has an `agentId` AND `probeAgentState(agentId) === "live"`
 * - Secondary: entry is `reserved` and started less than RESERVED_SPAWN_EVIDENCE_MS ago
 */

import type { PipelineStage, SessionMeta } from "../types";
import { probeAgentState } from "./subagents-introspect";

/**
 * Reserved in-flight evidence window (ms). A `reserved` activeSpawns entry
 * (spawn ping in flight, no probeable id yet) counts as evidence only within
 * this window after `startedAt`.
 */
export const RESERVED_SPAWN_EVIDENCE_MS = 60_000;

/** A matched activeSpawns evidence entry. */
export interface SpawnEvidenceHit {
  /** Stage key under which the evidence entry is stored. */
  stage: PipelineStage;
  /** Agent id when present (probeable for `probe_live` hits). */
  agentId?: string;
  /** Which evidence tier matched. */
  basis: "probe_live" | "reserved";
}

/** Shape of a single activeSpawns entry (structural subset of SessionMeta). */
type ActiveSpawnEntry = NonNullable<SessionMeta["activeSpawns"]>[PipelineStage];

/**
 * Scans all `activeSpawns` entries for ANY live evidence, regardless of agent
 * name. Used as the degraded probe when `anyTopLevelRunning()` is unavailable
 * (e.g. confirm-gate deferral, Phase 4 / 179).
 *
 * @param activeSpawns - The meta.activeSpawns map (may be undefined)
 * @returns The first live/reserved hit, or null when no live evidence exists
 */
export function anyActiveSpawnEvidence(
  activeSpawns: SessionMeta["activeSpawns"],
): SpawnEvidenceHit | null {
  if (!activeSpawns) return null;

  for (const [stageKey, entry] of Object.entries(activeSpawns)) {
    const spawn = entry as ActiveSpawnEntry | undefined;
    if (!spawn) continue;

    if (spawn.agentId && probeAgentState(spawn.agentId) === "live") {
      return { stage: stageKey as PipelineStage, agentId: spawn.agentId, basis: "probe_live" };
    }
    if (spawn.reserved && (Date.now() - spawn.startedAt) < RESERVED_SPAWN_EVIDENCE_MS) {
      return { stage: stageKey as PipelineStage, agentId: spawn.agentId, basis: "reserved" };
    }
  }
  return null;
}

/**
 * Scans all `activeSpawns` entries for evidence that `expectedAgent` is live.
 *
 * @param activeSpawns - The meta.activeSpawns map (may be undefined)
 * @param expectedAgent - Agent name to match (entries with other names are skipped)
 * @param opts.excludeStage - Optional stage key to ignore (used by the
 *   wait-and-settle pre-check to look for live children in *other* stages)
 * @returns The first matching hit, or null when no live evidence exists
 */
export function scanActiveSpawnEvidence(
  activeSpawns: SessionMeta["activeSpawns"],
  expectedAgent: string,
  opts?: { excludeStage?: PipelineStage },
): SpawnEvidenceHit | null {
  if (!activeSpawns) return null;
  const excludeStage = opts?.excludeStage;

  for (const [stageKey, entry] of Object.entries(activeSpawns)) {
    const spawn = entry as ActiveSpawnEntry | undefined;
    // Guard against legacy/historical entries without an agentName field.
    if (!spawn || spawn.agentName !== expectedAgent) continue;
    if (excludeStage && stageKey === excludeStage) continue;

    // Primary evidence: agentId + probe=live
    if (spawn.agentId && probeAgentState(spawn.agentId) === "live") {
      return { stage: stageKey as PipelineStage, agentId: spawn.agentId, basis: "probe_live" };
    }
    // Secondary evidence: reserved in-flight (< window)
    if (spawn.reserved && (Date.now() - spawn.startedAt) < RESERVED_SPAWN_EVIDENCE_MS) {
      return { stage: stageKey as PipelineStage, agentId: spawn.agentId, basis: "reserved" };
    }
  }
  return null;
}
