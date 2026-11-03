/**
 * @module pipeline-auto
 * 219 Phase 4: `/pipeline-auto` —the ONLY discovery + execution entry for
 * automatic pipelines.
 *
 * Frozen decisions (219_Feat.md 6.5 #1/#2/#11/#13):
 * - No user-supplied path is ever accepted: the menu scans `docs/jobs/*_loop.yaml`
 *   and `--job` takes a jobId only (a separator is rejected).
 * - 221 Phase 4: the chained continuation is ONE minimal `/pipeline-auto --next`
 *   (no `--job`, no `--token`); the job id + lock token live in `lock.json` only.
 *   `--token` is still PARSED for backward compatibility.
 * - The runner starts ONE document per invocation: stage progression is owned
 *   by the existing hook chain, never polled here.
 * - Ordering invariants: lock + "another job active" are checked BEFORE
 *   `applyOverlay`; `meta.autoJob` is written AFTER `startNewPipeline`
 *   (buildStartMeta would overwrite it); `docIndex` advances only when a doc
 *   starts.
 */

import * as fs from "node:fs";
import * as pathMod from "node:path";
import type { Command, PipelineConfig, PipelineJsonConfig, PipelineStage, SessionMeta } from "../types";
import { docsDirsOf } from "../docs-paths";
import { CONFIG_DIR_NAME } from "../constants";
import { createPipelineUI } from "../core/pipeline-ui";
import { startNewPipeline } from "./pipeline-start";
import { safeWriteAuditLog } from "../utils/auditLog";
import { shouldRecordAutoDecision } from "../core/auto-pipeline/auto-audit";
import { parseAutoJob, hashJobBytes, type AutoJobConfig } from "../core/auto-pipeline/job-schema";
import {
  clearPendingContinuation,
  createJobState,
  isValidJobId,
  listRunningJobs,
  markPendingContinuation,
  nextPendingDoc,
  noteDocStage,
  readJobState,
  resolveJobStatePath,
  resolveTrackedJobFile,
  writeJobState,
  type AutoJobState,
} from "../core/auto-pipeline/job-state";
import {
  acquireJobLock,
  applyOverlay,
  getActiveJobId,
  isAutoJobActive,
  readActiveJobContext,
  releaseJobLock,
  type AutoJobSnapshot,
} from "../core/auto-pipeline/config-overlay";
import { NEW_COMMIT_RE } from "../core/naming/doc-naming";
// 220 D5: start-stage resolution + the evidence gate in front of every start.
import { derivePlanDocPath, checkStartStageEvidence } from "../core/auto-pipeline/start-stage-evidence";
import { resolveStartStage } from "../core/auto-pipeline/resolve-start-stage";
import { planDocHasConfirmMarker } from "../core/verify-path-resolver";
// 219 Phase 5: the ONE terminal transaction (release + audit + rollback + unlock).
import { finalizeJob, handleDocFailure } from "../core/auto-pipeline/finalize";
import { auditAutoDiagnostic, notifyAuto } from "../core/auto-pipeline/diagnostics";
import {
  buildAutoJobMeta,
  readJobFile,
  selectJobFromMenu,
  type JobMenuRow,
} from "./pipeline-auto-menu";

/** Result shape every entry returns (the registry prints `error`/`message`). */
export interface AutoPipelineResult {
  success: boolean;
  message?: string;
  error?: string;
  /**
   * B3 (chained continuation): which side of `acquireJobLock` a FAILED call
   * stopped on.
   * - `pre_lock`: no lock was acquired by THIS call → the pending continuation
   *   record must stay retryable.
   * - `post_lock`: the lock was adopted/acquired → the terminal transaction is
   *   valid (`session_fail`).
   * - `unknown`: the call THREW, so the runner cannot report the phase; the
   *   caller must re-check actual ownership (`readActiveJobContext`) instead of
   *   assuming a side.
   * Absent on success; never inferred from the process-wide lock flag.
   */
  failurePhase?: "pre_lock" | "post_lock" | "unknown";
}

/**
 * Menu choices (project language rule: user-facing copy is English, and the
 * caller compares against these constants instead of repeating literals).
 */
const RESTART_CHOICE = "Restart job";
const CANCEL_CHOICE = "Cancel";
const RESUME_WITH_NEW_JOB_CHOICE = "Resume with the new job file";

/** Parsed command arguments (`pipeline-auto` case in `command-args`). */
export interface PipelineAutoArgs {
  next?: boolean;
  job?: string;
  token?: string;
  raw?: string;
}

/** Minimal ctx surface the command needs (narrowed from ExtensionContext). */
export interface AutoPipelineCommandCtx {
  session?: {
    getMeta?: () => SessionMeta | undefined;
    updateMeta?: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
  };
  ui?: {
    select?: (message: string, options: string[]) => Promise<string | undefined>;
    confirm?: (title: string, message: string) => Promise<boolean>;
    notify?: (message: string, level?: string) => void;
  };
  pi?: unknown;
  _ctx?: unknown;
  /** Present on hosts that can replace the session (used by Phase 5 chaining). */
  newSession?: (opts: { withSession: (replaced: unknown) => Promise<void> }) => Promise<unknown>;
}

export function createPipelineAutoCommand(config: PipelineConfig): Command {
  return {
    name: "pipeline-auto",
    description:
      `Auto pipeline: pick a job from ${docsDirsOf(config).jobsDir}/*.yaml and run clarify → plan → develop → review unattended`,
    execute: async (args: Record<string, unknown>, ctx?: unknown): Promise<unknown> =>
      runPipelineAuto(config, args as PipelineAutoArgs, ctx as AutoPipelineCommandCtx),
  };
}

/**
 * Command body: menu (no args) or `--next` resolution (internal).
 */
export async function runPipelineAuto(
  config: PipelineConfig,
  args: PipelineAutoArgs,
  ctx: AutoPipelineCommandCtx,
): Promise<AutoPipelineResult> {
  const jobArg = typeof args.job === "string" ? args.job.trim() : "";
  if (jobArg && !isValidJobId(jobArg)) {
    return { success: false, error: `invalid job id "${jobArg}" — pass a jobId, never a path` };
  }
  if (!args.next && !jobArg) {
    return runMenu(config, ctx);
  }
  const resolution = resolveInternalTarget(config, jobArg);
  if (!resolution.ok) {
    if (args.next) {
      // A dispatched continuation that cannot even resolve its target has no
      // owner left (review round 2 issue 3) — leave a receipt in the audit.
      auditAutoDiagnostic("chain_dispatch_unresolved", `Auto-job continuation target unresolved: ${resolution.error}`, {
        jobId: jobArg,
      });
    }
    return { success: false, error: resolution.error };
  }
  const result = await startAutoJob({
    config,
    ctx,
    jobId: resolution.jobId,
    ...(args.token ? { token: args.token } : {}),
    // Phase 5 §6.1: a dispatched `--next` is a CHAINED continuation — the
    // command host performs the session rotation first (`ctx.newSession`).
    ...(args.next ? { continuation: true } : {}),
  });
  if (args.next && !result.success) {
    // Review round 2 (issue 3): the chain has no callback, so the failure must
    // be closed HERE instead of leaving the job `running` with a held lock.
    await closeAbandonedContinuation(config, ctx, resolution.jobId, result.error);
  }
  return result;
}

/**
 * Close a dispatched continuation that could not start the next document
 * (review round 2, issue 3).
 *
 * Guards: only the lock OWNER (this process, this job) may close the job — a
 * dispatch that lost the lock to another terminal must never finalize it.
 */
async function closeAbandonedContinuation(
  config: PipelineConfig,
  ctx: AutoPipelineCommandCtx,
  jobId: string,
  error: string | undefined,
): Promise<void> {
  const active = readActiveJobContext(config.projectRoot, docsDirsOf(config).jobsDir);
  if (!active || active.jobId !== jobId || active.state.status !== "running") return;
  await safeWriteAuditLog(
    "pipeline_auto_chain",
    {
      jobId,
      result: "continuation_start_failed",
      channel: "dispatch",
      reason: error ?? "",
    },
    "warn",
  );
  notifyAuto(
    ctx,
    `Auto job "${jobId}": the continuation could not start the next document — stopping the job (session_fail).`,
  );
  await finalizeJob(ctx as never, config, { stopReason: "session_fail" });
}

/** B3: a failure before `acquireJobLock` leaves the pending record retryable. */
function preLockFailure(error: string): AutoPipelineResult {
  return { success: false, error, failurePhase: "pre_lock" };
}

/**
 * `--next` / `--job` target resolution (M1/M8, F8):
 * 1. `--job <jobId>` → the JOB FILE must exist (first start included; a
 *    missing sidecar is normal and is created by `startAutoJob`).
 * 2. no `--job` → scan: exactly one running job starts it, zero/many refuse.
 */
function resolveInternalTarget(
  config: PipelineConfig,
  jobId: string,
): { ok: true; jobId: string } | { ok: false; error: string } {
  if (jobId) {
    // 222 Phase 4: resolve through the SAME single resolver as the runtime
    // seams, so a job whose directory was moved is still startable by id.
    const jobsDir = docsDirsOf(config).jobsDir;
    const jobPath = resolveTrackedJobFile(
      config.projectRoot,
      jobsDir,
      jobId,
      readJobState(config.projectRoot, jobId)?.jobPath,
    );
    if (!jobId.endsWith("_loop") || !fs.existsSync(jobPath)) {
      // Phase 3 naming rule: only `<name>_loop.yaml` is a startable job file.
      return {
        ok: false,
        error: `auto job "${jobId}" not found — job files must be named <name>_loop.yaml`,
      };
    }
    return { ok: true, jobId };
  }
  const running = listRunningJobs(config.projectRoot);
  if (running.length === 1) return { ok: true, jobId: running[0]!.jobId };
  if (running.length === 0) {
    return { ok: false, error: "no running auto job — run /pipeline-auto to pick a job file" };
  }
  return {
    ok: false,
    error: `multiple running auto jobs (${running.map((r) => r.jobId).join(", ")}) — clean up .pi/auto_pipeline before continuing`,
  };
}

/** Menu path: scan → select → drift/completed/active guards → start. */
async function runMenu(config: PipelineConfig, ctx: AutoPipelineCommandCtx): Promise<AutoPipelineResult> {
  const selection = await selectJobFromMenu(ctx, config);
  if (selection.kind === "error") return { success: false, error: selection.error };
  if (selection.kind === "cancelled") return { success: true, message: "Auto pipeline cancelled" };

  const row = selection.row;
  if (row.corrupt) {
    return {
      success: false,
      error:
        `auto job "${row.jobId}" progress state is corrupt or uses an unknown schema — ` +
        `inspect/remove ${resolveJobStatePath(config.projectRoot, row.jobId)} before starting`,
    };
  }
  // B6: another job already owns the process-level lock — judged BEFORE the
  // overlay so `liveConfig` is never touched.
  if (isAutoJobActive() && getActiveJobId() !== row.jobId) {
    return { success: false, error: `another auto job is active: ${getActiveJobId()}` };
  }

  const jobFile = readJobFile(row.jobPath);
  if (!jobFile.ok) return { success: false, error: jobFile.error };

  let state = row.state;
  if (row.drifted && state) {
    const resolved = await resolveDrift(row, jobFile.raw, jobFile.hash, config, ctx);
    if (!resolved) return { success: true, message: "Auto pipeline cancelled" };
    state = resolved;
  }
  if (state?.status === "completed") {
    const choice = await ctx.ui?.select?.("This job is already completed.", [RESTART_CHOICE, CANCEL_CHOICE]);
    if (choice !== RESTART_CHOICE) return { success: true, message: "Auto pipeline cancelled" };
    // 219 Phase 4 §2 + review issue 3: the restart choice must REBUILD the sidecar.
    // Clearing a local variable changed nothing: `startAutoJob` re-reads the
    // same completed sidecar, `pickNextDoc` finds no pending doc and the job
    // ends as `job_completed` ("already finished"). The drift branch already
    // shows the correct construction — reuse the SAME one.
    const rebuilt = await rebuildJobState(config, row, jobFile.raw, jobFile.hash);
    if (!rebuilt.ok) return { success: false, error: rebuilt.error };
  }
  return startAutoJob({ config, ctx, jobId: row.jobId });
}

/**
 * Replace the sidecar of `row.jobId` with a FRESH state built from the current
 * job bytes (the RESTART choice shared by the completed and drift branches).
 */
async function rebuildJobState(
  config: PipelineConfig,
  row: JobMenuRow,
  raw: string,
  hash: string,
): Promise<{ ok: true; state: AutoJobState } | { ok: false; error: string }> {
  const parsed = parseAutoJob(raw, row.jobPath);
  if (!parsed.ok) return { ok: false, error: parsed.errors.join("\n") };
  const fresh = createJobState({
    jobId: row.jobId,
    // The sidecar keeps the PROJECT-RELATIVE path (on-disk contract unchanged).
    jobPath: pathMod.join(docsDirsOf(config).jobsDir, row.fileName),
    jobHash: hash,
    docs: parsed.job.docs.list,
  });
  await writeJobState(config.projectRoot, fresh);
  return { ok: true, state: fresh };
}

/**
 * `jobHash` drift → three-way choice. Returns the (possibly rebuilt) sidecar,
 * or `null` when the user cancelled.
 */
async function resolveDrift(
  row: JobMenuRow,
  raw: string,
  hash: string,
  config: PipelineConfig,
  ctx: AutoPipelineCommandCtx,
): Promise<AutoJobState | null> {
  const choice = await ctx.ui?.select?.("The job file changed since this run started.", [
    RESUME_WITH_NEW_JOB_CHOICE,
    RESTART_CHOICE,
    CANCEL_CHOICE,
  ]);
  if (shouldRecordAutoDecision(config)) {
    await safeWriteAuditLog("pipeline_auto_decision", {
      source: "manual",
      gate: "job_hash_drift",
      jobId: row.jobId,
      choice: choice ?? "cancelled",
    });
  }
  if (choice === CANCEL_CHOICE || choice === undefined) return null;

  const parsed = parseAutoJob(raw, row.jobPath);
  if (!parsed.ok) return null;
  if (choice === RESTART_CHOICE) {
    const rebuilt = await rebuildJobState(config, row, raw, hash);
    return rebuilt.ok ? rebuilt.state : null;
  }

  // "resume with the new job file": keep per-doc statuses aligned BY DOC PATH, then fall back
  // to the first pending doc when the current doc disappeared.
  const previous = row.state!;
  const byDoc = new Map(previous.docs.map((d) => [d.doc, d]));
  const docs = parsed.job.docs.list.map((entry) => {
    const old = byDoc.get(entry.doc);
    return old
      ? { ...old, doc: entry.doc }
      : { doc: entry.doc, status: "pending" as const, updatedAt: Date.now() };
  });
  const currentDoc = previous.docs[previous.docIndex]?.doc;
  const alignedIndex = docs.findIndex((d) => d.doc === currentDoc);
  const next = {
    ...previous,
    jobHash: hash,
    jobTotalDocs: docs.length,
    docs,
    docIndex: alignedIndex >= 0 ? alignedIndex : 0,
    updatedAt: Date.now(),
  };
  await writeJobState(config.projectRoot, next);
  return next;
}

/**
 * 221 Phase 4: rotate into a NEW session for the chained continuation.
 *
 * The settle seam runs on a hook ctx (`RuntimeCtx`/`ExtensionContext`) which
 * has no `newSession`, so it dispatches the minimal `/pipeline-auto --next`;
 * THIS handler is the only place that can replace the session. Guards:
 * - only a session that ALREADY ran a document rotates (`meta.autoJob` or a
 *   `completed` stage) — the fresh session must start the doc, otherwise the
 *   chain would rotate forever;
 * - the new session starts the pending doc on `session_start` (sidecar pending
 *   record + lock ownership), so this helper injects NO command: it only marks
 *   the pending continuation, opens the session and audits;
 * - a cancelled/failed hop clears the pending record and lets the caller fall
 *   back to the same-session serial (or `session_fail` with
 *   `onSessionFail: "stop"`).
 *
 * @returns the final result when the call is DONE (rotated, or stopped), or
 *   `null` when the caller must continue starting the doc in THIS session.
 */
async function rotateSessionForContinuation(input: {
  config: PipelineConfig;
  ctx: AutoPipelineCommandCtx;
  job: AutoJobConfig;
  jobId: string;
}): Promise<AutoPipelineResult | null> {
  const { config, ctx, job, jobId } = input;
  if (typeof ctx.newSession !== "function") return null;
  if (!job.chain.newSession) return null;

  const meta = ctx.session?.getMeta?.();
  const ranADocument = meta?.autoJob !== undefined || meta?.currentStage === "completed";
  if (!ranADocument) return null;

  // No sidecar → nothing to hand over; let the caller start in this session.
  const state = readJobState(config.projectRoot, jobId);
  if (!state) return null;

  markPendingContinuation(state, "session_start", Date.now());
  try {
    await writeJobState(config.projectRoot, state);
  } catch (err) {
    auditAutoDiagnostic("chain_pending_persist_failed", `Auto job "${jobId}": continuation record could not be written.`, {
      jobId,
      error: String(err),
    }, "error");
    // The sidecar is the ONLY hand-over channel to the new session: rotating
    // without it strands the job `running` (no pending record ⇒ `session_start`
    // does nothing and `reconcilePendingContinuation` is inert). Stay in THIS
    // session instead — the documented same-session serial.
    clearPendingContinuation(state);
    notifyAuto(
      ctx,
      `Auto job "${jobId}": the continuation record could not be written — continuing in this session.`,
      "warning",
    );
    return null;
  }

  const clearPending = async (): Promise<void> => {
    const fresh = readJobState(config.projectRoot, jobId);
    if (!fresh || !clearPendingContinuation(fresh)) return;
    try {
      await writeJobState(config.projectRoot, fresh);
    } catch {
      // The hop already failed; a stale record is reconciled later.
    }
    await safeWriteAuditLog(
      "pipeline_auto_chain",
      { jobId, result: "pending_cleared_on_cancel" },
      "warn",
    );
  };

  let cancelled = false;
  try {
    const result = (await ctx.newSession({
      withSession: async () => {
        // 221: audit-only. The fresh `session_start` starts the doc.
        await safeWriteAuditLog("pipeline_auto_chain", {
          jobId,
          result: "new_session",
          channel: "session_start",
        });
      },
    })) as { cancelled?: boolean } | undefined;
    cancelled = result?.cancelled === true;
  } catch (err) {
    await clearPending();
    auditAutoDiagnostic("chain_new_session_failed", `Auto job "${jobId}": session rotation failed in the command host.`, {
      jobId,
      error: String(err),
    }, "error");
    cancelled = true;
  }

  if (!cancelled) {
    await safeWriteAuditLog("pipeline_auto_chain", {
      jobId,
      result: "new_session",
      channel: "command_new_session",
    });
    return { success: true, message: `Auto job "${jobId}": next doc continued in a new session.` };
  }

  await clearPending();
  await safeWriteAuditLog(
    "pipeline_auto_chain",
    { jobId, result: "cancelled", channel: "command_new_session" },
    "warn",
  );
  if (job.chain.onSessionFail === "stop") {
    await safeWriteAuditLog("pipeline_auto_chain", { jobId, result: "stopped" }, "warn");
    const done = await finalizeJob(ctx as never, config, { stopReason: "session_fail" });
    // The lock is held and the job is terminal now: this is NOT a pre-lock
    // failure. Report the phase honestly (B3) so a future caller cannot retry a
    // job that already reached its terminal transaction.
    return {
      success: false,
      error: done.summary ?? `Auto job "${jobId}" stopped: session_fail`,
      failurePhase: "post_lock",
    };
  }
  // Documented same-session fallback: start the next doc HERE.
  return null;
}

/**
 * Start (or continue) the job: the ONLY place that acquires the lock, applies
 * the overlay and dispatches the first/next document.
 */
export async function startAutoJob(input: {
  config: PipelineConfig;
  ctx: AutoPipelineCommandCtx;
  jobId: string;
  token?: string;
  /**
   * Internal (chained continuation): report the failure to the caller instead
   * of running the terminal transaction, so `session_fail` stays write-once on
   * the chain side (219 Phase 5 §6.2).
   */
  deferFailure?: boolean;
  /**
   * Internal (chained continuation, Phase 5 §6.1): TRUE only for a dispatched
   * `--next`. The command host owns the session rotation, so this call first
   * hops to a new session and lets the fresh session start the document.
   */
  continuation?: boolean;
}): Promise<AutoPipelineResult> {
  const { config, ctx, jobId, token } = input;
  const projectRoot = config.projectRoot;

  if (!isValidJobId(jobId)) {
    return preLockFailure(`invalid job id "${jobId}" — job files must be named <name>_loop.yaml`);
  }
  if (isAutoJobActive() && getActiveJobId() !== jobId) {
    return preLockFailure(`another auto job is active: ${getActiveJobId()}`);
  }

  // 221 Phase 3: jobId is the FULL stem of `<name>_loop.yaml` — never normalized.
  // 222 Phase 4: the directory comes from `docs.jobsDir`. A job whose directory
  // was moved still resolves through the persisted `state.jobPath`, and the
  // sidecar then records the file that was ACTUALLY read (project-relative when
  // it lives under the project root — the on-disk contract is unchanged).
  const jobsDir = docsDirsOf(config).jobsDir;
  const trackedJobPath = resolveTrackedJobFile(
    projectRoot,
    jobsDir,
    jobId,
    readJobState(projectRoot, jobId)?.jobPath,
  );
  // 222 review issue 6: `state.jobPath` stays PROJECT-RELATIVE on disk. A
  // tracked file outside the project root is expressed with a `..`-prefixed
  // relative path (the same convention `listDocCandidates` uses) rather than
  // writing its absolute path back — an absolute sidecar value would silently
  // pin the job to one machine, and a bare absolute path is not the documented
  // on-disk contract.
  const jobRelPath = pathMod.isAbsolute(trackedJobPath)
    ? pathMod.relative(projectRoot, trackedJobPath).split(pathMod.sep).join("/")
    : trackedJobPath;
  const jobFile = readJobFile(trackedJobPath);
  if (!jobFile.ok) {
    // Missing OR unreadable: both mean "no such `<name>_loop.yaml` job".
    return preLockFailure(`${jobFile.error} — job files must be named <name>_loop.yaml`);
  }

  const parsed = parseAutoJob(jobFile.raw, jobRelPath);
  if (!parsed.ok) return preLockFailure(parsed.errors.join("\n"));
  const job = parsed.job;
  if (!job.enabled) {
    return preLockFailure(`auto job "${jobId}" is disabled (enabled: false)`);
  }

  // 220 C-2/B15: `tier: "assisted"` promises the full comparison, which only the
  // design-review verification stage can enforce. Judged at the COMMAND layer
  // (never in `parseAutoJob`, which stays a pure parser) and BEFORE the
  // lock/sidecar, so a misconfigured job leaves no state behind. The overlay
  // only maps decision keys and never enables a stage, so this is equivalent to
  // judging it right after `applyOverlay` — and strictly earlier is safer.
  if (job.tier === "assisted" && !config.stages["design-review"]?.verify?.require) {
    await safeWriteAuditLog("pipeline_auto_tier_rejected", {
      jobId,
      tier: job.tier,
      reason: "design_review_stage_not_enabled",
    }, "warn");
    return preLockFailure(
      `auto job "${jobId}" rejected: tier "assisted" requires the design-review stage to be enabled`,
    );
  }

  if (input.continuation === true) {
    const outcome = await rotateSessionForContinuation({ config, ctx, job, jobId });
    if (outcome) return outcome;
  }

  // 221 Phase 4: no token is required any more — a same-process lock is
  // adopted, another live process is busy, a dead holder is reclaimed.
  const lock = acquireJobLock({
    projectRoot,
    jobId,
    ...(token ? { token, takeover: true } : {}),
  });
  if (!lock.ok) {
    // Error copy is split by CAUSE (F8): a live holder is actionable, a token/
    // lock mismatch points at the lock file. Neither mentions a token to paste.
    // Either way no lock was acquired by THIS call → retryable (B3).
    if (lock.reason === "busy") {
      return preLockFailure(
        `auto job "${jobId}" is held by another process (pid ${lock.holder.pid}); ` +
          "wait or continue there",
      );
    }
    return preLockFailure("auto job lock could not be acquired; check .pi/auto_pipeline/lock.json");
  }

  const state = readJobState(projectRoot, jobId) ?? createJobState({
    jobId,
    jobPath: jobRelPath,
    jobHash: parsed.hash,
    docs: job.docs.list,
  });
  state.status = "running";
  state.jobHash = parsed.hash;
  state.jobPath = jobRelPath;
  state.updatedAt = Date.now();
  await writeJobState(projectRoot, state);

  const started = await startPendingDoc({
    config,
    ctx,
    jobId,
    job,
    state,
    token: lock.token,
    projectRoot,
    deferFailure: input.deferFailure === true,
  });
  // The lock was acquired above: any failure from here on is a POST-lock
  // failure (B3) — the continuation may run the terminal transaction.
  return started.success ? started : { ...started, failurePhase: "post_lock" };
}

/** Pick the next doc (honouring `skipCompleted`) and start it. */
async function startPendingDoc(input: {
  config: PipelineConfig;
  ctx: AutoPipelineCommandCtx;
  jobId: string;
  job: AutoJobConfig;
  state: AutoJobState;
  token: string;
  projectRoot: string;
  deferFailure?: boolean;
}): Promise<AutoPipelineResult> {
  const { config, ctx, jobId, job, state, token, projectRoot } = input;

  const target = pickNextDoc(state, job);
  if (!target) {
    await writeJobState(projectRoot, state);
    const done = await finalizeJob(ctx as never, config, { stopReason: "job_completed" });
    return done.skipped
      ? { success: true, message: `Auto job "${jobId}" already finished.` }
      : { success: true, message: done.summary };
  }

  // Sidecar first: persist the overlay snapshot. `docIndex` / doc status are
  // NOT touched yet — they advance only when the doc actually starts (M3).
  const overlay = readOverlayBase(config);
  if (!overlay.ok) {
    return failDoc(input, target.index, overlay.error);
  }
  const existing: AutoJobSnapshot | undefined = state.overlaySnapshot
    ? {
        jobId,
        jobPath: state.jobPath,
        jobHash: state.overlaySnapshot.jobHash,
        appliedAt: state.overlaySnapshot.appliedAt,
        before: state.overlaySnapshot.before,
        entries: state.overlaySnapshot.entries,
      }
    : undefined;
  const snapshot = applyOverlay(
    config,
    overlay.json,
    { ...job, jobHash: state.jobHash, jobId, jobPath: state.jobPath },
    existing,
  );
  state.overlaySnapshot = {
    appliedAt: snapshot.appliedAt,
    jobHash: snapshot.jobHash,
    before: snapshot.before,
    entries: snapshot.entries,
  };
  await writeJobState(projectRoot, state);

  await safeWriteAuditLog("pipeline_auto_start", {
    jobId,
    doc: target.doc.doc,
    docIndex: String(target.index),
    totalDocs: String(state.jobTotalDocs),
  });
  await safeWriteAuditLog("pipeline_auto_job_overlay", {
    jobId,
    jobHash: state.jobHash.substring(0, 12),
    entries: String(snapshot.entries.length),
    reused: String(existing !== undefined),
  });

  // 220 D5: the evidence gate runs BEFORE `startNewPipeline`, so a document can
  // never be attached to another document's plan/commit/report (no fallback to
  // an earlier stage is ever attempted).
  const derivedPlan = target.doc.doc.endsWith(".md") ? derivePlanDocPath(target.doc.doc) : null;
  // A plan path only exists as a FACT when the file does: an absent plan must
  // derive `clarify`, not "a plan without a confirmation marker" (= `plan`).
  const planExists = derivedPlan !== null && fs.existsSync(pathMod.resolve(projectRoot, derivedPlan));
  const facts = {
    planPath: planExists ? derivedPlan : null,
    planConfirmed:
      derivedPlan !== null &&
      planExists &&
      (await planDocHasConfirmMarker(pathMod.resolve(projectRoot, derivedPlan))),
  };
  const requestedStage = target.doc.startStage ?? job.defaults.startStage;
  const { stage, derivation } = resolveStartStage(requestedStage, facts);
  const evidence = await checkStartStageEvidence({
    config,
    meta: { requirementDoc: target.doc.doc },
    startStage: stage,
    projectRoot,
  });
  if (!evidence.ok) {
    await safeWriteAuditLog("pipeline_auto_start_stage_rejected", {
      jobId,
      doc: target.doc.doc,
      startStage: stage,
      missing: evidence.missing,
      onFailure: job.docs.onFailure,
    }, "warn");
    // B8: the missing evidence kind is encoded in `reason` — the shared failure
    // transaction's signature is NOT extended.
    return failDoc(input, target.index, `start_stage_evidence_missing:${evidence.missing}`);
  }

  const ui = createPipelineUI(config);
  const started = await startNewPipeline(ctx, config, ui, target.doc.doc, stage);
  if (!started.success) {
    return failDoc(input, target.index, started.error ?? "start_failed");
  }

  // M2: written AFTER startNewPipeline — buildStartMeta's updateMeta(newMeta)
  // would otherwise erase it.
  ctx.session?.updateMeta?.({
    autoJob: buildAutoJobMeta({
      jobId,
      jobPath: state.jobPath,
      docIndex: target.index,
      totalDocs: state.jobTotalDocs,
      designReviewMaxRounds: job.designReview.maxRounds,
      totalLoopsBudget: job.stopConditions.maxTotalLoops,
    }),
  });

  state.docs[target.index]!.pipelineId = started.pipelineId;
  state.docs[target.index]!.status = "running";
  state.docs[target.index]!.updatedAt = Date.now();
  // 220 D5: the evidence the start stage was verified against (B7) — same
  // resolved value that was handed to `startNewPipeline` (H4 consistency).
  state.docs[target.index]!.startStageBasis = evidence.basis;
  state.docs[target.index]!.startStageDerivation = derivation;
  // M3: `docIndex` = the doc CURRENTLY executing — advanced only here.
  state.docIndex = target.index;
  // H4: the startup stage is the ONLY other `lastStage` write besides settle.
  noteDocStage(state, target.index, stage, Date.now());
  // Review round 2 (issue 3): the outstanding continuation hop is ANSWERED —
  // the reconcile must never fire for a doc that really started.
  clearPendingContinuation(state);
  await writeJobState(projectRoot, state);

  return {
    success: true,
    message: `Auto pipeline started: job ${jobId}, doc ${target.index + 1}/${state.jobTotalDocs} (${target.doc.doc})`,
  };
}

/**
 * First doc still pending, honouring `skipCompleted`: a doc whose file name
 * matches `NEW_COMMIT_RE` counts as already shipped and is marked `skipped`.
 */
function pickNextDoc(
  state: AutoJobState,
  job: AutoJobConfig,
): { index: number; doc: AutoJobConfig["docs"]["list"][number] } | null {
  if (job.docs.skipCompleted) {
    for (const [index, progress] of state.docs.entries()) {
      if (progress.status !== "pending") continue;
      if (NEW_COMMIT_RE.test(progress.doc)) {
        progress.status = "skipped";
        progress.updatedAt = Date.now();
      }
    }
  }
  const next = nextPendingDoc(state);
  if (!next) return null;
  const doc = job.docs.list[next.index];
  if (!doc) return null;
  return { index: next.index, doc };
}

/** Read the JSON document the live config was resolved from. */
function readOverlayBase(
  config: PipelineConfig,
): { ok: true; json: PipelineJsonConfig } | { ok: false; error: string } {
  const jsonPath = config.configSourcePath ?? pathMod.join(config.projectRoot, CONFIG_DIR_NAME, "pipeline_loop.json");
  try {
    const raw = fs.readFileSync(jsonPath, "utf8");
    return { ok: true, json: JSON.parse(raw) as PipelineJsonConfig };
  } catch (err) {
    return { ok: false, error: `config source unreadable for overlay: ${jsonPath} (${String(err)})` };
  }
}

/**
 * Doc-level failure → the shared `handleDocFailure` (Phase 5): receipt +
 * release + `onFailure` scheduling. `docIndex` stays where it was (M3); the
 * attempted doc is passed explicitly so the receipt is correct.
 */
async function failDoc(
  input: Parameters<typeof startPendingDoc>[0],
  docIndex: number,
  reason: string,
): Promise<AutoPipelineResult> {
  const { config, ctx, job, state } = input;
  if (input.deferFailure) {
    // Record the attempt, hand the decision back to the caller (chain side).
    const progress = state.docs[docIndex];
    if (progress) {
      progress.status = "failed";
      progress.failReason = reason;
      progress.updatedAt = Date.now();
    }
    state.updatedAt = Date.now();
    await writeJobState(config.projectRoot, state);
    return { success: false, error: reason };
  }
  const result = await handleDocFailure(ctx as never, config, state, job, {
    outcome: "failed",
    reason,
    docIndex,
  });
  if (result.skipped) {
    return { success: false, error: `Auto job doc failed: ${reason}` };
  }
  // The job is still running only when `onFailure:continue` started the next
  // doc; any other outcome is terminal for this invocation.
  const live = readJobState(config.projectRoot, input.jobId);
  const continued = live?.status === "running";
  return {
    success: continued,
    message: result.summary,
    ...(continued ? {} : { error: result.summary }),
  };
}

/** Hashes a job file's bytes (re-exported for the menu/tests). */
export function hashJobFile(jobPath: string): string | null {
  try {
    return hashJobBytes(fs.readFileSync(jobPath, "utf8"));
  } catch {
    return null;
  }
}
