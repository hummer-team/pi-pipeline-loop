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
import type { RuntimeCtx } from "../runtime-ctx";
import { detectSessionRole } from "../session-role";
import { noteDocStage, writeJobState } from "./job-state";
import { readActiveJobContext, readStateForActiveLock, isAutoJobActive } from "./config-overlay";
import { evaluateHardStop } from "./stop-policy";
import {
  continueJobAfterCompleted,
  finalizeCurrentDoc,
  finalizeJob,
  handleDocFailure,
  reconcilePendingContinuation,
  syncAutoCountersFromMeta,
  type FinalizeCtx,
} from "./finalize";
import {
  buildClarifyInstruction,
  noteClarifyMarkerMiss,
  auditClarifyMarkerMiss,
} from "./clarify-autopilot";
import { resolveAgentMention } from "../../utils/subagent-rpc";
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

  const active = readActiveJobContext(config.projectRoot);
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
  const hard = evaluateHardStop({ state, meta, job, now: Date.now() });
  if (hard.kind === "hard") {
    await handleDocFailure(ctx, config, state, job, {
      outcome: "failed",
      reason: hard.stopReason,
      verdict: hard,
    });
    return true;
  }
  return false;
}

/**
 * G1 degrade/fail for a missing clarify completion marker.
 *
 * Called ONLY where the pipeline already knows the marker is missing (the
 * settle completion-marker precheck), so a legitimate in-flight clarify turn is
 * never mistaken for a failure.
 *
 * @returns TRUE when the caller must stop its normal settle handling.
 */
export async function handleAutoClarifyMarkerMiss(
  ctx: FinalizeCtx,
  config: PipelineConfig,
  meta: SessionMeta,
): Promise<boolean> {
  if (meta.currentStage !== "clarify") return false;
  const active = readActiveJobContext(config.projectRoot);
  if (!active || active.state.status !== "running") return false;
  if (detectSessionRole(ctx as unknown as RuntimeCtx).isChild) return false;

  const { state, job } = active;
  const action = noteClarifyMarkerMiss({ state, docIndex: state.docIndex });
  await auditClarifyMarkerMiss(config, action);

  if (action === "degrade") {
    try {
      await writeJobState(config.projectRoot, state);
    } catch (err) {
      auditAutoDiagnostic("clarify_degrade_persist_failed", "Auto-job clarify degradation could not be persisted.", {
        jobId: state.jobId,
        error: String(err),
      }, "error");
    }
    // Re-dispatch the SAME clarify doc with the orchestrated (finalisation)
    // instruction — the documented degradation path.
    const agentName = resolveAgentMention(config, "clarify");
    const doc = meta.requirementDoc;
    const instruction = buildClarifyInstruction(job, "orchestrated");
    if (agentName && doc) {
      ctx.pi?.sendUserMessage?.(`@${agentName} ${doc} full-und?\n\n${instruction}`, {
        expandPromptTemplates: true,
      });
    }
    ctx.ui?.notify?.(
      `Auto job "${state.jobId}": clarify marker missing — degraded to orchestrated for ${doc ?? "the requirement doc"}.`,
    );
    return true;
  }

  // Second miss → doc failure (unified handleDocFailure path).
  await handleDocFailure(ctx, config, state, job, {
    outcome: "failed",
    reason: "clarify_marker_missing",
  });
  return true;
}
