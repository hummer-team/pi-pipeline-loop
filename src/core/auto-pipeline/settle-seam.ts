/**
 * @module auto-pipeline/settle-seam
 * 219 Phase 5 §3.1 (Seam B): the settle-side auto transaction.
 *
 * Ordering (fixed):
 * 1. a COMPLETED doc wins over any hard-stop judgement (a finished document
 *    must never be re-labelled failed);
 * 2. otherwise the single sidecar write point derives the cross-doc counters
 *    (`totalLoops` from `meta.loopCycleCount`, verify-failure streak) and the
 *    last-seen stage (H4);
 * 3. then the hard-stop predicate is evaluated — a hard stop finalizes the doc.
 *
 * Child sessions never run this seam: their settle shares meta but the
 * transaction belongs to the owner.
 */

import type { PipelineConfig, SessionMeta } from "../../types";
import { docsDirsOf } from "../../docs-paths";
import type { RuntimeCtx } from "../runtime-ctx";
import { detectSessionRole } from "../session-role";
import { noteDocStage, writeJobState } from "./job-state";
import { readActiveJobContext, readStateForActiveLock, isAutoJobActive } from "./config-overlay";
import { evaluateHardStop, resolveVerifyMaxAttempts } from "./stop-policy";
import {
  continueJobAfterCompleted,
  finalizeCurrentDoc,
  finalizeJob,
  handleDocFailure,
  reconcilePendingContinuation,
  syncAutoCountersFromMeta,
  type FinalizeCtx,
} from "./finalize";
import { auditAutoDiagnostic, reportAutoFailure } from "./diagnostics";

/** TRUE when the settle was consumed by the auto transaction. */
export async function handleAutoSettle(
  ctx: FinalizeCtx,
  config: PipelineConfig,
  meta: SessionMeta,
): Promise<boolean> {
  // Phase 5 §4 + review 219 issue 9: the seam's ENTRY GATE reads only the
  // sidecar. `readActiveJobContext` re-parses the user-maintained job file, so
  // an edit/delete would make every seam silently inert (doc stuck in
  // `running`, lock never released, no audit).
  const state = readStateForActiveLock(config.projectRoot);
  if (!state) return false;
  if (detectSessionRole(ctx as unknown as RuntimeCtx).isChild) return false;
  // The sidecar ALONE is not enough: only the process that holds the lock may
  // run the auto transaction (a human session in another terminal must stay
  // inert even though the sidecar is running).
  if (!isAutoJobActive()) return false;
  if (state.status !== "running") return false;

  // 0) Review round 2 (issue 3): a continuation dispatched by a PREVIOUS turn
  // may have been dropped by the host. The record is proof; once overdue the
  // reconcile falls back to the same-session serial or stops the job honestly.
  if (await reconcilePendingContinuation(ctx, config)) return true;

  const active = readActiveJobContext(config.projectRoot, docsDirsOf(config).jobsDir);
  if (!active) {
    // The job file is no longer readable/valid ⇒ no budget can be judged. Stop
    // and report instead of idling (Phase 5 §4: any termination runs the
    // transaction; the overlay/lock are released by `finalizeJob`).
    reportAutoFailure(
      ctx,
      "settle_job_unreadable",
      `Auto job "${state.jobId}": job file is unreadable or invalid — stopping the job (job_drift).`,
      { jobId: state.jobId },
    );
    await finalizeJob(ctx, config, { stopReason: "job_drift" });
    return true;
  }

  const { job } = active;

  // 1) Completed wins over every hard-stop judgement.
  if (meta.currentStage === "completed") {
    const finalized = await finalizeCurrentDoc(ctx, config, { outcome: "completed" });
    if (!finalized.skipped) {
      await continueJobAfterCompleted(ctx, config, job);
    }
    return true;
  }

  // 2) Single write point for counters + last-seen stage.
  syncAutoCountersFromMeta({ state, meta, docIndex: state.docIndex });
  noteDocStage(state, state.docIndex, meta.currentStage, Date.now());
  try {
    await writeJobState(config.projectRoot, state);
  } catch (err) {
    auditAutoDiagnostic("settle_counters_persist_failed", "Auto-job counters could not be persisted.", {
      jobId: state.jobId,
      error: String(err),
    }, "error");
  }

  // 3) Hard stop (wall clock / blocked reason / verify failures / freeze).
  // The verify cap comes from the LIVE config so it is the exact value the
  // verify chain freezes on (`verify.maxAttempts` is inherit-not-overlay).
  const hard = evaluateHardStop({
    state,
    meta,
    job,
    now: Date.now(),
    verifyMaxAttempts: resolveVerifyMaxAttempts(config, job),
  });
  if (hard.kind === "hard") {
    await handleDocFailure(ctx, config, state, job, {
      outcome: "failed",
      // 226 Phase 3 (review 8f): the settle-seam hard stop keeps the SOURCE
      // cause — `freeze_unresolvable(<reason>)` when the verdict carries it.
      reason: hard.detail ? `${hard.stopReason}(${hard.detail})` : hard.stopReason,
      verdict: hard,
    });
    return true;
  }
  return false;
}

/**
 * The clarify completion-marker seam lives in its own module (clarify decision
 * + failure handling); re-exported here so the settle wiring keeps one import
 * site for the settle-side auto handling.
 */
export { handleAutoClarifyMarkerMiss } from "./clarify-marker-miss";
