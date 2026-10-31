/**
 * @module pipeline-auto
 * 219 Phase 4: `/pipeline-auto` —the ONLY discovery + execution entry for
 * automatic pipelines.
 *
 * Frozen decisions (219_Feat.md 6.5 #1/#2/#11/#13):
 * - No user-supplied path is ever accepted: the menu scans `docs/jobs/*.yaml`
 *   and `--job` takes a jobId only (a separator is rejected).
 * - `--next` / `--job` / `--token` are INTERNAL (chained continuation); the
 *   token resolution order is the M8 one from Phase 2.
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
import { AUTO_PIPELINE_JOB_DIR, CONFIG_DIR_NAME } from "../constants";
import { createPipelineUI } from "../core/pipeline-ui";
import { startNewPipeline } from "./pipeline-start";
import { safeWriteAuditLog } from "../utils/auditLog";
import { shouldRecordAutoDecision } from "../core/auto-pipeline/auto-audit";
import { parseAutoJob, hashJobBytes, type AutoJobConfig } from "../core/auto-pipeline/job-schema";
import {
  createJobState,
  isValidJobId,
  listRunningJobs,
  nextPendingDoc,
  noteDocStage,
  readJobState,
  resolveJobStatePath,
  writeJobState,
  type AutoJobState,
} from "../core/auto-pipeline/job-state";
import {
  acquireJobLock,
  applyOverlay,
  getActiveJobId,
  isAutoJobActive,
  releaseJobLock,
  type AutoJobSnapshot,
} from "../core/auto-pipeline/config-overlay";
import { NEW_COMMIT_RE } from "../core/naming/doc-naming";
// 219 Phase 5: the ONE terminal transaction (release + audit + rollback + unlock).
import { finalizeJob, handleDocFailure } from "../core/auto-pipeline/finalize";
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
}

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
      "Auto pipeline: pick a job from docs/jobs/*.yaml and run clarify → plan → develop → review unattended",
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
  if (!resolution.ok) return { success: false, error: resolution.error };
  return startAutoJob({
    config,
    ctx,
    jobId: resolution.jobId,
    ...(args.token ? { token: args.token } : {}),
    // Phase 5 §6.1: a dispatched `--next` is a CHAINED continuation — the
    // command host performs the session rotation first (`ctx.newSession`).
    ...(args.next ? { continuation: true } : {}),
  });
}

/**
 * `--next` / `--job` target resolution (M1/M8):
 * 1. `--job <jobId>` → the sidecar must exist.
 * 2. no `--job` → scan: exactly one running job starts it, zero/many refuse.
 */
function resolveInternalTarget(
  config: PipelineConfig,
  jobId: string,
): { ok: true; jobId: string } | { ok: false; error: string } {
  if (jobId) {
    if (!fs.existsSync(resolveJobStatePath(config.projectRoot, jobId))) {
      return { ok: false, error: `auto job state not found: ${jobId}` };
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
    const choice = await ctx.ui?.select?.("This job is already completed.", ["重新开始", "取消"]);
    if (choice !== "重新开始") return { success: true, message: "Auto pipeline cancelled" };
    // 219 Phase 4 §2 + review issue 3: "重新开始" must REBUILD the sidecar.
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
 * job bytes (the "重新开始" construction shared by the completed and drift
 * branches).
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
    jobPath: pathMod.join(AUTO_PIPELINE_JOB_DIR, row.fileName),
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
    "按新 job 续跑",
    "重新开始",
    "取消",
  ]);
  if (shouldRecordAutoDecision(config)) {
    await safeWriteAuditLog("pipeline_auto_decision", {
      source: "manual",
      gate: "job_hash_drift",
      jobId: row.jobId,
      choice: choice ?? "cancelled",
    });
  }
  if (choice === "取消" || choice === undefined) return null;

  const parsed = parseAutoJob(raw, row.jobPath);
  if (!parsed.ok) return null;
  if (choice === "重新开始") {
    const rebuilt = await rebuildJobState(config, row, raw, hash);
    return rebuilt.ok ? rebuilt.state : null;
  }

  // "按新 job 续跑": keep per-doc statuses aligned BY DOC PATH, then fall back
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
 * Phase 5 §6.1 — COMMAND-SIDE session rotation for a chained continuation.
 *
 * The settle seam runs on a hook ctx (`RuntimeCtx`/`ExtensionContext`) which
 * has no `newSession`, so it dispatches `/pipeline-auto --next …`; THIS handler
 * is the only place that can replace the session. Two guards keep it honest:
 * - only a session that ALREADY ran a document rotates (`meta.autoJob` or a
 *   `completed` stage) — the fresh session created here must start the doc,
 *   otherwise the chain would rotate forever;
 * - `{ cancelled }` from the host is the documented same-session fallback
 *   (Phase 5 §6.2), never a terminal state; `chain.onSessionFail: "stop"`
 *   turns that fallback into `session_fail` instead.
 *
 * @returns the final result when the call is DONE (rotated, or stopped), or
 *   `null` when the caller must continue starting the doc in THIS session.
 */
async function rotateSessionForContinuation(input: {
  config: PipelineConfig;
  ctx: AutoPipelineCommandCtx;
  job: AutoJobConfig;
  jobId: string;
  token?: string;
}): Promise<AutoPipelineResult | null> {
  const { config, ctx, job, jobId, token } = input;
  if (typeof ctx.newSession !== "function") return null;
  if (!job.chain.newSession) return null;

  const meta = ctx.session?.getMeta?.();
  const ranADocument = meta?.autoJob !== undefined || meta?.currentStage === "completed";
  if (!ranADocument) return null;

  const command = [
    "/pipeline-auto",
    "--next",
    "--job",
    jobId,
    ...(token ? ["--token", token] : []),
  ].join(" ");

  let cancelled = false;
  try {
    const result = (await ctx.newSession({
      withSession: async (replaced) => {
        const send = (replaced as {
          sendUserMessage?: (content: string, opts?: Record<string, unknown>) => unknown;
        }).sendUserMessage;
        if (typeof send === "function") {
          await Promise.resolve(send.call(replaced, command, { expandPromptTemplates: true }));
        }
      },
    })) as { cancelled?: boolean } | undefined;
    cancelled = result?.cancelled === true;
  } catch (err) {
    console.error(`[pipeline-auto] --next: newSession failed for ${jobId}: ${String(err)}`);
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

  await safeWriteAuditLog(
    "pipeline_auto_chain",
    { jobId, result: "cancelled", channel: "command_new_session" },
    "warn",
  );
  if (job.chain.onSessionFail === "stop") {
    await safeWriteAuditLog("pipeline_auto_chain", { jobId, result: "stopped" }, "warn");
    const done = await finalizeJob(ctx as never, config, { stopReason: "session_fail" });
    return {
      success: false,
      error: done.summary ?? `Auto job "${jobId}" stopped: session_fail`,
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

  if (!isValidJobId(jobId)) return { success: false, error: `invalid job id "${jobId}"` };
  if (isAutoJobActive() && getActiveJobId() !== jobId) {
    return { success: false, error: `another auto job is active: ${getActiveJobId()}` };
  }

  const jobRelPath = pathMod.join(AUTO_PIPELINE_JOB_DIR, `${jobId}.yaml`);
  const jobFile = readJobFile(pathMod.join(projectRoot, jobRelPath));
  if (!jobFile.ok) return { success: false, error: jobFile.error };

  const parsed = parseAutoJob(jobFile.raw, jobRelPath);
  if (!parsed.ok) return { success: false, error: parsed.errors.join("\n") };
  const job = parsed.job;
  if (!job.enabled) return { success: false, error: `auto job "${jobId}" is disabled (enabled: false)` };

  if (input.continuation === true) {
    const outcome = await rotateSessionForContinuation({ config, ctx, job, jobId, ...(token ? { token } : {}) });
    if (outcome) return outcome;
  }

  // M8 token resolution: an explicit token means "reclaim if needed"; the lock
  // module decides between adopt / stale_token / busy.
  const lock = acquireJobLock({
    projectRoot,
    jobId,
    ...(token ? { token } : {}),
    ...(token ? { takeover: true } : {}),
  });
  if (!lock.ok) {
    if (lock.reason === "stale_token") {
      return { success: false, error: `auto job lock token mismatch for "${jobId}" — run /pipeline-auto --next --job ${jobId} --token <token>` };
    }
    return { success: false, error: `auto job busy: ${lock.holder.jobId} (pid ${lock.holder.pid})` };
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

  return startPendingDoc({
    config,
    ctx,
    jobId,
    job,
    state,
    token: lock.token,
    projectRoot,
    deferFailure: input.deferFailure === true,
  });
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

  const ui = createPipelineUI(config);
  const started = await startNewPipeline(
    ctx,
    config,
    ui,
    target.doc.doc,
    (target.doc.startStage ?? "clarify") as PipelineStage,
  );
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
  // M3: `docIndex` = the doc CURRENTLY executing — advanced only here.
  state.docIndex = target.index;
  // H4: the startup stage is the ONLY other `lastStage` write besides settle.
  noteDocStage(state, target.index, (target.doc.startStage ?? "clarify") as PipelineStage, Date.now());
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
