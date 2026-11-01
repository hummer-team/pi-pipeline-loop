/**
 * @module auto-pipeline/session-continuation
 * 221 Phase 4: `session_start` auto-start for a pending chained continuation.
 *
 * Facts:
 * - The continuation command is ONE minimal `/pipeline-auto --next`; the new
 *   session learns job id + pending doc from the sidecar, never from args.
 * - Only the process that OWNS the lock may auto-start (INV-3). A lock held by
 *   another pid, and a MISSING lock, are left alone — but both surface ONE
 *   actionable hint (throttled per job) so the pending job is not invisible.
 * - Two `session_start` handlers in one process must not double-start: an
 *   in-process claim set guards the window around the start call.
 * - Failure split (B3): `startAutoJob` reports the phase it failed in. Before
 *   the lock the pending record stays retryable; after the lock the terminal
 *   transaction (`session_fail`) may run. A THROW is `unknown` and re-checked
 *   against `readActiveJobContext` — never inferred from `isAutoJobActive()`.
 */

import type { PipelineConfig } from "../../types";
import { safeWriteAuditLog } from "../../utils/auditLog";
import { readJobState } from "./job-state";
import {
  getActiveJobId,
  isAutoJobActive,
  readActiveJobContext,
  readJobLock,
} from "./config-overlay";
import type { FinalizeCtx } from "./finalize";
import { finalizeJob } from "./finalize";
import { notifyAuto } from "./diagnostics";
import {
  __resetSessionContinuationNoticesForTests,
  notifyForeignLock,
  notifyMissingLock,
} from "./session-continuation-notice";
import {
  finalizeDriftedJob,
  jobFileMatchesSidecar,
  startPendingDocInThisSession,
} from "./session-continuation-recovery";

/**
 * In-process claims: two `session_start` handlers running in the same process
 * must not both start the same pending document.
 */
const continuationClaims = new Set<string>();

/** Test-only reset of the in-process claim/notice sets. */
export function __resetSessionContinuationForTests(): void {
  continuationClaims.clear();
  __resetSessionContinuationNoticesForTests();
}

/** TRUE when this process truly owns the job RIGHT NOW (in-memory + disk). */
function thisProcessOwnsJob(projectRoot: string, jobId: string): boolean {
  return readActiveJobContext(projectRoot)?.jobId === jobId;
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
  if (!lock) {
    // No owner at all (file deleted/corrupt): only hint, never start or steal.
    notifyMissingLock(ctx, config);
    return false;
  }
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
    if (!(await jobFileMatchesSidecar(config.projectRoot, state))) {
      await finalizeDriftedJob(ctx, config, state);
      return true;
    }

    const outcome = await startPendingDocInThisSession(ctx, config, state.jobId);
    if (outcome.success) {
      await safeWriteAuditLog("pipeline_auto_chain", {
        jobId: state.jobId,
        result: "session_start_auto",
      });
      return true;
    }

    // A THROW is not classified by the runner. Re-check ownership: only a job
    // this process actually holds (in-memory + lock file) may be finalized.
    const ownsLock =
      outcome.failurePhase === "post_lock" ||
      (outcome.failurePhase === "unknown" && thisProcessOwnsJob(config.projectRoot, state.jobId));

    if (!ownsLock) {
      // Failure BEFORE lock acquisition (job file unreadable/invalid/tier
      // rejected): the pending record stays UNCLAIMED so a later session_start
      // can retry — never a silent dead end (B3).
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
