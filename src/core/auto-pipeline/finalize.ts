/**
 * @module auto-pipeline/finalize
 * 219 Phase 5: the ONLY completion/failure transaction for an auto job.
 *
 * Facts (219_Feat.md 6.3 / 6.5 decisions 8/9/14):
 * - `finalizeCurrentDoc` writes the sidecar FIRST, then releases resources,
 *   audits and notifies. It NEVER rolls back the overlay and NEVER releases the
 *   process lock — the chained continuation needs both.
 * - `finalizeJob` is the only place that rolls the overlay back and releases
 *   the lock.
 * - Idempotence has two layers: an in-process key set (fast, per turn) and the
 *   sidecar `finalizeKey` lookup (authoritative, decoupled from `docIndex`).
 * - `handleDocFailure` owns the three-step degradation: hard stop → onFailure
 *   stop → onFailure continue (new session → same session → session_fail).
 */

import type { PipelineConfig, SessionMeta } from "../../types";
import type { RuntimeCtx } from "../runtime-ctx";
import { safeWriteAuditLog } from "../../utils/auditLog";
import type { AutoJobConfig } from "./job-schema";
import type { AutoJobState, AutoJobStopReason } from "./job-state";
import {
  deriveLoopsSinceLastSeen,
  hasFinalizeKey,
  nextPendingDoc,
  readJobState,
  writeJobState,
} from "./job-state";
import {
  getActiveJobId,
  getActiveJobToken,
  readActiveJobContext,
  readStateForActiveLock,
  releaseJobLock,
  restoreOverlay,
} from "./config-overlay";
import { releaseSessionResources } from "./cleanup";
import type { HardStopVerdict, LoopBrakeVerdict } from "./stop-policy";

export interface FinalizeResult {
  skipped: boolean;
  summary?: string;
}

/** Minimal ctx surface the finalize transaction needs. */
export interface FinalizeCtx {
  session: {
    getMeta: () => SessionMeta | undefined;
    updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
  };
  ui?: { notify?: (msg: string, type?: "info" | "error" | "warning") => void };
  pi?: { sendUserMessage?: (msg: string, opts?: Record<string, unknown>) => void };
  _ctx?: unknown;
  newSession?: (opts: { withSession: (replaced: unknown) => Promise<void> }) => Promise<unknown>;
}

/** Layer 1 idempotence (in-process). */
const finalizedKeys = new Set<string>();

/** Test-only reset of the in-process idempotence set. */
export function __resetFinalizeStateForTests(): void {
  finalizedKeys.clear();
}

function verdictStopReason(
  verdict: HardStopVerdict | LoopBrakeVerdict | undefined,
): AutoJobStopReason | undefined {
  if (!verdict) return undefined;
  if (verdict.kind === "hard") return verdict.stopReason;
  if (verdict.kind === "soft") return verdict.stopReason;
  return undefined;
}

/**
 * 6.1-③: derive the cross-doc counters from the CURRENT meta. Called from the
 * settle seam (the single write point) — `recordStageVisit` stays pure.
 */
export function syncAutoCountersFromMeta(input: {
  state: AutoJobState;
  meta: SessionMeta;
  docIndex: number;
}): void {
  const { state, meta, docIndex } = input;
  const loops = meta.loopCycleCount ?? 0;
  state.counters.totalLoops += deriveLoopsSinceLastSeen(state, docIndex, loops);
  const doc = state.docs[docIndex];
  if (doc) doc.lastLoopCycleCount = loops;
  state.counters.consecutiveVerifyFailures = meta.verifyFailures?.length ?? 0;
}

/**
 * Doc-level finalize: sidecar → release → audit → notify.
 * ★ Never rolls back the overlay, never releases the lock.
 */
export async function finalizeCurrentDoc(
  ctx: FinalizeCtx,
  config: PipelineConfig,
  opts: {
    outcome: "completed" | "failed";
    verdict?: HardStopVerdict | LoopBrakeVerdict;
    reason?: string;
    /**
     * Explicit doc index. Used by the runner when a doc fails BEFORE it could
     * start: `docIndex` must not advance (M3), yet the receipt belongs to the
     * attempted doc. Defaults to the sidecar's current `docIndex`.
     */
    docIndex?: number;
  },
): Promise<FinalizeResult> {
  const active = readActiveJobContext(config.projectRoot);
  if (!active) return { skipped: true };
  const { state, jobId } = active;
  const projectRoot = config.projectRoot;
  const targetIndex = opts.docIndex ?? state.docIndex;
  const key = `${jobId}:${targetIndex}:${opts.outcome}`;

  // Layer 1: same-process repeat (compactIfTerminal is shared by several paths).
  if (finalizedKeys.has(key)) return { skipped: true };
  // Layer 2: disk truth, decoupled from docIndex (M3).
  const disk = readJobState(projectRoot, jobId);
  if (disk && hasFinalizeKey(disk, key)) return { skipped: true };

  const now = Date.now();
  const doc = state.docs[targetIndex];
  const stopReason = verdictStopReason(opts.verdict);
  if (doc) {
    doc.status = opts.outcome === "completed" ? "completed" : "failed";
    if (opts.outcome === "failed") {
      doc.failReason = opts.reason ?? stopReason ?? "unknown";
    }
    doc.finalizeKey = key;
    doc.updatedAt = now;
  }
  const meta = (ctx.session.getMeta() as SessionMeta | undefined);
  if (meta) syncAutoCountersFromMeta({ state, meta, docIndex: targetIndex });
  state.lastSettleAt = now;
  state.updatedAt = now;

  // ② sidecar BEFORE release (a crash keeps the receipt).
  await writeJobState(projectRoot, state);
  finalizedKeys.add(key);

  // ③ release ④ audit ⑤ notify
  const release = await releaseSessionResources(ctx as unknown as RuntimeCtx, config, {
    reason: opts.outcome === "completed" ? "auto_completed" : "auto_failed",
  });
  await safeWriteAuditLog("pipeline_auto_cleanup", {
    jobId,
    doc: doc?.doc ?? "",
    outcome: opts.outcome,
    stopReason: stopReason ?? "",
    criticalFailed: String(release.criticalFailed),
    failedSteps: release.failedSteps.join(","),
  });

  const docNo = targetIndex + 1;
  const message =
    opts.outcome === "completed"
      ? `Auto job "${jobId}": doc ${docNo}/${state.jobTotalDocs} completed.`
      : `Auto job "${jobId}": doc ${docNo}/${state.jobTotalDocs} failed (${doc?.failReason ?? "unknown"}).`;
  ctx.ui?.notify?.(message);
  return { skipped: false, summary: message };
}

/** Terminal status for a stop reason (`job_completed` keeps the success one). */
function terminalStatus(stopReason: AutoJobStopReason): AutoJobState["status"] {
  if (stopReason === "job_completed") return "completed";
  if (stopReason === "user_cancelled" || stopReason === "job_drift") return "stopped";
  return "failed";
}

/**
 * Job-level finalize: sidecar → release → audit → ★rollback + unlock → report.
 */
export async function finalizeJob(
  ctx: FinalizeCtx,
  config: PipelineConfig,
  opts: { stopReason: AutoJobStopReason },
): Promise<FinalizeResult> {
  const projectRoot = config.projectRoot;
  const jobId = getActiveJobId();
  const state = readStateForActiveLock(projectRoot) ?? (jobId ? readJobState(projectRoot, jobId) : null);
  if (!state) return { skipped: true };
  if (state.status !== "running") {
    ctx.ui?.notify?.(`Auto job "${state.jobId}" is already finished (${state.status}).`);
    return { skipped: true };
  }

  state.status = terminalStatus(opts.stopReason);
  state.stopReason = opts.stopReason;
  state.updatedAt = Date.now();
  await writeJobState(projectRoot, state);

  const release = await releaseSessionResources(ctx as unknown as RuntimeCtx, config, {
    reason: state.status === "completed" ? "auto_completed" : "auto_stopped",
  });
  await safeWriteAuditLog("pipeline_auto_cleanup", {
    jobId: state.jobId,
    outcome: state.status,
    stopReason: opts.stopReason,
    criticalFailed: String(release.criticalFailed),
    failedSteps: release.failedSteps.join(","),
  });
  await safeWriteAuditLog("pipeline_auto_stop", { jobId: state.jobId, stopReason: opts.stopReason }, "warn");

  // ⑤ rollback (ONLY here and the gated session_shutdown path)
  if (state.overlaySnapshot) {
    restoreOverlay(config, state.overlaySnapshot);
    await safeWriteAuditLog("pipeline_auto_overlay_restore", { jobId: state.jobId });
  }
  // ⑥ release the process lock
  const token = getActiveJobToken();
  if (token) releaseJobLock({ projectRoot, token });

  for (const key of [...finalizedKeys]) {
    if (key.startsWith(`${state.jobId}:`)) finalizedKeys.delete(key);
  }

  const summary = buildJobSummary(state);
  ctx.ui?.notify?.(summary, state.status === "completed" ? undefined : "error");
  return { skipped: false, summary };
}

/**
 * Failure scheduling — the single implementation shared by the runner, the
 * settle seam and the freeze autopilot (M1 round 2: §6.1 and §6.2 agree).
 */
export async function handleDocFailure(
  ctx: FinalizeCtx,
  config: PipelineConfig,
  state: AutoJobState,
  job: AutoJobConfig,
  opts: {
    outcome: "failed";
    reason?: string;
    verdict?: LoopBrakeVerdict | HardStopVerdict;
    docIndex?: number;
  },
): Promise<FinalizeResult> {
  // ① doc transaction (idempotent — a repeated settle is a no-op)
  const finalized = await finalizeCurrentDoc(ctx, config, {
    outcome: "failed",
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.verdict ? { verdict: opts.verdict } : {}),
    ...(opts.docIndex !== undefined ? { docIndex: opts.docIndex } : {}),
  });

  // ② hard stop ignores onFailure
  if (opts.verdict?.kind === "hard") {
    return finalizeJob(ctx, config, { stopReason: opts.verdict.stopReason });
  }
  if (finalized.skipped) {
    // Already finalized by another path: keep the job terminal in sync.
    return { skipped: true, summary: finalized.summary };
  }

  const fresh = readJobState(config.projectRoot, state.jobId) ?? state;

  // ③ onFailure: stop
  if (job.docs.onFailure !== "continue") {
    return finalizeJob(ctx, config, {
      stopReason: verdictStopReason(opts.verdict) ?? "budget_exhausted",
    });
  }

  // ④ onFailure: continue
  const next = nextPendingDoc(fresh);
  if (!next) {
    return finalizeJob(ctx, config, { stopReason: "job_completed" });
  }

  if (job.chain.newSession && ctx.newSession) {
    const token = getActiveJobToken() ?? "";
    try {
      await ctx.newSession({
        withSession: async (replaced) => {
          const send = (replaced as { sendUserMessage?: (msg: string, opts?: Record<string, unknown>) => void })
            .sendUserMessage;
          send?.(`/pipeline-auto --next --job ${state.jobId} --token ${token}`, {
            expandPromptTemplates: true,
          });
        },
      });
      await safeWriteAuditLog("pipeline_auto_chain", { jobId: state.jobId, result: "new_session_after_failure" });
      return { skipped: false, summary: `Auto job "${state.jobId}": next doc continued in a new session.` };
    } catch (err) {
      console.error(`[auto-pipeline] handleDocFailure: newSession failed — same-session fallback: ${String(err)}`);
      await safeWriteAuditLog("pipeline_auto_chain", { jobId: state.jobId, result: "new_session_failed" }, "warn");
    }
  }

  // Same-session serial continuation (overlay stays applied).
  const started = await startNextDocSameSession(ctx, config, state.jobId);
  if (started) {
    await safeWriteAuditLog("pipeline_auto_chain", { jobId: state.jobId, result: "same_session" });
    return { skipped: false, summary: `Auto job "${state.jobId}": next doc started in the same session.` };
  }
  return finalizeJob(ctx, config, { stopReason: "session_fail" });
}

/**
 * Start the job's next pending doc in THIS session (used by both the success and
 * failure chains). Returns false when the doc could not be started.
 *
 * The runner module is imported lazily: `commands/*` imports `core/*`, so a
 * static core → commands edge would close a load cycle.
 */
async function startNextDocSameSession(
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
      // The chain side owns the terminal transaction (`session_fail`).
      deferFailure: true,
    });
    return result.success;
  } catch (err) {
    console.error(`[auto-pipeline] startNextDocSameSession failed for ${jobId}: ${String(err)}`);
    return false;
  }
}

/**
 * Success-path continuation (6.1): a completed doc either chains to the next
 * one (new session preferred, same session as the documented fallback) or ends
 * the job with `job_completed`.
 */
export async function continueJobAfterCompleted(
  ctx: FinalizeCtx,
  config: PipelineConfig,
  job: AutoJobConfig,
): Promise<FinalizeResult> {
  const jobId = getActiveJobId();
  if (!jobId) return { skipped: true };
  const state = readStateForActiveLock(config.projectRoot) ?? readJobState(config.projectRoot, jobId);
  if (!state) return { skipped: true };

  const next = nextPendingDoc(state);
  if (!next) {
    return finalizeJob(ctx, config, { stopReason: "job_completed" });
  }

  if (job.chain.newSession && ctx.newSession) {
    const token = getActiveJobToken() ?? "";
    try {
      await ctx.newSession({
        withSession: async (replaced) => {
          const send = (replaced as { sendUserMessage?: (msg: string, opts?: Record<string, unknown>) => void })
            .sendUserMessage;
          send?.(`/pipeline-auto --next --job ${jobId} --token ${token}`, { expandPromptTemplates: true });
        },
      });
      await safeWriteAuditLog("pipeline_auto_chain", { jobId, result: "new_session" });
      return { skipped: false, summary: `Auto job "${jobId}": next doc continued in a new session.` };
    } catch (err) {
      console.error(`[auto-pipeline] continueJobAfterCompleted: newSession failed — same-session fallback: ${String(err)}`);
      await safeWriteAuditLog("pipeline_auto_chain", { jobId, result: "cancelled" }, "warn");
    }
  }

  if (await startNextDocSameSession(ctx, config, jobId)) {
    await safeWriteAuditLog("pipeline_auto_chain", { jobId, result: "same_session" });
    return { skipped: false, summary: `Auto job "${jobId}": next doc started in the same session.` };
  }
  // Same-session serial also failed → the only honest terminal state.
  await safeWriteAuditLog("pipeline_auto_chain", { jobId, result: "stopped" }, "warn");
  return finalizeJob(ctx, config, { stopReason: "session_fail" });
}

/** Human-readable job summary (status bar / notify / final report). */
export function buildJobSummary(state: AutoJobState): string {
  const completed = state.docs.filter((d) => d.status === "completed").length;
  const skipped = state.docs.filter((d) => d.status === "skipped").length;
  const failed = state.docs.filter((d) => d.status === "failed").length;
  const pending = state.docs.filter((d) => d.status === "pending" || d.status === "running").length;
  const status = state.status === "running" ? "stopped" : state.status;
  const reason = state.stopReason ? ` (${state.stopReason})` : "";
  return (
    `Auto job "${state.jobId}" ${status}${reason}: ` +
    `${completed} completed, ${skipped} skipped, ${failed} failed, ${pending} pending ` +
    `of ${state.jobTotalDocs}.`
  );
}
