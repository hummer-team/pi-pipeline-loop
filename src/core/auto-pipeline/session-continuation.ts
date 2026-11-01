/**
 * @module auto-pipeline/session-continuation
 * 221 Phase 4: `session_start` auto-start for a pending chained continuation.
 *
 * Facts:
 * - The continuation command is now ONE minimal `/pipeline-auto --next`; the
 *   new session learns job id + pending doc from the sidecar, never from args.
 * - Only the process that OWNS the lock may auto-start (INV-3). A lock held by
 *   another pid is left alone, and a DEAD holder is NOT reclaimed here — a
 *   manual `/pipeline-auto --next` handles that case.
 * - Two `session_start` handlers in one process must not double-start: an
 *   in-process claim set guards the window around the start call.
 * - Failure split (B3): failing BEFORE the lock is acquired keeps the pending
 *   record retryable; failing AFTER it runs the terminal transaction
 *   (`session_fail`), which needs the in-process lock that `startAutoJob`
 *   adopted.
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
  readJobLock,
} from "./config-overlay";
import type { FinalizeCtx } from "./finalize";
import { finalizeJob } from "./finalize";
import { notifyAuto } from "./diagnostics";

/**
 * In-process claims: two `session_start` handlers running in the same process
 * must not both start the same pending document.
 */
const continuationClaims = new Set<string>();

/** Test-only reset of the in-process claim set. */
export function __resetSessionContinuationForTests(): void {
  continuationClaims.clear();
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
 * Start the pending document in THIS session (lazy import: `commands/*`
 * already imports `core/*`, so a static edge would close a load cycle).
 */
async function startNextDocInThisSession(
  ctx: FinalizeCtx,
  config: PipelineConfig,
  jobId: string,
): Promise<boolean> {
  try {
    const { startAutoJob } = await import("../../commands/pipeline-auto");
    const result = await startAutoJob({
      config,
      ctx: ctx as unknown as Parameters<typeof startAutoJob>[0]["ctx"],
      jobId,
      // The continuation path owns the terminal transaction.
      deferFailure: true,
    });
    return result.success;
  } catch {
    return false;
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
  if (!lock || lock.pid !== process.pid) return false;

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

    const ok = await startNextDocInThisSession(ctx, config, state.jobId);
    if (ok) {
      await safeWriteAuditLog("pipeline_auto_chain", {
        jobId: state.jobId,
        result: "session_start_auto",
      });
      return true;
    }
    // Failure BEFORE lock acquisition (job file unreadable/invalid/tier
    // rejected): the pending record stays UNCLAIMED so a later session_start
    // can retry — never a silent dead end.
    if (!isAutoJobActive()) {
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
