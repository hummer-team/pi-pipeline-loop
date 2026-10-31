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
 * - `decisionPolicy` is JOB-PRIVATE: nothing from this module is ever written
 *   into `config.decisionPolicy`.
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
import { readActiveJobContext } from "./config-overlay";
import { auditAutoDecision } from "./auto-audit";

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
  const byReason = job.decisionPolicy?.byReason ?? {};
  const explicit = byReason[reason];
  const action: FreezeAction = explicit ?? job.decisionPolicy?.onFreeze ?? "stop-and-report";
  const basis = explicit ? "by_reason" : "on_freeze";
  if (action !== "resume") return { action, basis };
  const maxAutoResumes = job.decisionPolicy?.maxAutoResumes ?? 0;
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
 * @returns `null` only when this process is not an active auto runner (the
 *   caller then continues with the unchanged human/provider chain).
 */
export async function runFreezeAutopilot(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  config: PipelineConfig,
  reason: string,
  opts?: RequestDecisionOpts,
): Promise<EnsureDecisionMenuResult | null> {
  const active = readActiveJobContext(config.projectRoot);
  if (!active) return null;
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
    console.error(`[auto-pipeline] runFreezeAutopilot: failed persisting counters: ${String(err)}`);
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

  // "stop-and-report": no provider fallback, no menu. Phase 5 replaces this
  // tail with `handleDocFailure` (which owns the full finalize transaction).
  state.stopReason = "freeze_unresolvable";
  state.status = "stopped";
  state.updatedAt = Date.now();
  try {
    await writeJobState(config.projectRoot, state);
  } catch (err) {
    console.error(`[auto-pipeline] runFreezeAutopilot: failed persisting stop state: ${String(err)}`);
  }
  await safeWriteAuditLog("pipeline_auto_stop", {
    jobId,
    stopReason: "freeze_unresolvable",
    reason,
  }, "warn");
  ctx.ui?.notify?.(
    `Auto job "${jobId}" stopped: freeze "${reason}" is unresolvable (no auto action matched).`,
  );
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
