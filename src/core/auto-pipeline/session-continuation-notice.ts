/**
 * @module auto-pipeline/session-continuation-notice
 * 221 Phase 4 (INV-6): throttled TUI hints for a pending chained continuation
 * that THIS process must not start.
 *
 * Facts:
 * - `session_start` runs often; a hint is useful ONCE per job, an error banner
 *   on every turn is not (the throttle set is process-local).
 * - Two "not mine" causes must BOTH be surfaced, otherwise the job stays
 *   `running` invisibly:
 *   1. the lock belongs to another pid (alive or dead) — never steal it;
 *   2. the lock file is missing/corrupt — no owner at all, so
 *      `/pipeline-auto --next` is the only recovery.
 * - Never starts, never claims, never touches the lock.
 */

import type { PipelineConfig } from "../../types";
import { isProcessAlive, type LockInfo } from "./config-overlay";
import { listRunningJobs, readJobState } from "./job-state";
import { auditAutoDiagnostic, notifyAuto } from "./diagnostics";
import type { FinalizeCtx } from "./finalize";

/** Jobs already announced for a lock this process cannot claim. */
const pendingLockNotices = new Set<string>();

/** Test-only reset of the in-process notice set. */
export function __resetSessionContinuationNoticesForTests(): void {
  pendingLockNotices.clear();
}

/** Audit action shared by every "not mine" hint (machine-stable column). */
const NOTICE_ACTION = "pending_lock_foreign";

/**
 * Surface ONE actionable hint for a pending continuation whose lock belongs to
 * another process (Phase 4 acceptance: never auto-start or steal the lock).
 */
export function notifyForeignLock(
  ctx: FinalizeCtx,
  config: PipelineConfig,
  lock: LockInfo,
): void {
  if (pendingLockNotices.has(lock.jobId)) return;
  const state = readJobState(config.projectRoot, lock.jobId);
  // No pending record → nothing is stuck; stay silent.
  if (!state || state.status !== "running" || !state.pendingContinuation) return;
  pendingLockNotices.add(lock.jobId);

  const alive = isProcessAlive(lock.pid);
  auditAutoDiagnostic(
    NOTICE_ACTION,
    `Auto job "${lock.jobId}": continuation pending, but the lock is not owned by this process.`,
    { jobId: lock.jobId, pid: String(lock.pid), holder: alive ? "alive" : "stale" },
    "warn",
  );
  notifyAuto(
    ctx,
    alive
      ? `Auto job "${lock.jobId}": continuation pending, but the lock is held by pid ${lock.pid} — continue in that process.`
      : `Auto job "${lock.jobId}": continuation pending, but the lock belongs to a dead process (pid ${lock.pid}) — run /pipeline-auto --next to resume.`,
    "warning",
  );
}

/**
 * Surface ONE actionable hint when there is NO usable lock at all
 * (`lock.json` deleted or malformed) while a sidecar is still `running` with a
 * pending continuation. Without this the job would silently stay `running`
 * forever because session_start refuses to start anything it cannot own.
 */
export function notifyMissingLock(ctx: FinalizeCtx, config: PipelineConfig): void {
  // `listRunningJobs` already filters `schemaVersion === 1 && status === "running"`.
  const pending = listRunningJobs(config.projectRoot).find(
    ({ state }) => state.pendingContinuation !== undefined,
  );
  if (!pending || pendingLockNotices.has(pending.jobId)) return;
  pendingLockNotices.add(pending.jobId);

  auditAutoDiagnostic(
    NOTICE_ACTION,
    `Auto job "${pending.jobId}": continuation pending, but no usable lock file exists.`,
    { jobId: pending.jobId, holder: "none" },
    "warn",
  );
  notifyAuto(
    ctx,
    `Auto job "${pending.jobId}": continuation pending, but the lock file is missing or unreadable — run /pipeline-auto --next to resume.`,
    "warning",
  );
}
