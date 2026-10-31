/**
 * @module auto-pipeline/config-overlay
 * 219 Phase 2: job → config overlay + process-level single-instance lock.
 *
 * Facts (frozen in 219_Feat.md 6.4 / plan Phase 2):
 * - The overlay writes ONLY the 6.4 mapping-table keys; `decisionPolicy` /
 *   `designReview.*` / `stopConditions.*` / `clarify.*` / `docs.*` /
 *   `chain.*` NEVER enter the config (decisionPolicy structurally
 *   incompatible + owned by the 210 provider chain).
 * - `applyOverlay` mutates the LIVE `PipelineConfig` object in place (the
 *   object all hooks captured at load time): it never reassigns its
 *   parameter, only does top-level key assignment, per-stage field writes
 *   and field-level `protect` merges (never a whole-block replacement,
 *   which would wipe `ask` / `allow` / `gitModify`).
 * - `applyOverlay` is idempotent by `jobHash` (B4): when the recorded
 *   snapshot already reflects this job's bytes, only the recorded `to`
 *   values are replayed — `before` is never re-computed, so a
 *   "session_start replay + --next" double-apply can never bake auto values
 *   into the rollback copy.
 * - The pipeline_loop.json file on disk is NEVER written: the overlay only
 *   mutates memory, so no cross-process residue can exist.
 * - The lock is PROCESS level (not per job): `jobA`/`jobB` can never be
 *   simultaneously active, otherwise two interleaved `applyOverlay` calls
 *   would cross-restore each other's snapshots.
 * - `acquireJobLock` auto-reclaims a stale holder (pid is dead) — a
 *   permanently busy state cannot exist. Release happens ONLY in
 *   `finalizeJob` (Phase 5); token mismatch warns and never throws.
 */

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as pathMod from "node:path";
import { randomUUID } from "node:crypto";
import type { PipelineConfig, PipelineJsonConfig, PipelineStage } from "../../types";
import { AUTO_PIPELINE_LOCK_FILE, CONFIG_DIR_NAME } from "../../constants";
import { safeWriteAuditLog } from "../../utils/auditLog";
import { resolvePipelineConfig } from "../json-config-loader";
import type { AutoJobConfig } from "./job-schema";
import { parseAutoJob, hashJobBytes } from "./job-schema";
import type { AutoJobState, OverlayEntry } from "./job-state";
import { listRunningJobs, readJobState, writeJobState, isValidJobId } from "./job-state";

export type { OverlayEntry };

/**
 * A parsed job carrying its raw-bytes hash (B4 idempotence credential) plus
 * the identity of the source file. `jobId` / `jobPath` are context, not bytes:
 * they are recorded on the snapshot for diagnostics and cross-session replay
 * (the lock is the fallback when a caller omits them).
 */
export type HashedJob = AutoJobConfig & {
  jobHash: string;
  jobId?: string;
  jobPath?: string;
};

/** One recorded config-overlay mutation set (sidecar single source of truth). */
export interface AutoJobSnapshot {
  jobId: string;
  jobPath: string;
  jobHash: string;
  appliedAt: number;
  /**
   * Deep copies of the PRE-overlay values of the TOUCHED keys only (not the
   * whole config). `restoreOverlay` reads this; an ABSENT key means the
   * value was absent before (restore deletes the field).
   */
  before: Record<string, unknown>;
  entries: OverlayEntry[];
}

/** On-disk process-level lock record (`{AUTO_PIPELINE_LOCK_FILE}`). */
export interface LockInfo {
  token: string;
  jobId: string;
  pid: number;
  startedAt: number;
}

export type AcquireJobLockResult =
  | { ok: true; adopted: boolean; token: string }
  | { ok: false; reason: "busy"; holder: LockInfo }
  | { ok: false, reason: "stale_token" };

// ─── Module-level lock ownership (in-process single source) ──────────────────

/**
 * The lock token THIS process currently holds. Set ONLY by a successful
 * `acquireJobLock` (which itself verified the lock is ours) and cleared by
 * `releaseJobLock`. `isAutoJobActive` reads THIS — never a second fact
 * derived from the disk file, so the two can never disagree in-process.
 */
let heldLock: { jobId: string; token: string } | null = null;

/** Test-only reset of the module-level lock ownership. */
export function __resetAutoJobLockForTests(): void {
  heldLock = null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveLockPath(projectRoot: string): string {
  return pathMod.join(projectRoot, AUTO_PIPELINE_LOCK_FILE);
}

/**
 * Liveness probe via `kill(pid, 0)`: ESRCH means dead; EPERM means the
 * process exists but is owned by another user — still ALIVE.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStageName(value: string): value is PipelineStage {
  return typeof value === "string" && value.length > 0;
}

/** Non-null record view for mutation; `null` for non-object inputs. */
function asMutableRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Structured deep copy for snapshot values (`before` / restore backfill). */
function deepCopy(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return value; // Non-cloneable — copy the reference (restore semantics identical).
  }
}

/**
 * Write (or delete, when `value === undefined`) a dotted config path on the
 * LIVE config object. Only the known mapping-table path shapes are accepted;
 * missing parent blocks are created defensively but NEVER a missing stage.
 */
function setLiveConfigPath(liveConfig: PipelineConfig, configPath: string, value: unknown): void {
  const live = asMutableRecord(liveConfig);
  if (!live) return;
  const segments = configPath.split(".");

  // stages.<stage>.<field>.<leaf> — never invents a missing stage block.
  if (segments[0] === "stages") {
    const stage = segments[1] ?? "";
    if (!isStageName(stage) || segments.length !== 4) return;
    const stages = asMutableRecord(live.stages);
    const stageObj = stages ? asMutableRecord(stages[stage]) : null;
    if (!stageObj) return;
    const fieldName = segments[2]!;
    const leaf = segments[3]!;
    const existingBlock = asMutableRecord(stageObj[fieldName]);
    if (existingBlock) {
      if (value === undefined) delete existingBlock[leaf];
      else existingBlock[leaf] = value;
    } else if (stageObj[fieldName] === undefined) {
      // Absent parent block: only create it when setting (delete = no-op).
      if (value !== undefined) stageObj[fieldName] = { [leaf]: value };
    }
    return;
  }

  // protect.<field> — field-level merge, never a whole-block replacement.
  if (segments[0] === "protect" && segments.length === 2) {
    const protect = asMutableRecord(live.protect);
    if (!protect) {
      if (value === undefined) return;
      live.protect = {} as PipelineConfig["protect"];
    } else {
      const leaf = segments[1]!;
      if (value === undefined) delete protect[leaf];
      else protect[leaf] = value;
    }
    return;
  }

  // audit.<field> (audit.autoDecisions is the only mapped leaf).
  if (segments[0] === "audit" && segments.length === 2) {
    const audit = asMutableRecord(live.audit);
    if (!audit) {
      if (value === undefined) return;
      live.audit = {} as PipelineConfig["audit"];
    } else {
      const leaf = segments[1]!;
      if (value === undefined) delete audit[leaf];
      else audit[leaf] = value;
    }
    return;
  }

  // Top-level scalar keys (maxLoops / maxLoopCycles).
  if (segments.length === 1) {
    const leaf = segments[0]!;
    if (value === undefined) delete live[leaf];
    else live[leaf] = value;
  }
}

/** Read a dotted config path from any object; `undefined` = absent. */
function readConfigPath(source: Record<string, unknown>, configPath: string): unknown {
  let current: unknown = source;
  for (const segment of configPath.split(".")) {
    const obj = asMutableRecord(current);
    if (!obj) return undefined;
    current = obj[segment];
  }
  return current;
}

// ─── Pure overlay (6.4 mapping table — the ONLY allowed writes) ──────────────

/**
 * Pure: deep-copies `base` and overwrites ONLY the 6.4 mapping-table keys.
 * Keys the job never maps (decisionPolicy / designReview / stopConditions /
 * clarify / docs / chain) are left byte-identical; `stages` blocks that do
 * not exist in the base are never invented.
 *
 * Entries record every touched path, including the H2 stage-level
 * `whitelistMiss` deletions (`to: undefined`) so `restoreOverlay` can
 * back-fill them.
 */
export function overlayJobOnJson(
  base: PipelineJsonConfig,
  job: AutoJobConfig,
): { json: PipelineJsonConfig; entries: OverlayEntry[] } {
  const json = structuredClone(base) as PipelineJsonConfig;
  const entries: OverlayEntry[] = [];
  const jsonView = json as unknown as Record<string, unknown>;

  const recordSet = (
    jobKey: string,
    configPath: string,
    target: Record<string, unknown>,
    leaf: string,
    to: unknown,
  ): void => {
    const from = target[leaf];
    if (from === undefined && to === undefined) return;
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      target[leaf] = to;
      entries.push({ jobKey, configPath, from: deepCopy(from), to });
    }
  };

  // Per-stage confirm modes (G2 zero-code — read by the existing confirm gate).
  for (const key of ["plan", "review"] as const) {
    const mode = job.confirm?.[key];
    if (mode === undefined) continue;
    const stageBlock = json.stages ? json.stages[key] : undefined;
    if (!stageBlock) continue; // Stage missing from base: never invent one.
    const confirmBlock: Record<string, unknown> =
      stageBlock.confirm !== undefined
        ? (stageBlock.confirm as unknown as Record<string, unknown>)
        : {};
    recordSet(`confirm.${key}`, `stages.${key}.confirm.mode`, confirmBlock, "mode", mode);
    stageBlock.confirm = confirmBlock as unknown as typeof stageBlock.confirm;
  }

  // reviewFix budgets → global loop knobs.
  if (job.reviewFix?.maxLoopsPerStage !== undefined) {
    recordSet("reviewFix.maxLoopsPerStage", "maxLoops", jsonView, "maxLoops", job.reviewFix.maxLoopsPerStage);
  }
  if (job.reviewFix?.maxRounds !== undefined) {
    recordSet("reviewFix.maxRounds", "maxLoopCycles", jsonView, "maxLoopCycles", job.reviewFix.maxRounds);
  }

  // writePolicy → protect block (field level; other fields untouched).
  if (job.writePolicy) {
    if (json.protect === undefined) json.protect = {} as PipelineJsonConfig["protect"];
    const protect = asMutableRecord(json.protect) as Record<string, unknown>;
    if (job.writePolicy.whitelistMiss !== undefined) {
      recordSet("writePolicy.whitelistMiss", "protect.whitelistMiss", protect, "whitelistMiss", job.writePolicy.whitelistMiss);
      // H2: the job value is the FINAL word — stage-level overrides must go,
      // otherwise Tier 1 of resolveWhitelistMissMode silently wins over the job.
      for (const [stage, block] of Object.entries(json.stages ?? {})) {
        const stageProtect = asMutableRecord(asMutableRecord(block)?.protect);
        if (stageProtect && stageProtect.whitelistMiss !== undefined) {
          entries.push({
            jobKey: "writePolicy.whitelistMiss",
            configPath: `stages.${stage}.protect.whitelistMiss`,
            from: deepCopy(stageProtect.whitelistMiss),
            to: undefined,
          });
          delete stageProtect.whitelistMiss;
        }
      }
    }
    if (job.writePolicy.allowGlobs !== undefined) {
      recordSet("writePolicy.allowGlobs", "protect.whitelistAllow", protect, "whitelistAllow", deepCopy(job.writePolicy.allowGlobs));
    }
    if (job.writePolicy.protectedPath !== undefined) {
      recordSet("writePolicy.protectedPath", "protect.protectedPathPolicy", protect, "protectedPathPolicy", job.writePolicy.protectedPath);
    }
    if (job.writePolicy.destructiveCommand !== undefined) {
      recordSet("writePolicy.destructiveCommand", "protect.destructiveCommand", protect, "destructiveCommand", job.writePolicy.destructiveCommand);
    }
  }

  // audit.recordAutoDecisions → audit block (audit.autoDecisions).
  if (job.audit?.recordAutoDecisions !== undefined) {
    if (json.audit === undefined) json.audit = {};
    const audit = (json.audit ?? {}) as Record<string, unknown>;
    recordSet("audit.recordAutoDecisions", "audit.autoDecisions", audit, "autoDecisions", job.audit.recordAutoDecisions);
    json.audit = audit as PipelineJsonConfig["audit"];
  }

  return { json, entries };
}

/**
 * Build the sidecar/pipeline-consumer snapshot for a job.
 * jobId / jobPath are supplied by the caller (they are context, not bytes).
 */
function buildSnapshot(
  job: HashedJob,
  jobId: string,
  jobPath: string,
  before: Record<string, unknown>,
  entries: OverlayEntry[],
): AutoJobSnapshot {
  return {
    jobId,
    jobPath,
    jobHash: job.jobHash,
    appliedAt: Date.now(),
    before,
    entries,
  };
}

/**
 * Decision 3 ordering: overlay on the JSON layer → resolve → write back.
 * Resolution keeps the defaults / validation / `piWorkDir` rewrites identical
 * to a normal load, so the auto values are indistinguishable from configured
 * ones. Returns `null` only when the base JSON is too incomplete to resolve
 * (unit fixtures); callers then fall back to the raw job values.
 */
function resolveOverlaidJson(json: PipelineJsonConfig): PipelineConfig | null {
  if (!json.stages) return null;
  try {
    return resolvePipelineConfig(json);
  } catch (err) {
    console.error(`[auto-pipeline] applyOverlay: resolvePipelineConfig failed — using raw job values: ${String(err)}`);
    return null;
  }
}

/**
 * In-place activation: write the overlay result back into the LIVE config
 * object so every hook that captured the same reference at load time sees
 * the auto values immediately.
 *
 * Idempotent by jobHash (B4): when `existingSnapshot.jobHash` equals this
 * job's hash, ONLY the recorded `to` values are replayed onto the live
 * config — `before` is not re-computed and the SAME snapshot (same
 * `appliedAt`) is returned, so `entries` never double-accumulate.
 *
 * INVARIANT: never reassigns the `liveConfig` parameter; only top-level key
 * assignment + per-stage field writes + field-level `protect` merges.
 */
export function applyOverlay(
  liveConfig: PipelineConfig,
  baseJson: PipelineJsonConfig,
  job: HashedJob,
  existingSnapshot?: AutoJobSnapshot,
): AutoJobSnapshot {
  if (existingSnapshot && existingSnapshot.jobHash === job.jobHash) {
    // B4 replay: re-stamp the recorded auto values. No new entries, no
    // before-recomputation, appliedAt unchanged.
    for (const entry of existingSnapshot.entries) {
      setLiveConfigPath(liveConfig, entry.configPath, entry.to);
    }
    return existingSnapshot;
  }

  // Fresh apply: compute the canonical overlay + entries from the job's base
  // JSON, resolve it (decision 3 ordering), capture the live pre-values of
  // every touched path, then write the RESOLVED values in place.
  const { json, entries } = overlayJobOnJson(baseJson, job);
  const resolved = resolveOverlaidJson(json);
  const resolvedView = (resolved ?? {}) as unknown as Record<string, unknown>;
  const before: Record<string, unknown> = {};
  const liveView = liveConfig as unknown as Record<string, unknown>;
  for (const entry of entries) {
    before[entry.configPath] = deepCopy(readConfigPath(liveView, entry.configPath));
    const resolvedValue = resolved ? readConfigPath(resolvedView, entry.configPath) : undefined;
    const value = entry.to === undefined ? undefined : resolvedValue ?? entry.to;
    setLiveConfigPath(liveConfig, entry.configPath, value);
  }
  const jobId = job.jobId ?? getActiveJobId() ?? "";
  return buildSnapshot(job, jobId, job.jobPath ?? "", before, entries);
}

/**
 * Restore the live config from a snapshot (deep-copy backfill). Idempotent:
 * calling twice restores the same values. A path ABSENT from `before` means
 * the field did not exist pre-overlay → the field is deleted. Accepts both
 * full snapshots and the sidecar's `overlaySnapshot` block (M5: only
 * `before` is consumed).
 */
export function restoreOverlay(
  liveConfig: PipelineConfig,
  snapshot: Pick<AutoJobSnapshot, "before">,
): void {
  for (const configPath of Object.keys(snapshot.before).sort()) {
    const preValue = snapshot.before[configPath];
    setLiveConfigPath(liveConfig, configPath, preValue === undefined ? undefined : deepCopy(preValue));
  }
}

// ─── Process-level lock ──────────────────────────────────────────────────────

/**
 * Read the on-disk lock; corrupt/foreign-schema JSON counts as no lock
 * (error logged, never thrown).
 */
export function readJobLock(projectRoot: string): LockInfo | null {
  const lockPath = resolveLockPath(projectRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return null; // Not present = no lock.
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockInfo> | null;
    if (
      parsed &&
      typeof parsed.token === "string" &&
      typeof parsed.jobId === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.startedAt === "number" &&
      isValidJobId(parsed.jobId)
    ) {
      return parsed as LockInfo;
    }
    console.error(`[auto-pipeline] readJobLock: malformed lock at ${lockPath} — treating as no lock`);
    return null;
  } catch (err) {
    console.error(`[auto-pipeline] readJobLock: corrupt lock at ${lockPath} — treating as no lock: ${String(err)}`);
    return null;
  }
}

function writeJobLock(projectRoot: string, lock: LockInfo): void {
  const lockPath = resolveLockPath(projectRoot);
  fs.mkdirSync(pathMod.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), "utf8");
}

/**
 * Acquire the PROCESS-level single-instance lock (M8 semantics):
 * - Existing holder ALIVE + different job → `busy` (B6: one job at a time,
 *   including a second job started within this same process).
 * - Holder is THIS process and the jobId matches → chain continuation
 *   (`adopted: true`, reuse the recorded token).
 * - Holder alive in ANOTHER process: `busy` (takeover:false); with
 *   takeover:true a MATCHING token adopts the lock, any other token →
 *   `stale_token` (never yank a live lock).
 * - Holder dead / lock absent → reclaim or fresh acquire. takeover:true +
 *   matching token continues with the SAME token (M8 rule 1); a
 *   mismatched/missing token on a DEAD holder is the crash-restart path
 *   (M8 rule 2) — succeeds with a fresh token (audited `stale_reclaimed`
 *   when a dead holder existed).
 */
export function acquireJobLock(input: {
  projectRoot: string;
  jobId: string;
  token?: string;
  takeover?: boolean;
}): AcquireJobLockResult {
  if (!isValidJobId(input.jobId)) {
    // Malformed ids must never own the lock file.
    return { ok: false, reason: "stale_token" };
  }
  const existing = readJobLock(input.projectRoot);

  if (existing) {
    const alive = pidAlive(existing.pid);
    if (alive) {
      if (existing.pid === process.pid) {
        if (existing.jobId === input.jobId) {
          heldLock = { jobId: existing.jobId, token: existing.token };
          return { ok: true, adopted: true, token: existing.token };
        }
        // B6: a second job can never be active — not even in one process.
        return { ok: false, reason: "busy", holder: existing };
      }
      if (input.takeover === true) {
        if (input.token && input.token === existing.token) {
          heldLock = { jobId: existing.jobId, token: existing.token };
          return { ok: true, adopted: true, token: existing.token };
        }
        return { ok: false, reason: "stale_token" };
      }
      return { ok: false, reason: "busy", holder: existing };
    }
    // Dead holder falls through to reclaim below.
  }

  const reclaim = existing !== null;
  const token =
    existing && input.token && input.token === existing.token
      ? input.token // Same-token continuation after a crash (M8 rule 1).
      : input.token ?? randomUUID();
  const lock: LockInfo = { token, jobId: input.jobId, pid: process.pid, startedAt: Date.now() };
  try {
    writeJobLock(input.projectRoot, lock);
  } catch (err) {
    console.error(`[auto-pipeline] acquireJobLock: failed writing lock: ${String(err)}`);
    return { ok: false, reason: "stale_token" };
  }
  heldLock = { jobId: lock.jobId, token: lock.token };
  if (reclaim) {
    void safeWriteAuditLog(
      "pipeline_auto_lock",
      { result: "stale_reclaimed", jobId: lock.jobId, deadPid: String(existing!.pid) },
      "warn",
    );
  }
  return { ok: true, adopted: reclaim, token: lock.token };
}

/**
 * Release the process lock (idempotent: a token mismatch only warns).
 * Called ONLY from `finalizeJob` — never from `finalizeCurrentDoc`, or the
 * chained continuation's second leg would find no lock.
 */
export function releaseJobLock(input: { projectRoot: string; token: string }): void {
  if (!heldLock || heldLock.token !== input.token) {
    console.warn("[auto-pipeline] releaseJobLock: token mismatch — lock left untouched");
    return;
  }
  heldLock = null;
  try {
    fs.rmSync(resolveLockPath(input.projectRoot), { force: true });
  } catch (err) {
    console.error(`[auto-pipeline] releaseJobLock: failed removing lock: ${String(err)}`);
  }
}

/**
 * TRUE when THIS process holds the auto-job lock. Single source: the
 * module-level `heldLock`, set exclusively by successful acquires — never a
 * second fact derived from the disk file.
 */
export function isAutoJobActive(): boolean {
  return heldLock !== null;
}

/** The jobId of the lock THIS process holds; `null` when not active. */
export function getActiveJobId(): string | null {
  return heldLock?.jobId ?? null;
}

/**
 * B3 (round 2): authorization-gate options for the active auto job. Callers
 * spread this into `designReviewAuthorisationGate(...)` so no call site
 * needs a non-null assertion on `getActiveJobId()`.
 */
export function autoPipelineAuthOpts(): { autoPipeline?: { jobId: string } } {
  const jobId = getActiveJobId();
  return jobId ? { autoPipeline: { jobId } } : {};
}

// ─── Sidecar / shutdown glue ────────────────────────────────────────────────

/**
 * The sidecar state behind the current process-level lock, or null.
 * Corrupt/absent lock or absent sidecar → null (callers must stay inert).
 */
export function readStateForActiveLock(projectRoot: string): AutoJobState | null {
  const lock = readJobLock(projectRoot);
  if (!lock) return null;
  return readJobState(projectRoot, lock.jobId);
}

/**
 * The job context of the CURRENT process-level lock (state + parsed job), or
 * null. Single reader used by every auto seam (freeze autopilot, settle hard
 * stop, loop brake) so the parse/hash/validation rules cannot diverge.
 */
export interface ActiveAutoJobContext {
  jobId: string;
  state: AutoJobState;
  job: AutoJobConfig;
  jobHash: string;
}

export function readActiveJobContext(projectRoot: string): ActiveAutoJobContext | null {
  if (!isAutoJobActive()) return null;
  const lock = readJobLock(projectRoot);
  // The lock file must still name THIS process; otherwise the in-process fact
  // and the disk record disagree and no auto seam may act.
  if (!lock || lock.pid !== process.pid) return null;
  const state = readJobState(projectRoot, lock.jobId);
  if (!state) return null;
  let raw: string;
  try {
    const jobPathAbs = pathMod.isAbsolute(state.jobPath)
      ? state.jobPath
      : pathMod.join(projectRoot, state.jobPath);
    raw = fs.readFileSync(jobPathAbs, "utf8");
  } catch (err) {
    console.error(`[auto-pipeline] readActiveJobContext: job file unreadable for ${lock.jobId}: ${String(err)}`);
    return null;
  }
  const parsed = parseAutoJob(raw, state.jobPath);
  if (!parsed.ok) {
    console.error(`[auto-pipeline] readActiveJobContext: job file invalid for ${lock.jobId} — no auto seam acts`);
    return null;
  }
  return { jobId: lock.jobId, state, job: parsed.job, jobHash: parsed.hash };
}

/**
 * M5 (round 2): shutdown rollback guard. TRUE guarantees
 * `state.overlaySnapshot` exists (assertion-free type guard), meaning
 * `finalizeJob` did NOT already own the rollback and shutdown may restore.
 */
export function shouldRestoreOnShutdown(
  state: AutoJobState | null,
): state is AutoJobState & { overlaySnapshot: NonNullable<AutoJobState["overlaySnapshot"]> } {
  return state !== null && state.overlaySnapshot !== undefined && state.status !== "running";
}

// ─── Session-start replay gate (session-starter wiring helper) ──────────────

/**
 * `session_start` overlay replay, gated by the plan §3(a) four states:
 * 1. exactly one running job AND (no lock OR dead lock pid) → verify the
 *    job-file hash → `applyOverlay` + audit `pipeline_auto_overlay_replay`;
 * 2. lock pid ALIVE in another process → NO replay — audit + notify (a
 *    second terminal's human session must not be silently flipped to auto);
 * 3. lock pid is THIS process (chained continuation) → NO replay, `--next`
 *    applies the overlay;
 * 4. hash drift → NO replay, `stopReason: "job_drift"` + notify.
 *
 * Zero running jobs (or several) → inert. Every failure path is fail-open
 * (session start is never blocked).
 */
export async function replayOverlayForSessionStart(
  config: PipelineConfig,
  notify: (message: string) => void,
): Promise<void> {
  const projectRoot = config.projectRoot;
  // In-process runner present → never replay (chained continuation applies the
  // overlay itself in `--next`). Also covers a lock file that vanished.
  if (isAutoJobActive()) return;
  const running = listRunningJobs(projectRoot);
  if (running.length !== 1) return; // Nothing (or ambiguous) → inert.
  const { jobId, state } = running[0]!;

  const lock = readJobLock(projectRoot);
  if (lock && pidAlive(lock.pid)) {
    if (lock.pid !== process.pid) {
      // State 2: another terminal owns the job. Never flip this session.
      await safeWriteAuditLog(
        "pipeline_auto_lock",
        { result: "held_other_process", jobId: lock.jobId, pid: String(lock.pid) },
        "warn",
      );
      notify(
        `Auto job "${lock.jobId}" is running in another process (pid ${lock.pid}). ` +
          "Config overlay NOT applied in this session.",
      );
      return;
    }
    // State 3: chained continuation in this process — --next applies the overlay.
    return;
  }

  // State 1 / 4: lock absent or holder dead. Verify hash before replaying.
  let raw: string;
  try {
    const jobPathAbs = pathMod.isAbsolute(state.jobPath)
      ? state.jobPath
      : pathMod.join(projectRoot, state.jobPath);
    raw = await fsPromises.readFile(jobPathAbs, "utf8");
  } catch (err) {
    console.error(`[auto-pipeline] replayOverlay: job file unreadable for ${jobId}: ${String(err)}`);
    return;
  }
  if (hashJobBytes(raw) !== state.jobHash) {
    // State 4: drift — never replay a file that is no longer the tracked one.
    state.stopReason = "job_drift";
    state.updatedAt = Date.now();
    try {
      await writeJobState(projectRoot, state);
    } catch (err) {
      console.error(`[auto-pipeline] replayOverlay: failed persisting job_drift for ${jobId}: ${String(err)}`);
    }
    notify(`Auto job "${jobId}" file changed since the run started — pipeline paused for review.`);
    return;
  }

  const parsed = parseAutoJob(raw, state.jobPath);
  if (!parsed.ok) {
    console.error(`[auto-pipeline] replayOverlay: job file failed validation for ${jobId} — no replay`);
    await safeWriteAuditLog("pipeline_auto_overlay_replay", { jobId, result: "invalid_job" }, "warn");
    return;
  }

  // Base JSON: re-read the config source this process was built from so the
  // overlay is computed on the SAME document (resolve fills piWorkDir etc.).
  let baseJson: PipelineJsonConfig;
  try {
    const jsonPath = config.configSourcePath ?? pathMod.join(projectRoot, CONFIG_DIR_NAME, "pipeline_loop.json");
    const rawJson = await fsPromises.readFile(jsonPath, "utf8");
    baseJson = JSON.parse(rawJson) as unknown as PipelineJsonConfig;
  } catch (err) {
    console.error(`[auto-pipeline] replayOverlay: config source unreadable: ${String(err)}`);
    return;
  }

  const existing: AutoJobSnapshot | undefined = state.overlaySnapshot
    ? {
        jobId: state.jobId,
        jobPath: state.jobPath,
        jobHash: state.overlaySnapshot.jobHash,
        appliedAt: state.overlaySnapshot.appliedAt,
        before: state.overlaySnapshot.before,
        entries: state.overlaySnapshot.entries,
      }
    : undefined;
  const snapshot = applyOverlay(config, baseJson, {
    ...parsed.job,
    jobHash: parsed.hash,
    jobId,
    jobPath: state.jobPath,
  }, existing);

  // Only a NEW (non-replayed) snapshot changes the sidecar — the single
  // source of truth for the restore path.
  if (!existing || snapshot.appliedAt !== existing.appliedAt) {
    state.overlaySnapshot = {
      appliedAt: snapshot.appliedAt,
      jobHash: snapshot.jobHash,
      before: snapshot.before,
      entries: snapshot.entries,
    };
    state.updatedAt = Date.now();
    try {
      await writeJobState(projectRoot, state);
    } catch (err) {
      console.error(`[auto-pipeline] replayOverlay: failed persisting overlay snapshot for ${jobId}: ${String(err)}`);
    }
  }
  await safeWriteAuditLog("pipeline_auto_overlay_replay", {
    jobId,
    jobHash: parsed.hash.substring(0, 12),
    reused: existing !== undefined,
  });
}
