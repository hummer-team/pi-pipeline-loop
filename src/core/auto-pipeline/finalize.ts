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
 * - The "new session" hop goes through {@link rotateSessionForChain}: the
 *   command path calls `newSession()` and HONOURS `{ cancelled }`; the hook
 *   path (no replacement API) dispatches the internal `--next` command, whose
 *   host performs the rotation. `chain.onSessionFail: "stop"` forbids the
 *   same-session fallback.
 * - The transaction reads ONLY the sidecar: a broken/unreadable job file must
 *   never skip the receipt, the release or the lock release.
 */

import type { PipelineConfig, SessionMeta } from "../../types";
import { docsDirsOf } from "../../docs-paths";
import type { RuntimeCtx } from "../runtime-ctx";
import { safeWriteAuditLog } from "../../utils/auditLog";
import type { AutoJobConfig } from "./job-schema";
import type { AutoJobState, AutoJobStopReason } from "./job-state";
import {
  clearPendingContinuation,
  deriveLoopsSinceLastSeen,
  hasFinalizeKey,
  markPendingContinuation,
  nextPendingDoc,
  readJobState,
  writeJobState,
} from "./job-state";
import {
  getActiveJobId,
  getActiveJobToken,
  isAutoJobActive,
  readActiveJobContext,
  readStateForActiveLock,
  releaseJobLock,
  restoreOverlay,
} from "./config-overlay";
import { releaseSessionResources } from "./cleanup";
import type { HardStopVerdict, LoopBrakeVerdict } from "./stop-policy";
import { auditAutoDiagnostic, notifyAuto } from "./diagnostics";

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
 *
 * `consecutiveVerifyFailures` counts FAILED ATTEMPTS, never rules: the old
 * `meta.verifyFailures.length` derivation turned "one attempt violated three
 * rules" into three consecutive failures and hard-stopped docs that still had
 * retries (Phase 5 "完成机会"). A failed attempt (meta.verifyAttempts moved
 * since the last look, failures present) adds exactly one; a pass / attempt
 * reset clears the streak.
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

  const attempts = meta.verifyAttempts ?? 0;
  const failedAttempt = (meta.verifyFailures?.length ?? 0) > 0;
  const lastAttempts = doc?.lastVerifyAttempts ?? 0;
  if (attempts !== lastAttempts) {
    state.counters.consecutiveVerifyFailures = failedAttempt
      ? state.counters.consecutiveVerifyFailures + 1
      : 0;
    if (doc) doc.lastVerifyAttempts = attempts;
  } else if (!failedAttempt) {
    // Same attempt window but the failures are gone → the attempt passed.
    state.counters.consecutiveVerifyFailures = 0;
  }
}

/**
 * The sidecar behind the active lock, independent of the JOB FILE.
 *
 * Review 219 issue 9: a finalize must never depend on the job YAML being
 * readable/parseable — `readActiveJobContext` re-reads and re-validates it, and
 * a user edit would silently skip the receipt, the release and the lock
 * release (a doc stuck in `running` with no audit). The sidecar is the single
 * source of truth (Phase 1 §2), so the transaction reads only that.
 */
function resolveSidecarState(projectRoot: string): AutoJobState | null {
  const state = readStateForActiveLock(projectRoot);
  if (state) return state;
  const jobId = getActiveJobId();
  return jobId ? readJobState(projectRoot, jobId) : null;
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
  const active = resolveSidecarState(config.projectRoot);
  if (!active) return { skipped: true };
  const state = active;
  const { jobId } = state;
  const projectRoot = config.projectRoot;
  const targetIndex = opts.docIndex ?? state.docIndex;
  const key = `${jobId}:${targetIndex}:${opts.outcome}`;

  // Layer 1: same-process repeat (compactIfTerminal is shared by several paths).
  if (finalizedKeys.has(key)) return { skipped: true };
  // Layer 2: disk truth, decoupled from docIndex (M3).
  const disk = readJobState(projectRoot, jobId);
  if (disk && hasFinalizeKey(disk, key)) return { skipped: true };
  // Layer 2b (review round 2 issue 1): a doc has ONE terminal outcome. A soft
  // stop writes `:failed`; if the same doc later reaches `completed` (the loop
  // brake only refuses to ADVANCE, the agent may still finish the file), the
  // sidecar must not flip to `failed → completed` — that would spend the job
  // budget twice and contradict the receipt/report the human already saw.
  const oppositeKey = `${jobId}:${targetIndex}:${opts.outcome === "completed" ? "failed" : "completed"}`;
  if (finalizedKeys.has(oppositeKey) || (disk && hasFinalizeKey(disk, oppositeKey))) {
    return { skipped: true };
  }

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
  // A terminal job has no outstanding hop left (review round 2 issue 3).
  clearPendingContinuation(state);
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
 * How a "continue in a new session" attempt ended (Phase 5 §6.1).
 *
 * `channel` records WHICH host capability performed the hop so the audit trail
 * can tell a real `newSession()` apart from a dispatched internal command:
 * - `new_session`: the ctx carries the command-only replacement API (the
 *   `--next` command path and test hosts);
 * - `dispatch`: the hook ctx has no replacement API, so the internal
 *   `/pipeline-auto --next` command is dispatched and performs the rotation
 *   itself (`ExtensionAPI.sendUserMessage`, plan §6.1). The dispatched string
 *   carries NO job id and NO token (221 Phase 4) — both travel via `lock.json`.
 * - `none`: the ctx supports neither; no hop is attempted.
 */
export interface ChainRotationResult {
  rotated: boolean;
  channel: "new_session" | "dispatch" | "none";
  /** Present when `rotated` is false. */
  reason?: "cancelled" | "failed" | "no_channel";
}

/**
 * The internal continuation command.
 *
 * 221 Phase 4: ONE minimal command — no `--job` and no `--token`. The job id
 * and the lock token only travel through `lock.json`; the new session finds the
 * pending continuation through `session_start` and starts the doc itself.
 */
function buildChainCommand(): string {
  return "/pipeline-auto --next";
}

/**
 * Try to hand the next doc to a NEW session (Phase 5 §6.1).
 *
 * Facts:
 * - The `agent_settled` hook ctx is a `RuntimeCtx`/`ExtensionContext`, which has
 *   NO `newSession` (only `ExtensionCommandContext` does). Treating the missing
 *   API as "host does not support chaining" made `chain.newSession: true`
 *   silently degrade to same-session serial on every production turn — the
 *   dispatched-command branch is what actually reaches a new session.
 * - `newSession()` returns `{ cancelled }`. Ignoring it left the job neither
 *   chained nor finalised (sidecar stuck on `running`, process lock held); a
 *   cancelled hop is a DOCUMENTED fallback, never a terminal state.
 * - Review round 2 (issue 3): the DISPATCH branch has no callback at all. The
 *   hop is recorded in the sidecar (`pendingContinuation`) BEFORE the command is
 *   sent, cleared when the next doc really starts, and reconciled by
 *   {@link reconcilePendingContinuation} once it is provably overdue. The audit
 *   says `dispatched` (not `new_session`): nothing has rotated yet.
 */
export async function rotateSessionForChain(
  ctx: FinalizeCtx,
  jobId: string,
  opts: { projectRoot: string; state?: AutoJobState } = { projectRoot: "" },
): Promise<ChainRotationResult> {
  const command = buildChainCommand();
  const canRotate = typeof ctx.newSession === "function";
  const canDispatch = typeof ctx.pi?.sendUserMessage === "function";

  // 221 Phase 4: record the outstanding hop BEFORE any rotation. The new
  // session starts the pending doc on `session_start`; nothing is injected into
  // it, so the sidecar is the ONLY hand-over channel. A failed write therefore
  // FORBIDS the rotation (see the caller below): rotating without the record
  // strands the job `running` with no owner.
  const persistPending = async (channel: "dispatch" | "session_start"): Promise<boolean> => {
    if (!opts.state || !opts.projectRoot) return true;
    markPendingContinuation(opts.state, channel, Date.now());
    try {
      await writeJobState(opts.projectRoot, opts.state);
      return true;
    } catch (err) {
      // Undo the in-memory mark so a later write cannot publish a record whose
      // hop never happened.
      clearPendingContinuation(opts.state);
      auditAutoDiagnostic("chain_dispatch_persist_failed", `Auto job "${jobId}": continuation record could not be written.`, {
        jobId,
        error: String(err),
      }, "error");
      return false;
    }
  };
  const clearPending = async (): Promise<void> => {
    if (!opts.state || !opts.projectRoot) return;
    if (!clearPendingContinuation(opts.state)) return;
    try {
      await writeJobState(opts.projectRoot, opts.state);
    } catch {
      // The rotation already failed; a stale record is reconciled later.
    }
    await safeWriteAuditLog(
      "pipeline_auto_chain",
      { jobId, result: "pending_cleared_on_cancel" },
      "warn",
    );
  };

  const persisted = await persistPending(canRotate ? "session_start" : "dispatch");
  if (!persisted) {
    // No hand-over channel → do NOT rotate; the caller falls back to the
    // documented same-session serial (audit keeps `chain_dispatch_persist_failed`).
    notifyAuto(
      ctx,
      `Auto job "${jobId}": the continuation record could not be written — continuing in this session.`,
      "warning",
    );
    return {
      rotated: false,
      channel: canRotate ? "new_session" : canDispatch ? "dispatch" : "none",
      reason: "failed",
    };
  }

  // ① Command-capable host: rotate directly. `withSession` runs in the NEW
  // session — it only writes the audit; the fresh `session_start` starts the
  // doc there (221: no second injected command).
  if (canRotate) {
    try {
      const result = (await ctx.newSession!({
        withSession: async () => {
          await safeWriteAuditLog("pipeline_auto_chain", {
            jobId,
            result: "new_session",
            channel: "session_start",
          });
        },
      })) as { cancelled?: boolean } | undefined;
      if (result?.cancelled === true) {
        await clearPending();
        return { rotated: false, channel: "new_session", reason: "cancelled" };
      }
      return { rotated: true, channel: "new_session" };
    } catch (err) {
      await clearPending();
      auditAutoDiagnostic("chain_new_session_failed", `Auto job "${jobId}": session rotation failed.`, {
        jobId,
        error: String(err),
      }, "error");
      notifyAuto(ctx, `Auto job "${jobId}": could not open a new session — continuing in this session.`, "warning");
      return { rotated: false, channel: "new_session", reason: "failed" };
    }
  }

  // ② Hook host: no replacement API — dispatch the internal command; the
  // command handler owns `ctx.newSession` (Phase 4 §4 ctx widening).
  if (canDispatch) {
    try {
      ctx.pi!.sendUserMessage!(command, { expandPromptTemplates: true });
      return { rotated: true, channel: "dispatch" };
    } catch (err) {
      await clearPending();
      auditAutoDiagnostic("chain_dispatch_failed", `Auto job "${jobId}": continuation command could not be dispatched.`, {
        jobId,
        error: String(err),
      }, "error");
      notifyAuto(ctx, `Auto job "${jobId}": could not dispatch the continuation — continuing in this session.`, "warning");
      return { rotated: false, channel: "dispatch", reason: "failed" };
    }
  }

  // No channel at all: the record must not survive a hop that never existed.
  await clearPending();
  return { rotated: false, channel: "none", reason: "no_channel" };
}

/**
 * §6.2: with `chain.onSessionFail: "stop"` the documented same-session fallback
 * is FORBIDDEN — a refused session hop ends the job instead of silently
 * serialising it (the user-visible job semantics must match the selection).
 */
function onSessionFailStopsJob(job: AutoJobConfig): boolean {
  return job.chain.newSession && job.chain.onSessionFail === "stop";
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
    // 226 Phase 3: the honest label — this is a DOC failure with `stop`, not a
    // loop budget; the real cause stays on the doc receipt (`failReason`).
    return finalizeJob(ctx, config, {
      stopReason: verdictStopReason(opts.verdict) ?? "doc_failed",
    });
  }

  // ④ onFailure: continue
  const next = nextPendingDoc(fresh);
  if (!next) {
    return finalizeJob(ctx, config, { stopReason: "job_completed" });
  }

  if (job.chain.newSession) {
    const rotation = await rotateSessionForChain(ctx, state.jobId, {
      projectRoot: config.projectRoot,
      state: fresh,
    });
    if (rotation.rotated) {
      await safeWriteAuditLog("pipeline_auto_chain", {
        jobId: state.jobId,
        result: rotation.channel === "dispatch" ? "dispatched" : "new_session_after_failure",
        channel: rotation.channel,
      });
      return { skipped: false, summary: `Auto job "${state.jobId}": next doc continued in a new session.` };
    }
    await safeWriteAuditLog(
      "pipeline_auto_chain",
      {
        jobId: state.jobId,
        result: "cancelled",
        channel: rotation.channel,
        reason: rotation.reason ?? "",
      },
      "warn",
    );
    if (onSessionFailStopsJob(job)) {
      await safeWriteAuditLog("pipeline_auto_chain", { jobId: state.jobId, result: "stopped" }, "warn");
      return finalizeJob(ctx, config, { stopReason: "session_fail" });
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
 * How long an outstanding continuation hop may stay unanswered before the
 * owner treats the dispatch as LOST (review round 2 issue 3). The host runs the
 * dispatched command in the next turn, so a healthy hop resolves in seconds;
 * the window only has to be long enough not to fight a slow host.
 */
export const PENDING_CONTINUATION_TIMEOUT_MS = 120_000;

/**
 * Reconcile a dispatched continuation that never started a document
 * (review round 2, issue 3).
 *
 * Why it is needed: `pi.sendUserMessage` has NO callback. When the host drops
 * the message (slash command not expanded, `--next` rejected by a busy/stale
 * lock, unparseable job file, `startNewPipeline` failure), the previous doc is
 * already `completed`, the sidecar stays `running`, the process lock stays held
 * and nothing ever reports it — the job hangs forever because later settles are
 * skipped as "already finalized".
 *
 * Contract:
 * - runs only in the process that holds the lock (identity, not a clock);
 * - a fresh record is left alone (the hop may still be in flight);
 * - an OVERDUE record falls back to the documented same-session serial and,
 *   when even that fails, to the honest terminal `session_fail`.
 *
 * @returns TRUE when the reconcile owned this turn (the caller must stop).
 */
export async function reconcilePendingContinuation(
  ctx: FinalizeCtx,
  config: PipelineConfig,
): Promise<boolean> {
  if (!isAutoJobActive()) return false;
  const active = readActiveJobContext(config.projectRoot, docsDirsOf(config).jobsDir);
  if (!active) return false;
  const { state } = active;

  if (!state.pendingContinuation) return false;
  if (state.status !== "running") {
    // Terminal jobs never keep a hop record (defensive: a crash between the two
    // writes must not resurrect the record).
    if (clearPendingContinuation(state)) {
      try {
        await writeJobState(config.projectRoot, state);
      } catch (err) {
        auditAutoDiagnostic("continuation_clear_failed", "Auto-job stale continuation record could not be cleared.", {
          jobId: state.jobId,
          error: String(err),
        }, "error");
      }
    }
    return false;
  }

  const pending = state.pendingContinuation;
  const waitedMs = Date.now() - pending.at;
  if (waitedMs < PENDING_CONTINUATION_TIMEOUT_MS) return false;

  await safeWriteAuditLog(
    "pipeline_auto_chain",
    {
      jobId: state.jobId,
      result: "dispatch_timeout",
      channel: pending.channel,
      waitedMs: String(waitedMs),
      docIndex: String(pending.docIndex),
    },
    "warn",
  );
  clearPendingContinuation(state);
  try {
    await writeJobState(config.projectRoot, state);
  } catch (err) {
    auditAutoDiagnostic("continuation_clear_failed", "Auto-job continuation record could not be cleared.", {
      jobId: state.jobId,
      error: String(err),
    }, "error");
  }

  // The documented fallback: serial continuation in the session that still owns
  // the pipeline. Only an honest terminal state may follow a second failure.
  if (await startNextDocSameSession(ctx, config, state.jobId)) {
    await safeWriteAuditLog("pipeline_auto_chain", { jobId: state.jobId, result: "same_session" });
    return true;
  }
  await safeWriteAuditLog("pipeline_auto_chain", { jobId: state.jobId, result: "stopped" }, "warn");
  await finalizeJob(ctx, config, { stopReason: "session_fail" });
  return true;
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
    auditAutoDiagnostic("same_session_start_failed", `Auto job "${jobId}": next doc could not start in this session.`, {
      jobId,
      error: String(err),
    }, "error");
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
  const state = resolveSidecarState(config.projectRoot);
  if (!state) return { skipped: true };

  const next = nextPendingDoc(state);
  if (!next) {
    return finalizeJob(ctx, config, { stopReason: "job_completed" });
  }

  if (job.chain.newSession) {
    const rotation = await rotateSessionForChain(ctx, jobId, { projectRoot: config.projectRoot, state });
    if (rotation.rotated) {
      await safeWriteAuditLog("pipeline_auto_chain", {
        jobId,
        result: rotation.channel === "dispatch" ? "dispatched" : "new_session",
        channel: rotation.channel,
      });
      return { skipped: false, summary: `Auto job "${jobId}": next doc continued in a new session.` };
    }
    await safeWriteAuditLog(
      "pipeline_auto_chain",
      { jobId, result: "cancelled", channel: rotation.channel, reason: rotation.reason ?? "" },
      "warn",
    );
    if (onSessionFailStopsJob(job)) {
      await safeWriteAuditLog("pipeline_auto_chain", { jobId, result: "stopped" }, "warn");
      return finalizeJob(ctx, config, { stopReason: "session_fail" });
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
  // 226 Phase 3: surface the REAL cause of the stopped document — the job
  // label says WHAT stopped, the doc receipt says WHY (may differ, e.g. a
  // `dispatch_failed` job stalling on a `clarify_dispatch_failed` doc).
  const failedDoc = state.docs.find((d) => d.failReason !== undefined && (d.status === "failed" || d.status === "skipped"));
  const detail = failedDoc?.failReason ? ` [failReason: ${failedDoc.failReason}]` : "";
  return (
    `Auto job "${state.jobId}" ${status}${reason}: ` +
    `${completed} completed, ${skipped} skipped, ${failed} failed, ${pending} pending ` +
    `of ${state.jobTotalDocs}.${detail}`
  );
}
