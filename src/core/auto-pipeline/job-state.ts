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
 *   `lastStage` / `lastStageStartedAt`) and the optional `pendingContinuation`
 *   record are tolerated as `undefined` on read and never back-filled on write
 *   (schemaVersion stays 1).
 */

import * as fs from "node:fs";
import * as pathMod from "node:path";
import { JOB_FILE_EXTENSIONS } from "../../constants";
import type { PipelineStage } from "../../types";
import { AUTO_PIPELINE_DIR } from "../../constants";
import type { AutoJobDoc } from "./job-schema";
import type { StartStageBasis } from "./start-stage-evidence";
import { auditAutoDiagnostic } from "./diagnostics";

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
  // ─── 220 Phase 2: per-doc clarify accounting (B13: sidecar, NOT meta) ──────
  /** Rounds dispatched for THIS doc (monotonic; see `clarify-round-budget`). */
  clarifyRounds?: number;
  /** Highest dispatched round (dedupe + rewind protection). */
  clarifyLastRound?: number;
  /** Unix ms of the last clarify dispatch (30s coalescing window). */
  clarifyDispatchedAt?: number;
  /** Consecutive no-progress observations (`clarify-stall`). */
  clarifyStalls?: number;
  /** Signature of the last stall observation. */
  clarifyStallSignature?: string;
  /** Document length of the last stall observation. */
  clarifyStallDocLength?: number;
  /** Consecutive rounds assessed as `needs-clarify`. */
  clarifyNeedsClarifyStreak?: number;
  // ─── 220 Phase 5: start-stage evidence (B7) ────────────────────────────────
  /** What the doc's start stage was verified against. */
  startStageBasis?: StartStageBasis;
  /** Whether the start stage was explicit or derived (`auto`). */
  startStageDerivation?: "explicit" | "auto";
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
  /**
   * 219 review round 2 (issue 3): the OUTSTANDING `--next` dispatch.
   *
   * The dispatch channel (`pi.sendUserMessage`) has no callback, so a host that
   * never executes the dispatched command would leave the job `running` with a
   * completed doc, a held process lock and no receipt. The record is written
   * BEFORE the dispatch, cleared when the next doc really starts (runner) and
   * reconciled by {@link reconcilePendingContinuation} once it is provably
   * overdue.
   */
  pendingContinuation?: {
    /** Unix ms of the dispatch. */
    at: number;
    /** The doc index that was current when the dispatch was made. */
    docIndex: number;
    /**
     * `new_session` / `dispatch`: the pre-221 channels (kept readable).
     * `session_start` (221 Phase 4): a new session was opened and will start the
     * pending doc on `session_start` — no command is injected any more.
     */
    channel: "dispatch" | "new_session" | "session_start";
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
  | "job_drift"
  // 220 Phase 3 (D2): clarify discipline + the impossible idle state.
  | "clarify_stalled"
  | "clarify_requirement_unclear"
  | "clarify_budget_exhausted"
  | "awaiting_human_in_auto";

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
 * 222 Phase 4: resolve the ONE job file an auto seam must read.
 *
 * The configured `jobsDir` is the primary location (`docs.jobsDir`, when a run
 * moves the job directory the sidecar written by an older run still names the
 * OLD relative path). Resolution order:
 *   1. `<jobsDir>/<jobId>.yaml` when it exists — the current configuration wins;
 *   2. `<jobsDir>/<jobId>.yml` when it exists (223 Phase 3: the two extensions
 *      are peers, `.yaml` wins on a tie);
 *   3. the persisted `state.jobPath` when THAT exists (a job whose directory was
 *      moved before the config changed is still resumable);
 *   4. the configured `.yaml` path as a last resort, so the caller's read fails
 *      with the path the user actually configured instead of a stale one.
 *
 * `jobsDir` may be absolute or project-relative; `storedJobPath` follows the
 * same rule (`AutoJobState.jobPath` stays PROJECT-RELATIVE on disk).
 */
export function resolveTrackedJobFile(
  projectRoot: string,
  jobsDir: string,
  jobId: string,
  storedJobPath?: string,
): string {
  const configuredBase = pathMod.isAbsolute(jobsDir)
    ? pathMod.join(jobsDir, jobId)
    : pathMod.join(projectRoot, jobsDir, jobId);
  const configuredYaml = `${configuredBase}.yaml`;
  const configuredYml = `${configuredBase}.yml`;
  if (fs.existsSync(configuredYaml)) return configuredYaml;
  if (fs.existsSync(configuredYml)) return configuredYml;
  if (storedJobPath) {
    const stored = pathMod.isAbsolute(storedJobPath)
      ? storedJobPath
      : pathMod.join(projectRoot, storedJobPath);
    if (fs.existsSync(stored)) return stored;
  }
  return configuredYaml;
}

/** Existing job-file candidates in configured order (.yaml first, then .yml). */
export function findJobFileCandidates(projectRoot: string, jobsDir: string, jobId: string): string[] {
  const base = pathMod.isAbsolute(jobsDir)
    ? pathMod.join(jobsDir, jobId)
    : pathMod.join(projectRoot, jobsDir, jobId);
  return JOB_FILE_EXTENSIONS
    .map((ext) => `${base}${ext}`)
    .filter((candidate) => fs.existsSync(candidate));
}

/**
 * Matches a supported job-file extension at the end of a file name.
 *
 * 223 review issue 9 (L5): module-private — `stripJobFileExtension` below is the
 * only consumer inside this repo, so the export was needless public surface.
 */
const JOB_FILE_EXTENSION_RE = /\.(yaml|yml)$/;

/**
 * 223 Phase 3: strip a trailing `.yaml`/`.yml` from a job file name or a
 * `--job` argument. Case-sensitive by design (`.YAML` is not supported), so
 * `alpha_loop.yml` and `alpha_loop` resolve to the SAME jobId, while a
 * path-like argument keeps its separator and is still rejected by
 * `isValidJobId`.
 */
export function stripJobFileExtension(raw: string): string {
  return raw.replace(JOB_FILE_EXTENSION_RE, "");
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
    auditAutoDiagnostic("sidecar_corrupt", `Auto-job sidecar is not valid JSON — treated as absent: ${statePath}`, {
      error: String(err),
    });
    return null;
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) {
    auditAutoDiagnostic(
      "sidecar_schema_unknown",
      `Auto-job sidecar uses an unrecognized schema — refusing to use it: ${statePath}`,
      {},
      "error",
    );
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
    auditAutoDiagnostic(
      "sidecar_write_failed",
      `Auto-job sidecar write FAILED — the job stops and reports: ${statePath}`,
      { jobId: state.jobId, error: String(err) },
      "error",
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
      auditAutoDiagnostic("sidecar_unreadable", `Auto-job sidecar unreadable — entry skipped: ${statePath}`);
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
 * 219 review round 2 (issue 3): record the OUTSTANDING continuation hop.
 *
 * Written BEFORE the dispatch/rotation leaves this process so a lost channel is
 * provable from the sidecar alone (`reconcilePendingContinuation`).
 */
export function markPendingContinuation(
  state: AutoJobState,
  channel: "dispatch" | "new_session" | "session_start",
  now: number,
): void {
  state.pendingContinuation = { at: now, docIndex: state.docIndex, channel };
  state.updatedAt = now;
}

/**
 * Clear the outstanding continuation record. Returns TRUE when something was
 * actually cleared (callers persist only then).
 */
export function clearPendingContinuation(state: AutoJobState): boolean {
  if (!state.pendingContinuation) return false;
  state.pendingContinuation = undefined;
  state.updatedAt = Date.now();
  return true;
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
