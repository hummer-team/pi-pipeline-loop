/**
 * @module pipeline-auto-menu
 * 219 Phase 4 (R5Q3-A + M2): discovery + menu rows for `/pipeline-auto`.
 *
 * Rules (frozen):
 * - Scan ONLY `{projectRoot}/{jobsDir}/*_loop.yaml` and `*_loop.yml` (no
 *   recursion; `jobsDir` defaults to `docs/jobs`, configurable via
 *   `docs.jobsDir` — 222 Phase 4), take the ≤5 newest by mtime; every other
 *   `.yaml`/`.yml` is reported as IGNORED (221 Phase 3, 223 Phase 3).
 * - The two extensions are peers: `jobId` is the full stem in both cases, so
 *   `foo_loop.yml` also owns `.pi/auto_pipeline/foo_loop/state.json`. When both
 *   files exist, `.yaml` wins and the row is flagged as ambiguous (223 Phase 3).
 * - Row copy is ENGLISH (project language rule): `{file} ({done}/{total} done)`,
 *   plus `resume {docIndex+1}/{total}` when the sidecar is running, plus
 *   `(job changed)` when the job file's hash no longer matches the sidecar
 *   (drift is the caller's three-way choice).
 * - A corrupt / foreign-schema sidecar is reported as `corrupt` and must be
 *   REFUSED by the caller (never silently restarted).
 */

import * as fs from "node:fs";
import * as pathMod from "node:path";
import type { PipelineConfig, SessionMeta } from "../types";
import { DEFAULT_JOBS_DIR, JOB_FILE_EXTENSIONS, LOOP_JOB_STEM_SUFFIX } from "../constants";
import { docsDirsOf } from "../docs-paths";
import { hashJobBytes, parseAutoJob } from "../core/auto-pipeline/job-schema";
import {
  isValidJobId,
  readJobState,
  resolveJobStatePath,
  type AutoJobState,
} from "../core/auto-pipeline/job-state";
import { auditAutoDiagnostic } from "../core/auto-pipeline/diagnostics";

/** One menu row (one `{jobsDir}/*_loop.(yaml|yml)` file). */
export interface JobMenuRow {
  jobId: string;
  /** Real on-disk file name — never decorated with display text. */
  fileName: string;
  /** `true` when a sibling `.yaml`/`.yml` file shares this row's stem. */
  suffixAmbiguous?: boolean;
  /** Absolute path of the job file. */
  jobPath: string;
  /** Job-file mtime (ordering key). */
  mtime: number;
  /** Sidecar state; `null` when absent or corrupt. */
  state: AutoJobState | null;
  /** A sidecar FILE exists but could not be read (refuse to start). */
  corrupt: boolean;
  /** Parsed doc count (0 when the job file is unparseable). */
  totalDocs: number;
  completedDocs: number;
  /** Job file changed since the sidecar was written. */
  drifted: boolean;
}

const MAX_MENU_ROWS = 5;

/** Result of one directory scan: the menu rows plus the ignored file names. */
export interface JobScanResult {
  /** Parsable `*_loop.(yaml|yml)` rows (mtime desc, bounded to 5). */
  rows: JobMenuRow[];
  /** `.yaml`/`.yml` files that are NOT `*_loop.*` (sorted; never parsed). */
  ignored: string[];
}

/**
 * Scan the job directory and build menu rows (mtime desc, bounded to 5).
 * Only `*_loop.yaml` / `*_loop.yml` files become rows; every other `.yaml` or
 * `.yml` is reported as ignored so the menu can explain the naming rule. Never
 * throws: a missing directory yields empty lists, unreadable files are skipped
 * with an error log.
 *
 * `jobsDir` is project-relative (or absolute) and defaults to the built-in
 * `docs/jobs`; pass `docsDirsOf(config).jobsDir` to honour the configuration.
 */
export function scanJobFiles(projectRoot: string, jobsDir: string = DEFAULT_JOBS_DIR): JobScanResult {
  const dir = pathMod.isAbsolute(jobsDir) ? jobsDir : pathMod.join(projectRoot, jobsDir);
  let jobNames: string[];
  try {
    jobNames = fs.readdirSync(dir).filter((name) => JOB_FILE_EXTENSIONS.some((ext) => name.endsWith(ext)));
  } catch {
    return { rows: [], ignored: [] };
  }

  const ignored = jobNames.filter((name) => {
    const stem = name.replace(/\.(yaml|yml)$/, "");
    return !stem.endsWith(LOOP_JOB_STEM_SUFFIX);
  }).sort();
  const names = jobNames.filter((name) => {
    const stem = name.replace(/\.(yaml|yml)$/, "");
    return stem.endsWith(LOOP_JOB_STEM_SUFFIX);
  });

  const rows: JobMenuRow[] = [];
  const preferred = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const fileName of names) {
    const stem = fileName.replace(/\.(yaml|yml)$/, "");
    const existing = preferred.get(stem);
    if (!existing) {
      preferred.set(stem, fileName);
      continue;
    }
    if (existing.endsWith(".yml") && fileName.endsWith(".yaml")) {
      preferred.set(stem, fileName);
    }
    ambiguous.add(stem);
  }

  for (const fileName of preferred.values()) {
    const jobPath = pathMod.join(dir, fileName);
    // jobId = FULL stem, so `foo_loop.yaml` → `foo_loop` and the sidecar lives
    // at `.pi/auto_pipeline/foo_loop/state.json`.
    const jobId = fileName.replace(/\.(yaml|yml)$/, "");
    if (!isValidJobId(jobId)) {
      auditAutoDiagnostic("job_file_name_unsafe", `Auto-job file name is not a safe job id — skipped: ${fileName}`);
      continue;
    }
    let mtime = 0;
    let raw: string;
    try {
      mtime = fs.statSync(jobPath).mtimeMs;
      raw = fs.readFileSync(jobPath, "utf8");
    } catch (err) {
      auditAutoDiagnostic("job_file_unreadable", `Auto-job file unreadable — skipped: ${jobPath}`, {
        error: String(err),
      });
      continue;
    }

    // The persisted job path mirrors the scan location (project-relative when
    // the directory is relative — the on-disk contract is unchanged).
    const parsed = parseAutoJob(raw, pathMod.join(jobsDir, fileName));
    const sidecarExisted = fs.existsSync(resolveJobStatePath(projectRoot, jobId));
    const state = readJobState(projectRoot, jobId);
    rows.push({
      jobId,
      fileName,
      ...(ambiguous.has(jobId) ? { suffixAmbiguous: true } : {}),
      jobPath,
      mtime,
      state,
      corrupt: sidecarExisted && state === null,
      totalDocs: parsed.ok ? parsed.job.docs.list.length : 0,
      completedDocs: state ? state.docs.filter((d) => d.status === "completed" || d.status === "skipped").length : 0,
      drifted: state !== null && hashJobBytes(raw) !== state.jobHash,
    });
    if (ambiguous.has(jobId)) {
      auditAutoDiagnostic(
        "job_file_suffix_ambiguous",
        `Auto-job file suffix ambiguous for "${jobId}"; preferring .yaml over .yml.`,
        { jobId },
        "warn",
      );
    }
  }

  return { rows: rows.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_MENU_ROWS), ignored };
}

/** Menu label for one row (R5Q3-A copy, English). */
export function formatJobMenuLabel(row: JobMenuRow): string {
  const progress = `${row.completedDocs}/${row.totalDocs} done`;
  const parts = [`${row.fileName} (${progress})`];
  if (row.suffixAmbiguous) parts.push("(both .yaml and .yml present)");
  if (row.state?.status === "running") {
    parts.push(`resume ${row.state.docIndex + 1}/${row.state.jobTotalDocs}`);
  }
  if (row.corrupt) parts.push("(progress state corrupt)");
  if (row.drifted) parts.push("(job changed)");
  return parts.join(" ");
}

/** Outcome of the job selection dialog. */
export type JobMenuSelection =
  | { kind: "selected"; row: JobMenuRow }
  | { kind: "cancelled" }
  | { kind: "error"; error: string };

/**
 * Present the job menu. No UI / empty directory / cancel → a typed result the
 * caller turns into the single user-facing message.
 */
export async function selectJobFromMenu(
  ctx: { ui?: { select?: (message: string, options: string[]) => Promise<string | undefined>; notify?: (message: string, level?: string) => void } },
  config: PipelineConfig,
): Promise<JobMenuSelection> {
  const jobsDir = docsDirsOf(config).jobsDir;
  const { rows, ignored } = scanJobFiles(config.projectRoot, jobsDir);
  const ignoredNote = ignored.length > 0
    ? ` Ignored ${ignored.length} non-*_loop.yaml|yml file(s): ${ignored.join(", ")}. Rename them to <name>_loop.yaml or <name>_loop.yml.`
    : "";
  if (rows.length === 0) {
    return {
      kind: "error",
      error:
        `No job files found in ${jobsDir}/*_loop.yaml|yml. Create one first (see the template installed by /pipeline-init: .pi/auto_job_loop_template.yaml).` +
        ignoredNote,
    };
  }
  if (typeof ctx.ui?.select !== "function") {
    return { kind: "error", error: "Auto pipeline requires a menu-capable host (ui.select is unavailable)" };
  }

  const labels = rows.map(formatJobMenuLabel);
  const cancelLabel = "Cancel";
  const title = ignored.length > 0
    ? `Auto pipeline — choose a job (ignored ${ignored.length} non-*_loop.yaml|yml)`
    : "Auto pipeline — choose a job";
  const selection = await ctx.ui.select(title, [...labels, cancelLabel]);
  if (!selection || selection === cancelLabel) return { kind: "cancelled" };

  const index = labels.indexOf(selection);
  const row = index >= 0 ? rows[index] : undefined;
  if (!row) return { kind: "cancelled" };
  return { kind: "selected", row };
}

/**
 * Read the job file and return its raw text + hash, or an error. Used by both
 * the menu (drift) and the runner (parse).
 */
export function readJobFile(
  jobPath: string,
): { ok: true; raw: string; hash: string } | { ok: false; error: string } {
  try {
    const raw = fs.readFileSync(jobPath, "utf8");
    return { ok: true, raw, hash: hashJobBytes(raw) };
  } catch (err) {
    return { ok: false, error: `job file unreadable: ${jobPath} (${String(err)})` };
  }
}

/**
 * Meta fields the auto runner writes AFTER `startNewPipeline` (buildStartMeta
 * overwrites anything written earlier).
 */
export function buildAutoJobMeta(input: {
  jobId: string;
  jobPath: string;
  docIndex: number;
  totalDocs: number;
  designReviewMaxRounds: number;
  /** Phase 6 §3: the job's `stopConditions.maxTotalLoops` (remaining-budget display). */
  totalLoopsBudget?: number;
}): NonNullable<SessionMeta["autoJob"]> {
  return {
    jobId: input.jobId,
    jobPath: input.jobPath,
    docIndex: input.docIndex,
    totalDocs: input.totalDocs,
    designReviewMaxRounds: input.designReviewMaxRounds,
    designReviewRounds: 0,
    lastCountedDesignReviewRound: 0,
    ...(input.totalLoopsBudget !== undefined ? { totalLoopsBudget: input.totalLoopsBudget } : {}),
  };
}
