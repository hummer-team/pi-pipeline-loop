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
    state = null; // fresh state
  }

  return startAutoJob({ config, ctx, jobId: row.jobId });
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
    const fresh = createJobState({
      jobId: row.jobId,
      jobPath: pathMod.join(AUTO_PIPELINE_JOB_DIR, row.fileName),
      jobHash: hash,
      docs: parsed.job.docs.list,
    });
    await writeJobState(config.projectRoot, fresh);
    return fresh;
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
 * Start (or continue) the job: the ONLY place that acquires the lock, applies
 * the overlay and dispatches the first/next document.
 */
export async function startAutoJob(input: {
  config: PipelineConfig;
  ctx: AutoPipelineCommandCtx;
  jobId: string;
  token?: string;
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

  return startPendingDoc({ config, ctx, jobId, job, state, token: lock.token, projectRoot });
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
}): Promise<AutoPipelineResult> {
  const { config, ctx, jobId, job, state, token, projectRoot } = input;

  const target = pickNextDoc(state, job);
  if (!target) {
    return stopJob({ config, ctx, jobId, state, token, projectRoot, stopReason: "job_completed" });
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
 * Doc-level failure. Phase 4 keeps the terminal transaction inline; Phase 5
 * replaces it with the shared `handleDocFailure` (same outcomes + release).
 */
async function failDoc(
  input: Parameters<typeof startPendingDoc>[0],
  docIndex: number,
  reason: string,
): Promise<AutoPipelineResult> {
  const { config, ctx, jobId, job, state, token, projectRoot } = input;
  const progress = state.docs[docIndex];
  if (progress) {
    progress.status = "failed";
    progress.failReason = reason;
    progress.updatedAt = Date.now();
  }
  state.updatedAt = Date.now();
  await safeWriteAuditLog("pipeline_auto_decision", {
    source: "auto_pipeline",
    gate: "doc_failure",
    jobId,
    doc: progress?.doc ?? "",
    reason,
  }, "warn");

  if (job.docs.onFailure === "continue") {
    const next = pickNextDoc(state, job);
    if (next) {
      await writeJobState(projectRoot, state);
      return startPendingDoc(input);
    }
  }
  await writeJobState(projectRoot, state);
  return stopJob({
    config,
    ctx,
    jobId,
    state,
    token,
    projectRoot,
    stopReason: job.docs.onFailure === "continue" ? "job_completed" : "session_fail",
  });
}

/** Terminal transaction for one job (Phase 5 extends it with the rollback). */
async function stopJob(input: {
  config: PipelineConfig;
  ctx: AutoPipelineCommandCtx;
  jobId: string;
  state: AutoJobState;
  token: string;
  projectRoot: string;
  stopReason: AutoJobState["stopReason"];
}): Promise<AutoPipelineResult> {
  const { config, ctx, jobId, state, token, projectRoot, stopReason } = input;
  state.status = stopReason === "job_completed" ? "completed" : "failed";
  state.stopReason = stopReason;
  state.updatedAt = Date.now();
  await writeJobState(projectRoot, state);
  await safeWriteAuditLog("pipeline_auto_cleanup", { jobId, stopReason: stopReason ?? "" });
  await safeWriteAuditLog("pipeline_auto_stop", { jobId, stopReason: stopReason ?? "" }, "warn");

  // Phase 4 rolls the overlay back here; Phase 5 moves the rollback into the
  // shared `finalizeJob` together with the `--next` chain decision.
  if (state.overlaySnapshot) {
    const { restoreOverlay } = await import("../core/auto-pipeline/config-overlay");
    restoreOverlay(config, state.overlaySnapshot);
    await safeWriteAuditLog("pipeline_auto_overlay_restore", { jobId });
  }
  releaseJobLock({ projectRoot, token });

  const completed = state.docs.filter((d) => d.status === "completed" || d.status === "skipped").length;
  const message =
    stopReason === "job_completed"
      ? `Auto job "${jobId}" finished: ${completed}/${state.jobTotalDocs} docs completed.`
      : `Auto job "${jobId}" stopped (${stopReason ?? "unknown"}): ${completed}/${state.jobTotalDocs} docs completed.`;
  ctx.ui?.notify?.(message, stopReason === "job_completed" ? undefined : "error");
  return { success: stopReason === "job_completed", message, ...(stopReason === "job_completed" ? {} : { error: message }) };
}

/** Hashes a job file's bytes (re-exported for the menu/tests). */
export function hashJobFile(jobPath: string): string | null {
  try {
    return hashJobBytes(fs.readFileSync(jobPath, "utf8"));
  } catch {
    return null;
  }
}
