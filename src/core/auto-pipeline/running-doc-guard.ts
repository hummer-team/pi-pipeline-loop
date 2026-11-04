/**
 * @module auto-pipeline/running-doc-guard
 * 224 Phase 2: a `running` doc is never mistaken for "no work left".
 *
 * Facts:
 * - The guard is READ-ONLY: it classifies and describes, it never writes the
 *   sidecar, never releases the lock and never restores overlays.
 * - `mode` is decided from REAL evidence (meta ownership + spawn ledger +
 *   `probeAgentState` + `ACTIVE_SPAWN_TTL_MS`), mirroring the rules of
 *   `prompt-injector.ts`'s active-spawn note (218: single source constant).
 * - All-terminal state is NOT a hit: the existing `job_completed` path owns it.
 */

import type { PipelineStage } from "../../types";
import { ACTIVE_SPAWN_TTL_MS } from "../../constants";
import type { AutoJobState } from "./job-state";

/** A running doc found in the sidecar (index is 0-based, docIndex-shaped). */
export interface RunningDocHit {
  index: number;
  doc: string;
  /** `lastStage` — the ONLY stage evidence when meta is gone. */
  stage?: PipelineStage;
  pipelineId?: string;
}

/** The guard classifies a running doc as still working or as stalled. */
export type RunningDocMode = "running" | "stalled";

/** NULL when no doc is `running` ( accepted terminal statuses never hit). */
export function findRunningDoc(state: AutoJobState): RunningDocHit | null {
  const index = state.docs.findIndex((progress) => progress.status === "running");
  if (index < 0) return null;
  const progress = state.docs[index]!;
  return { index, doc: progress.doc, stage: progress.lastStage, pipelineId: progress.pipelineId };
}

/**
 * Evidence the guard reads at the call site — all optional ⇒ "stalled"
 * (a missing proof never masks a vanished executor as "running").
 */
export interface RunningDocEvidence {
  /** Owner session truth: meta.pipelineId / meta.currentStage at guard time. */
  metaPipelineId?: string;
  metaStage?: PipelineStage;
  /** meta.activeSpawns[hit.stage] — probe-driven liveness (218 rule). */
  activeSpawn?: { agentId?: string; startedAt: number; reserved?: boolean };
  /** meta.pendingSpawns[hit.stage] present ⇒ queued work exists. */
  hasPendingSpawn: boolean;
  /** Injected so the classifier stays pure/testable. */
  probeAgent: (agentId: string) => "live" | "settled" | "unknown";
  now: number;
}

/**
 * Classification order (same source rules as `prompt-injector.ts:1473`):
 * 1. meta does not belong to this doc/visit ⇒ stalled;
 * 2. a pending spawn exists ⇒ a queued executor WILL run (running);
 * 3. an agentId exists: probe live ⇒ running; unknown ⇒ TTL degrade; settled ⇒ stalled;
 * 4. only a reserved in-flight entry ⇒ TTL degrade (no agentId to probe).
 */
export function classifyRunningDoc(hit: RunningDocHit, ev: RunningDocEvidence): RunningDocMode {
  if (hit.pipelineId && ev.metaPipelineId !== hit.pipelineId) return "stalled";
  if (ev.metaStage !== undefined && hit.stage && ev.metaStage !== hit.stage) return "stalled";
  if (ev.hasPendingSpawn) return "running";
  if (ev.activeSpawn?.agentId) {
    const probe = ev.probeAgent(ev.activeSpawn.agentId);
    if (probe === "live") return "running";
    if (probe === "unknown") {
      return ev.now - ev.activeSpawn.startedAt < ACTIVE_SPAWN_TTL_MS ? "running" : "stalled";
    }
    return "stalled";
  }
  if (ev.activeSpawn?.reserved) {
    return ev.now - ev.activeSpawn.startedAt < ACTIVE_SPAWN_TTL_MS ? "running" : "stalled";
  }
  return "stalled";
}

/** ONE user-visible message + the audit row for a refused start. */
export function describeAlreadyRunning(input: {
  jobId: string;
  totalDocs: number;
  hit: RunningDocHit;
  mode: RunningDocMode;
}): { message: string; audit: Record<string, string | boolean> } {
  const stage = input.hit.stage ?? "(unknown)";
  const audit: Record<string, string | boolean> = {
    jobId: input.jobId,
    doc: input.hit.doc,
    stage,
    mode: input.mode,
  };
  const message = input.mode === "running"
    ? `Auto job "${input.jobId}": doc ${input.hit.index + 1}/${input.totalDocs} (${input.hit.doc}) is already running at stage "${stage}" — nothing was started. Wait for it to settle (or run /pipeline-resume).`
    : `Auto job "${input.jobId}": doc ${input.hit.index + 1}/${input.totalDocs} (${input.hit.doc}) is recorded as running at stage "${stage}" but no live executor exists — nothing was started. Run /pipeline-resume to continue.`;
  return { message, audit };
}
