/**
 * @module auto-pipeline/session-continuation-recovery
 * 221 Phase 4 (INV-6): the two side-effectful steps of a `session_start`
 * continuation.
 *
 * Facts:
 * - Drift gate: a job file that no longer matches the sidecar hash must never
 *   start a document; the job is finalized as terminal `job_drift` (the fresh
 *   runtime holds no lock, so it is adopted first — otherwise `finalizeJob`
 *   would be a no-op).
 * - Start: `commands/*` already imports `core/*`, so the runner is imported
 *   dynamically to keep the module graph acyclic.
 * - Failure split (B3): `startAutoJob` REPORTS the phase it failed in. A THROW
 *   is not classified by the runner, so it is reported as `unknown` and the
 *   caller re-checks ownership instead of assuming `pre_lock`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PipelineConfig } from "../../types";
import { safeWriteAuditLog } from "../../utils/auditLog";
import { hashJobBytes } from "./job-schema";
import { acquireJobLock } from "./config-overlay";
import { auditAutoDiagnostic, notifyAuto } from "./diagnostics";
import { finalizeJob, type FinalizeCtx } from "./finalize";
import type { AutoJobState } from "./job-state";
import type { AutoPipelineResult } from "../../commands/pipeline-auto";

/** Compare the on-disk job file with the sidecar hash (unreadable ⇒ drift). */
export async function jobFileMatchesSidecar(
  projectRoot: string,
  state: Pick<AutoJobState, "jobPath" | "jobHash">,
): Promise<boolean> {
  const abs = path.isAbsolute(state.jobPath) ? state.jobPath : path.join(projectRoot, state.jobPath);
  try {
    const raw = await fs.readFile(abs, "utf8");
    return hashJobBytes(raw) === state.jobHash;
  } catch {
    // A missing/unreadable job file is drift: never start a doc against it.
    return false;
  }
}

/** Drive a drifted job to its terminal `job_drift` state (never throws). */
export async function finalizeDriftedJob(
  ctx: FinalizeCtx,
  config: PipelineConfig,
  state: Pick<AutoJobState, "jobId">,
): Promise<void> {
  await safeWriteAuditLog(
    "pipeline_auto_chain",
    { jobId: state.jobId, result: "job_drift" },
    "warn",
  );
  // The fresh runtime has no held lock: adopt it first so `finalizeJob` is not
  // a no-op (it releases the overlay + lock).
  const adopted = acquireJobLock({ projectRoot: config.projectRoot, jobId: state.jobId });
  if (adopted.ok) {
    await finalizeJob(ctx, config, { stopReason: "job_drift" });
    return;
  }
  notifyAuto(
    ctx,
    `Auto job "${state.jobId}": job file changed — check .pi/auto_pipeline before continuing.`,
  );
}

/**
 * Start the pending document in THIS session.
 *
 * The runner's result is returned AS-IS: `failurePhase` is its authoritative
 * statement of whether the failed call had acquired the lock. A throw is
 * reportable only as `unknown` (the caller re-checks ownership).
 */
export async function startPendingDocInThisSession(
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
    auditAutoDiagnostic(
      "same_session_start_failed",
      `Auto job "${jobId}": continuation could not start.`,
      { jobId, error: String(err) },
      "error",
    );
    return { success: false, error: String(err), failurePhase: "unknown" };
  }
}
