/**
 * @module auto-pipeline/job-state
 * 219 Phase 1: the project-level sidecar — the ONLY cross-session source of
 * truth for auto-pipeline progress (`.pi/auto_pipeline/{jobId}/state.json`).
 *
 * Facts:
 * - The job YAML file is never written back; ALL progress lives here.
 * - `overlaySnapshot` (single source of truth for the config overlay, Phase 2)
 *   lives here — never in `meta` (meta is per-pipelineId and wiped per doc).
 * - Cross-doc counters (`counters`) live here — meta is per-pipelineId.
 * - M3: `docIndex` = the index of the doc CURRENTLY EXECUTING. It advances
 *   when the NEXT doc starts, never in a finalize path.
 * - Writes are atomic: tmp file + rename (a process kill never leaves a half
 *   file behind). Write failures log an error and THROW — callers convert to
 *   `stop-and-report`.
 * - Back-compat: optional doc fields (`clarifyFallbackUsed` / `finalizeKey` /
 *   `lastStage` / `lastStageStartedAt`) are tolerated as `undefined` on read
 *   and never back-filled on write (schemaVersion stays 1).
 */

import * as fs from "node:fs";
import * as pathMod from "node:path";
import type { PipelineStage } from "../../types";
import { AUTO_PIPELINE_DIR } from "../../constants";
import type { AutoJobDoc } from "./job-schema";

/**
 * One recorded config overlay mutation (219 Phase 2). Declared here so the
 * sidecar stays self-contained; `config-overlay.ts` re-exports it and builds
 * the entries. `from` is the pre-overlay value (restored by `restoreOverlay`),
 * `to` is the auto value (replayed by the idempotent `applyOverlay`).
 */
export interface OverlayEntry {
  /** The job-yaml key that caused the mutation (diagnostics + replay gate). */
  jobKey: string;
  /** Dotted path into the resolved JSON config the mutation was applied to. */
  configPath: string;
  from: unknown;
  to: unknown;
}

export type AutoJobStatus = "idle" | "running" | "completed" | "stopped" | "failed";

export interface AutoJobDocProgress {
  doc: string;
  status: "pending" | "running" | "completed" | "skipped" | "failed";
  pipelineId?: string;
  /** last seen meta.loopCycleCount — used to derive totalLoops (monotonic). */
  lastLoopCycleCount?: number;
  /**
   * 219 Phase 5 §3 #3: last seen `meta.verifyAttempts` — the delta source of
   * `counters.consecutiveVerifyFailures`. A failed ATTEMPT counts once, no
   * matter how many rules it violated; a reset (stage advance / pass) rebases
   * it so the streak restarts instead of freezing on a stale number.
   */
  lastVerifyAttempts?: number;
  updatedAt: number;
  failReason?: string;
  /** per-doc clarify degradation flag. */
  clarifyFallbackUsed?: boolean;
  /** idempotency receipt — `${jobId}:${docIndex}:${outcome}` of the applied finalize. */
  finalizeKey?: string;
  /** H4 (round 2): the stage this doc was last seen in — the ONLY stage
   *  evidence when meta is gone. Written ONLY by the settle seam
   *  (`noteDocStage`) and at doc startup. */
  lastStage?: PipelineStage;
  lastStageStartedAt?: number;
}

export interface AutoJobState {
  schemaVersion: 1;
  jobId: string;
  jobPath: string;
  jobHash: string;
  jobTotalDocs: number;
  /**
   * M3 (round 2): the index of the doc CURRENTLY being executed.
   * Invariant: `finalizeCurrentDoc` NEVER advances it; it advances when the
   * NEXT doc starts.
   */
  docIndex: number;
  status: AutoJobStatus;
  startedAt: number;
  updatedAt: number;
  lastSettleAt?: number;
  /** 6.1-③: cross-doc counters MUST live here (meta is per-pipelineId, wiped per doc). */
  counters: {
    totalLoops: number;
    totalFreezes: number;
    consecutiveVerifyFailures: number;
    autoResumes: number;
    finalGraceUsed: Record<string, number>;
  };
  docs: AutoJobDocProgress[];
  stopReason?: AutoJobStopReason;
  /**
   * SINGLE SOURCE OF TRUTH for the overlay snapshot (never meta).
   * `before` = copy of the pre-overlay values of the TOUCHED keys only.
   * Cross-session recovery does NOT read this — it REPLAYS from the job file.
   */
  overlaySnapshot?: {
    appliedAt: number;
    jobHash: string;
    before: Record<string, unknown>;
    entries: OverlayEntry[];
  };
}

export type AutoJobStopReason =
  | "budget_exhausted"
  | "verify_failures"
  | "freeze_unresolvable"
  | "freeze_budget_exhausted"
  | "design_review_budget_exhausted"
  | "wall_clock"
  | "blocked_reason"
  | "session_fail"
  | "job_completed"
  | "user_cancelled"
  | "job_drift";

/**
 * job state path: `<projectRoot>/.pi/auto_pipeline/{jobId}/state.json`.
 */
export function resolveJobStateDir(projectRoot: string, jobId: string): string {
  return pathMod.join(projectRoot, AUTO_PIPELINE_DIR, jobId);
}

export function resolveJobStatePath(projectRoot: string, jobId: string): string {
  return pathMod.join(resolveJobStateDir(projectRoot, jobId), "state.json");
}

/**
 * jobId must be a safe on-disk segment (single path component, traversal-free).
 * Rejects empty strings, path separators, ".." and control characters.
 */
export function isValidJobId(jobId: string): boolean {
  if (typeof jobId !== "string" || jobId.length === 0) return false;
  if (jobId.includes("/") || jobId.includes("\\") || jobId.includes("\0")) return false;
  if (jobId === "." || jobId === "..") return false;
  return /^[A-Za-z0-9._-]+$/.test(jobId);
}

/**
 * Read the sidecar state; `null` when absent. Corrupt JSON or a foreign
 * `schemaVersion` counts as corrupt → `null` + error log (the caller refuses
 * to start and asks for human help).
 */
export function readJobState(projectRoot: string, jobId: string): AutoJobState | null {
  const statePath = resolveJobStatePath(projectRoot, jobId);
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf8");
  } catch {
    return null; // Not present yet — normal for a first run.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[auto-pipeline] readJobState: corrupt sidecar at ${statePath}: ${String(err)}`);
    return null;
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) {
    console.error(`[auto-pipeline] readJobState: unrecognized sidecar schema at ${statePath} — refusing to start`);
    return null;
  }
  const state = parsed as unknown as AutoJobState;
  // Optional fields stay optional (no back-fill write): the state returns as-is.
  return state;
}

/**
 * Monotonic suffix for the tmp file name. A FIXED name (`tmp-${pid}`) is unsafe
 * because the same process writes this sidecar from several independent paths
 * (settle seam, runner, fire-and-forget loop-brake persist): two concurrent
 * writes would share one tmp path, truncate each other, and a rename could
 * publish a half-written JSON. The per-call suffix makes every write own its
 * tmp file.
 */
let writeSequence = 0;

function nextTmpSuffix(): string {
  writeSequence += 1;
  return `${process.pid}-${writeSequence}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Write the sidecar atomically: write to a tmp file in the SAME directory,
 * then rename over the target (atomic on POSIX). Fail-closed: failures are
 * logged (error level) and rethrown — callers must convert to stop-and-report.
 */
export async function writeJobState(projectRoot: string, state: AutoJobState): Promise<void> {
  const statePath = resolveJobStatePath(projectRoot, state.jobId);
  const dir = pathMod.dirname(statePath);
  const tmpPath = pathMod.join(dir, `state.json.tmp-${nextTmpSuffix()}`);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const serialized = JSON.stringify({ ...state, schemaVersion: 1 as const }, null, 2);
    await fs.promises.writeFile(tmpPath, serialized, "utf8");
    await fs.promises.rename(tmpPath, statePath);
  } catch (err) {
    console.error(
      `[auto-pipeline] writeJobState FAILED: jobId=${state.jobId}, path=${statePath}, error=${String(err)}`,
    );
    try {
      await fs.promises.rm(tmpPath, { force: true });
    } catch {
      // Cleanup is best effort; the original failure is the one that matters.
    }
    throw err;
  }
}

/**
 * First doc that is still pending, in declared order. `null` = nothing pending.
 */
export function nextPendingDoc(state: AutoJobState): { index: number; doc: AutoJobDocProgress } | null {
  for (let i = 0; i < state.docs.length; i++) {
    if (state.docs[i]?.status === "pending") {
      return { index: i, doc: state.docs[i]! };
    }
  }
  return null;
}

/**
 * 6.1-③: derive totalLoops from the monotonic meta counter (restart-safe, no
 * extra write points). A counter rewind (rewind / meta replacement) clamps to
 * 0 — never negative.
 */
export function deriveLoopsSinceLastSeen(
  state: AutoJobState,
  docIndex: number,
  metaLoopCycleCount: number,
): number {
  const lastSeen = state.docs[docIndex]?.lastLoopCycleCount ?? 0;
  const delta = metaLoopCycleCount - lastSeen;
  return delta > 0 ? delta : 0;
}

/**
 * Scan the auto-pipeline state directory (bounded, ≤ 20 entries) for
 * `status === "running"`. Corrupt / unreadable entries are skipped with an
 * error log (never throw).
 */
export function listRunningJobs(projectRoot: string): { jobId: string; state: AutoJobState }[] {
  const dir = pathMod.join(projectRoot, AUTO_PIPELINE_DIR);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const running: { jobId: string; state: AutoJobState }[] = [];
  for (const candidate of entries.slice(0, 20)) {
    const statePath = pathMod.join(dir, candidate, "state.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as { schemaVersion?: unknown }).schemaVersion === 1 &&
        (parsed as { status?: unknown }).status === "running"
      ) {
        running.push({ jobId: candidate, state: parsed as unknown as AutoJobState });
      }
    } catch {
      console.error(`[auto-pipeline] listRunningJobs: unreadable sidecar at ${statePath} — skipped`);
    }
  }
  return running;
}

/**
 * Idempotency lookup decoupled from `docIndex` (M3): any doc carrying the
 * given finalizeKey counts as already finalized, wherever the index moved.
 */
export function hasFinalizeKey(state: AutoJobState, key: string): boolean {
  return state.docs.some((doc) => doc.finalizeKey === key);
}

/**
 * H4: update the last-seen stage for one doc. Single write point contract:
 * callers are the settle seam (agent-settled → stop-policy) and doc startup
 * (runner). Never called from recordStageVisit or prompt-side code paths.
 */
export function noteDocStage(state: AutoJobState, docIndex: number, stage: PipelineStage, now: number): void {
  const doc = state.docs[docIndex];
  if (!doc) return;
  doc.lastStage = stage;
  doc.lastStageStartedAt = now;
  doc.updatedAt = now;
  state.updatedAt = now;
}

/**
 * Create a fresh sidecar state for a validated job. Progress rows are seeded
 * from the (already de-duplicated) job doc list.
 */
export function createJobState(input: {
  jobId: string;
  jobPath: string;
  jobHash: string;
  docs: AutoJobDoc[];
}): AutoJobState {
  const now = Date.now();
  return {
    schemaVersion: 1,
    jobId: input.jobId,
    jobPath: input.jobPath,
    jobHash: input.jobHash,
    jobTotalDocs: input.docs.length,
    docIndex: 0,
    status: "idle",
    startedAt: now,
    updatedAt: now,
    counters: { totalLoops: 0, totalFreezes: 0, consecutiveVerifyFailures: 0, autoResumes: 0, finalGraceUsed: {} },
    docs: input.docs.map((doc) => ({ doc: doc.doc, status: "pending", updatedAt: now })),
  };
}
