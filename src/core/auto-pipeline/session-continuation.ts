/**
 * @module auto-pipeline/session-continuation
 * 221 Phase 4: `session_start` auto-start for a pending chained continuation.
 *
 * Facts:
 * - The continuation command is now ONE minimal `/pipeline-auto --next`; the
 *   new session learns job id + pending doc from the sidecar, never from args.
 * - Only the process that OWNS the lock may auto-start (INV-3). A lock held by
 *   another pid is left alone, and a DEAD holder is NOT reclaimed here — a
 *   manual `/pipeline-auto --next` handles that case. Both cases still surface
 *   ONE actionable hint (throttled per job) so the pending job is not invisible.
 * - Two `session_start` handlers in one process must not double-start: an
 *   in-process claim set guards the window around the start call.
 * - Failure split (B3): `startAutoJob` REPORTS the phase it failed in — before
 *   the lock the pending record stays retryable, after the lock the terminal
 *   transaction (`session_fail`) may run. The decision never infers ownership
 *   from the process-wide `isAutoJobActive()` (a previous session in the same
 *   process still holds that flag).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PipelineConfig } from "../../types";
import { safeWriteAuditLog } from "../../utils/auditLog";
import { hashJobBytes } from "./job-schema";
import { readJobState } from "./job-state";
import {
  acquireJobLock,
  getActiveJobId,
  isAutoJobActive,
  isProcessAlive,
  readJobLock,
  type LockInfo,
} from "./config-overlay";
import type { AutoPipelineResult } from "../../commands/pipeline-auto";
import type { FinalizeCtx } from "./finalize";
import { finalizeJob } from "./finalize";
import { auditAutoDiagnostic, notifyAuto } from "./diagnostics";

/**
 * In-process claims: two `session_start` handlers running in the same process
 * must not both start the same pending document.
 */
const continuationClaims = new Set<string>();

/**
 * Jobs already announced for a foreign/DEAD lock. `session_start` runs often;
 * the hint is useful once, an error banner on every turn is not.
 */
const foreignLockNotices = new Set<string>();

/** Test-only reset of the in-process claim/notice sets. */
export function __resetSessionContinuationForTests(): void {
  continuationClaims.clear();
  foreignLockNotices.clear();
}

/** Compare the on-disk job file with the sidecar hash (unreadable ⇒ drift). */
async function checkJobHash(
  projectRoot: string,
  state: { jobPath: string; jobHash: string },
): Promise<{ ok: boolean }> {
  const abs = path.isAbsolute(state.jobPath) ? state.jobPath : path.join(projectRoot, state.jobPath);
  try {
    const raw = await fs.readFile(abs, "utf8");
    return { ok: hashJobBytes(raw) === state.jobHash };
  } catch {
    // A missing/unreadable job file is drift: never start a doc against it.
    return { ok: false };
  }
}

/**
 * Surface ONE actionable hint for a pending continuation whose lock is not
 * owned by this process (Phase 4 acceptance: a lock held by another pid must
 * not auto-start or steal the lock, but it must still be reported). Never
 * start, never claim, never touch the lock.
 */
function notifyForeignLock(ctx: FinalizeCtx, config: PipelineConfig, lock: LockInfo): void {
  if (foreignLockNotices.has(lock.jobId)) return;
  const state = readJobState(config.projectRoot, lock.jobId);
  // No pending record → nothing is stuck; stay silent.
  if (!state || state.status !== "running" || !state.pendingContinuation) return;
  foreignLockNotices.add(lock.jobId);

  const alive = isProcessAlive(lock.pid);
  auditAutoDiagnostic(
    "pending_lock_foreign",
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
 * Start the pending document in THIS session (lazy import: `commands/*`
 * already imports `core/*`, so a static edge would close a load cycle).
 *
 * The result is returned AS-IS: `failurePhase` is the authoritative statement
 * of whether the failed call had acquired the lock.
 */
async function startNextDocInThisSession(
  ctx: FinalizeCtx,
  config: PipelineConfig,
  jobId: string,
): Promise<AutoPipelineResult> {
  try {
    const { startAutoJob } = await import("../../commands/pipeline-auto");
    return await startAutoJob({
      config,
      ctx: ctx as unknown as Parameters<typeof startAutoJob>[0]["ctx"],
      jobId,
      // The continuation path owns the terminal transaction.
      deferFailure: true,
    });
  } catch (err) {
    auditAutoDiagnostic("same_session_start_failed", `Auto job "${jobId}": continuation could not start.`, {
      jobId,
      error: String(err),
    }, "error");
    return { success: false, error: String(err), failurePhase: "pre_lock" };
  }
}

/**
 * Resume an outstanding continuation when a session starts.
 *
 * @returns TRUE when this call owned the start decision (either it started the
 *   doc, or it drove the job to a terminal state); FALSE when the caller should
 *   continue its ordinary session-start flow.
 */
export async function resumePendingContinuationOnSessionStart(
  ctx: FinalizeCtx,
  config: PipelineConfig,
): Promise<boolean> {
  // Frozen decision: only the process that owns the lock may auto-start.
  const lock = readJobLock(config.projectRoot);
  if (!lock) return false;
  if (lock.pid !== process.pid) {
    notifyForeignLock(ctx, config, lock);
    return false;
  }

  const meta = ctx.session.getMeta();
  // Never steal another pipeline that is still running in this session.
  if (meta?.pipelineId && meta.currentStage !== "completed") return false;

  const state = readJobState(config.projectRoot, lock.jobId);
  if (!state || state.status !== "running" || !state.pendingContinuation) return false;
  // Another job already owns this process → never start or finalize the wrong one.
  if (isAutoJobActive() && getActiveJobId() !== state.jobId) return false;
  if (continuationClaims.has(state.jobId)) return false;

  // Claim BEFORE the first await: two session_start handlers in one process
  // must never both pass the guard while the drift check is in flight.
  continuationClaims.add(state.jobId);
  try {
    // Drift gate: never start a document against a changed job file.
    const drift = await checkJobHash(config.projectRoot, state);
    if (!drift.ok) {
      await safeWriteAuditLog(
        "pipeline_auto_chain",
        { jobId: state.jobId, result: "job_drift" },
        "warn",
      );
      // The fresh runtime has no held lock: adopt it first so `finalizeJob` is
      // not a no-op (it releases the overlay + lock).
      const adopted = acquireJobLock({ projectRoot: config.projectRoot, jobId: state.jobId });
      if (adopted.ok) {
        await finalizeJob(ctx, config, { stopReason: "job_drift" });
      } else {
        notifyAuto(
          ctx,
          `Auto job "${state.jobId}": job file changed — check .pi/auto_pipeline before continuing.`,
        );
      }
      return true;
    }

    const outcome = await startNextDocInThisSession(ctx, config, state.jobId);
    if (outcome.success) {
      await safeWriteAuditLog("pipeline_auto_chain", {
        jobId: state.jobId,
        result: "session_start_auto",
      });
      return true;
    }
    // Failure BEFORE lock acquisition (job file unreadable/invalid/tier
    // rejected): the pending record stays UNCLAIMED so a later session_start
    // can retry — never a silent dead end. `failurePhase` is the runner's own
    // report, so a lock already held by a PREVIOUS session in this process
    // cannot misroute the decision to `session_fail` (B3).
    if (outcome.failurePhase !== "post_lock") {
      await safeWriteAuditLog(
        "pipeline_auto_chain",
        { jobId: state.jobId, result: "pending_start_retryable" },
        "warn",
      );
      notifyAuto(
        ctx,
        `Auto job "${state.jobId}": continuation could not start; run /pipeline-auto --next to retry.`,
      );
      return true;
    }
    // Failure AFTER lock acquisition: the terminal transaction is valid now.
    await safeWriteAuditLog(
      "pipeline_auto_chain",
      { jobId: state.jobId, result: "session_fail" },
      "warn",
    );
    await finalizeJob(ctx, config, { stopReason: "session_fail" });
    return true;
  } finally {
    continuationClaims.delete(state.jobId);
  }
}
