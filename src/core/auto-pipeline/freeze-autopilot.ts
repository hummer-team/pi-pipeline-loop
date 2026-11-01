/**
 * @module auto-pipeline/freeze-autopilot
 * 219 Phase 3 G6: the single auto decision-maker for a frozen pipeline.
 *
 * Facts (frozen in 219_Feat.md 6.5 decisions 5/6/9 + plan Phase 3 §6):
 * - `requestDecision` is the ONLY freeze entry (both `ensureDecisionMenu`
 *   production call sites live inside it), so the seam there covers every
 *   freeze path. `freezeAndPrompt` only forwards the `reason` — a second
 *   decision point there would let two authorities alternate per call path.
 * - Precedence is FIXED: `byReason[reason]` → `onFreeze` → `"stop-and-report"`.
 *   `"stop-and-report"` NEVER falls back to the 210 provider chain — a job
 *   that decided to stop must not be auto-resumed by a provider rule.
 * - `totalFreezes` is incremented HERE and nowhere else (one write point next
 *   to `autoResumes`, so a counter can never be silently missed).
 * - `freezePolicy` is JOB-PRIVATE: nothing from this module is ever written
 *   into `config.decisionPolicy` (the 210 provider-chain block).
 *
 * Dependency note: this module calls back into `flow-state` (`executeDecision`)
 * only at runtime, so the `flow-state ↔ freeze-autopilot` import cycle cannot
 * observe a partially-initialised module.
 */

import type { PipelineConfig, SessionMeta } from "../../types";
import type { EnsureDecisionMenuResult } from "../decision-menu-runtime";
import { executeDecision } from "../flow-state";
import type { FlowStateCtx } from "../flow-state";
import type { RequestDecisionOpts } from "../flow-state";
import { safeWriteAuditLog } from "../../utils/auditLog";
import type { AutoJobConfig, FreezeAction } from "./job-schema";
import type { AutoJobState } from "./job-state";
import { writeJobState } from "./job-state";
import { getActiveJobId, isAutoJobActive, readActiveJobContext } from "./config-overlay";
import { auditAutoDecision } from "./auto-audit";
import { auditAutoDiagnostic, reportAutoFailure } from "./diagnostics";

/** One resolved freeze action plus the precedence branch that produced it. */
export interface ResolvedFreezeAction {
  action: FreezeAction;
  /** `by_reason` | `on_freeze` | `max_auto_resumes` — diagnostics/audit only. */
  basis: string;
}

/**
 * Resolve the auto action for one freeze reason (pure).
 *
 * `byReason[blockedReason]` wins over `onFreeze`; a missing/unmatched reason
 * falls through to `onFreeze`, and finally to `"stop-and-report"`. A `resume`
 * is downgraded to `"stop-and-report"` once `maxAutoResumes` is used up
 * (cross-doc counter lives in the sidecar).
 */
export function resolveFreezeAction(input: {
  meta: SessionMeta;
  job: AutoJobConfig;
  state: AutoJobState;
  reason: string;
}): ResolvedFreezeAction {
  const { job, state, reason } = input;
  const byReason = job.freezePolicy?.byReason ?? {};
  const explicit = byReason[reason];
  const action: FreezeAction = explicit ?? job.freezePolicy?.onFreeze ?? "stop-and-report";
  const basis = explicit ? "by_reason" : "on_freeze";
  if (action !== "resume") return { action, basis };
  const maxAutoResumes = job.freezePolicy?.maxAutoResumes ?? 0;
  const used = state.counters?.autoResumes ?? 0;
  if (used >= maxAutoResumes) {
    return { action: "stop-and-report", basis: "max_auto_resumes" };
  }
  return { action, basis };
}

/** Menu-shaped result for a decision the autopilot resolved itself. */
function decidedResult(message: string): EnsureDecisionMenuResult {
  return { outcome: "decided", applied: true, retryArmed: false, joined: false, message };
}

/**
 * Resolve + apply ONE auto decision for a frozen pipeline.
 *
 * @returns `null` only when this process is not the auto runner (the caller then
 *   continues with the unchanged human/provider chain), or when the job's own
 *   sidecar says the job already finished (`state.status !== "running"` — its
 *   finalize path owns any further freeze). An ACTIVE runner whose job cannot be
 *   re-read (deleted/corrupted job file, vanished or foreign lock record) is NOT
 *   a `null`: falling through to the provider chain would let a provider rule
 *   auto-resume a freeze the job policy should have stopped, so that case stops
 *   the job (`stopReason: "job_drift"` — the settle seam's verdict) and reports.
 */
export async function runFreezeAutopilot(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  config: PipelineConfig,
  reason: string,
  opts?: RequestDecisionOpts,
): Promise<EnsureDecisionMenuResult | null> {
  const active = readActiveJobContext(config.projectRoot);
  if (!active) {
    // `isAutoJobActive()` is the caller's gate (an in-process fact); the null
    // above therefore means the DISK record disagrees with it. Phase 3 §6 /
    // Phase 5 §4: the auto authority must still terminate the job — the same
    // fault is `job_drift` on the settle seam (`settle-seam.ts`).
    if (!isAutoJobActive()) return null;
    const jobId = getActiveJobId() ?? "unknown";
    reportAutoFailure(
      ctx,
      "freeze_job_unreadable",
      `Auto job "${jobId}": job file is unreadable or invalid — stopping the job (job_drift).`,
      { jobId, reason },
    );
    // Dynamic import breaks the load-time cycle flow-state → freeze-autopilot →
    // finalize → cleanup → flow-state (same reason as the "stop-and-report" leg).
    const { finalizeJob } = await import("./finalize");
    const finalized = await finalizeJob(
      ctx as unknown as Parameters<typeof finalizeJob>[0],
      config,
      { stopReason: "job_drift" },
    );
    await auditAutoDecision(config, {
      gate: "freeze",
      jobId,
      reason,
      action: "stop-and-report",
      basis: "job_drift",
    });
    if (finalized.skipped) {
      // The sidecar itself is unreadable, so nothing could be released. The
      // freeze is still NOT handed to the provider chain — the caller receives
      // a decided result and the operator sees the unrecoverable record.
      auditAutoDiagnostic(
        "freeze_job_drift_unfinalized",
        "Auto-job drift could not be finalized (sidecar unreadable) — the freeze is not delegated to providers.",
        { jobId, reason },
        "error",
      );
      return decidedResult(
        `Auto job ${jobId}: freeze "${reason}" not delegated — the job record is unreadable or invalid (job_drift).`,
      );
    }
    return decidedResult(`Auto job ${jobId} stopped: job file is unreadable or invalid (job_drift).`);
  }
  const { state, job, jobId } = active;
  // A finished/stopped job never answers freezes (its finalize path owns them).
  if (state.status !== "running") return null;

  const resolved = resolveFreezeAction({ meta, job, state, reason });

  // Single write point for BOTH counters (plan Phase 3 §6): totalFreezes always,
  // autoResumes only when a resume is actually granted.
  state.counters.totalFreezes = (state.counters.totalFreezes ?? 0) + 1;
  if (resolved.action === "resume") {
    state.counters.autoResumes = (state.counters.autoResumes ?? 0) + 1;
  }
  state.updatedAt = Date.now();
  try {
    await writeJobState(config.projectRoot, state);
  } catch (err) {
    // Fail-closed for the counter, fail-open for the flow: the decision still
    // applies, but the operator sees a persisted-state failure.
    auditAutoDiagnostic("freeze_counters_persist_failed", "Auto-job freeze counters could not be persisted.", {
      error: String(err),
    }, "error");
  }

  await auditAutoDecision(config, {
    gate: "freeze",
    jobId,
    reason,
    action: resolved.action,
    basis: resolved.basis,
  });

  if (resolved.action === "resume" || resolved.action === "abort") {
    const outcome = await executeDecision(
      ctx,
      meta,
      resolved.action,
      config,
      {
        // 219 invariant: auto decisions are NEVER recorded as human decisions.
        decisionSource: "auto",
        source: "auto_pipeline",
        ...(opts?.onStageChanged ? { onStageChanged: opts.onStageChanged } : {}),
      },
    );
    return decidedResult(
      outcome.success
        ? `Auto job ${jobId}: freeze "${reason}" resolved with "${resolved.action}".`
        : `Auto job ${jobId}: freeze "${reason}" decision "${resolved.action}" was not applied: ${outcome.message}`,
    );
  }

  // "stop-and-report": no provider fallback, no menu. The shared failure
  // transaction owns the receipt + release + stop (Phase 5 §6.2 ②).
  // Dynamic import breaks the load-time cycle flow-state → freeze-autopilot →
  // finalize → cleanup → flow-state.
  const { handleDocFailure } = await import("./finalize");
  await handleDocFailure(ctx as never, config, state, job, {
    outcome: "failed",
    reason: "freeze_unresolvable",
    verdict: { kind: "hard", stopReason: "freeze_unresolvable" },
  });
  await safeWriteAuditLog("pipeline_auto_stop", {
    jobId,
    stopReason: "freeze_unresolvable",
    reason,
  }, "warn");
  return decidedResult(`Auto job ${jobId} stopped: freeze "${reason}" is unresolvable.`);
}

/**
 * TRUE when the given freeze reason is unresolvable under the job policy.
 * Used by the settle-side hard-stop predicate (Phase 5 §3, item 4) so both
 * seams share ONE precedence implementation.
 */
export function isUnresolvableFreeze(input: {
  meta: SessionMeta;
  job: AutoJobConfig;
  state: AutoJobState;
  reason: string;
}): boolean {
  return resolveFreezeAction(input).action === "stop-and-report";
}
