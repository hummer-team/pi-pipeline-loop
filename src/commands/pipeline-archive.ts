/**
 * @module pipeline-archive
 * 206 Phase 4: `/pipeline-archive` command — TUI-only interactive archiving
 * of stale design documents and audit logs.
 *
 * Flow (strict order, 206_Feat Round 5 Q5-A):
 *  1. Defensive TUI guard (no ui.select → notify + warn-audit + no execution)
 *  2. Threshold menu (7 / 3 / 1 days — built-in constants, Cancel-safe)
 *  3. Scan + audit (thresholdDays / fileCount / totalBytes / missingDirs)
 *  4. Dry-run preview (ui.content markdown + summary in the action menu)
 *  5. Action menu (Move to zip / Delete permanently / Cancel)
 *  6. Second confirm (default-cancel semantics)
 *  7. Execute (zip-then-delete for "Move to zip"; direct delete otherwise)
 *  8. Result message
 *
 * Safety contract:
 * - zip failure NEVER deletes source files.
 * - Active pipeline documents (requirementDoc + same-base derivatives) are
 *   excluded by the scanner (Phase 3 `isActivePipelineDoc`).
 * - Every destructive/error branch writes an audit entry with context.
 */

import * as path from "node:path";
import type { ExecFn, PipelineConfig } from "../types";
import { collectArchiveTargets, archiveScopeRoots, type ArchiveTarget } from "../core/archive/scanner";
import {
  assertZipPathAvailable,
  buildArchiveZipPath,
  createArchiveZip,
  deleteArchiveTargets,
  ensureArchiveDestDir,
  probeZipAvailable,
  resolveArchiveDestDir,
} from "../core/archive/runner";
import { safeWriteAuditLog } from "../utils/auditLog";

/**
 * Formats a byte count for the dry-run preview (B/KB/MB/GB, one decimal).
 * Local to this module — the only consumer is the archive preview.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const display = unit === 0 ? String(value) : value.toFixed(1);
  return `${display} ${units[unit]}`;
}

/**
 * Structural type of the TUI select used for menu choices. Mirrors the
 * shared plugin ui surface (kept local per code-spec: no `any`).
 */
type SelectFn = (message: string, options: string[]) => Promise<string | undefined>;

/**
 * Local structural type for the optional TUI confirm dialog. Hosts without
 * it are emulated by a select fallback (default-cancel semantics preserved).
 */
type ConfirmFn = (message: string, options?: string[]) => Promise<boolean>;

/** Command execution context (SDK-untyped mirrors the other command modules). */
interface ArchiveCtx {
  ui?: {
    select?: unknown;
    confirm?: unknown;
    notify?: (message: string) => void;
    content?: (markdown: string) => void;
  };
  session?: {
    getMeta?: () => { requirementDoc?: string } | undefined;
  };
}

const PREVIEW_LINE_LIMIT = 10;

export function createPipelineArchiveCommand(
  config: PipelineConfig,
  opts?: { execFn?: ExecFn },
): {
  name: string;
  description: string;
  execute: (args: Record<string, unknown>, ctx?: ArchiveCtx) => Promise<unknown>;
} {
  return {
    name: "pipeline-archive",
    description:
      "Archive or delete design documents and .pi/audit logs older than a chosen age " +
      "(7/3/1 days). TUI-only: threshold → dry-run preview → action → second confirm.",
    execute: async (args: Record<string, unknown>, ctx?: ArchiveCtx): Promise<unknown> =>
      executeArchiveCommand(args, ctx, config, opts?.execFn),
  };
}

/** Command orchestrator — kept thin; steps live in the helper functions. */
async function executeArchiveCommand(
  args: Record<string, unknown>,
  ctx: ArchiveCtx | undefined,
  config: PipelineConfig,
  execFn: ExecFn | undefined,
): Promise<{ success: boolean; message?: string; error?: string }> {
  void args;

  // Step 1: defensive TUI guard — never execute without an interactive session
  if (typeof ctx?.ui?.select !== "function") {
    ctx?.ui?.notify?.("pipeline-archive requires an interactive TUI session; nothing was changed.");
    await safeWriteAuditLog("pipeline_archive_no_ui", {
      action: "pipeline-archive",
      result: "aborted_no_ui",
    }, "warn");
    return {
      success: false,
      error: "pipeline-archive requires an interactive TUI session.",
    };
  }
  const select = ctx.ui.select as SelectFn;

  // Step 2: threshold menu (Cancel-safe)
  const days = await runThresholdMenu(select);
  if (days === null) {
    await safeWriteAuditLog("pipeline_archive_cancelled", { stage: "threshold" });
    return { success: false, message: "Archive cancelled." };
  }

  // Step 3: scan (strict `>` mtime comparison, active docs protected)
  const activeDoc = ctx?.session?.getMeta?.()?.requirementDoc;
  const scan = await collectArchiveTargets(config, days, activeDoc);
  await safeWriteAuditLog("pipeline_archive_scan", {
    thresholdDays: String(days),
    fileCount: String(scan.targets.length),
    totalBytes: String(scan.totalBytes),
    missingDirs: scan.missingDirs.join(","),
    skippedActive: String(scan.skippedActive),
  });
  if (scan.targets.length === 0) {
    const msg = `No documents older than ${days} day(s).`;
    ctx.ui.notify?.(msg);
    return { success: true, message: msg };
  }

  // Step 4: dry-run preview (markdown listing; destination shown absolute)
  renderPreview(ctx, scan.targets, scan.totalBytes, config);

  // Step 5: action menu
  const action = await runActionMenu(select, ctx.ui, scan.targets.length, days);
  if (action === null) {
    await safeWriteAuditLog("pipeline_archive_cancelled", { stage: "action" });
    return { success: false, message: "Archive cancelled." };
  }

  // Step 6: second confirm (default-cancel)
  const confirmed = await runSecondConfirm(ctx, scan.targets.length, action.action);
  if (!confirmed) {
    await safeWriteAuditLog("pipeline_archive_cancelled", { stage: "confirm", action: action.action });
    return { success: false, message: "Archive cancelled." };
  }

  // Step 7: execute
  const message = action.action === "move"
    ? await executeMove(ctx, config, execFn, scan.targets, days)
    : await executeDelete(ctx, config, scan.targets, days);

  // Step 8: result
  return { success: true, message };
}

/** Step 2: threshold menu → number of days, or null on cancel/dismiss. */
async function runThresholdMenu(select: SelectFn): Promise<number | null> {
  const choice = await select("Archive documents older than:", [
    "7 days",
    "3 days",
    "1 day",
    "Cancel",
  ]);
  if (!choice || choice === "Cancel") return null;
  if (choice.startsWith("7")) return 7;
  if (choice.startsWith("3")) return 3;
  if (choice.startsWith("1")) return 1;
  return null; // unknown value → treat as cancel
}

/** Step 4: renders the dry-run preview markdown (no history-only stats). */
function renderPreview(
  ctx: ArchiveCtx,
  targets: ArchiveTarget[],
  totalBytes: number,
  config: PipelineConfig,
): void {
  if (typeof ctx.ui?.content !== "function") return;
  const dest = resolveArchiveDestDir(config.archiveDest); // display only
  const lines = targets.slice(0, PREVIEW_LINE_LIMIT).map((t) => `- ${t.relPath}`);
  const overflow = targets.length > PREVIEW_LINE_LIMIT
    ? `\n- … and ${targets.length - PREVIEW_LINE_LIMIT} more`
    : "";
  try {
    ctx.ui.content!(
      [
        `## Archive dry-run preview`,
        ``,
        `**Files**: ${targets.length}`,
        `**Total size**: ${formatBytes(totalBytes)}`,
        `**Destination**: ${dest.relDisplay}`,
        ``,
        ...lines,
        overflow,
      ].join("\n"),
    );
  } catch {
    // content write failure is non-blocking (summary still shows in the menu)
  }
}

/** Step 5: action menu → "move" | "delete" | null (cancel). */
async function runActionMenu(
  select: SelectFn,
  ui: ArchiveCtx["ui"],
  fileCount: number,
  days: number,
): Promise<{ action: "move" | "delete" } | null> {
  ui?.notify?.(`${fileCount} file(s) older than ${days} day(s) selected.`);
  const choice = await select("Choose archive action:", [
    "Move to zip",
    "Delete permanently",
    "Cancel",
  ]);
  if (!choice || choice === "Cancel") return null;
  if (choice.startsWith("Move")) return { action: "move" };
  if (choice.startsWith("Delete")) return { action: "delete" };
  return null;
}

/** Step 6: second confirm via ui.confirm, else an equivalent Yes/No select. */
async function runSecondConfirm(
  ctx: ArchiveCtx,
  fileCount: number,
  action: string,
): Promise<boolean> {
  if (typeof ctx.ui?.confirm === "function") {
    const confirm = ctx.ui.confirm as ConfirmFn;
    try {
      const ok = await confirm(`Confirm ${action} for ${fileCount} file(s)?`);
      // Only an explicit true counts as confirmation (default-cancel semantics)
      return ok === true;
    } catch {
      return false;
    }
  }
  if (typeof ctx.ui?.select !== "function") return false;
  const select = ctx.ui.select as SelectFn;
  const choice = await select(`Confirm ${action} for ${fileCount} file(s)?`, ["Yes", "No"]);
  return choice === "Yes";
}

/** Step 7a: "Move to zip" execution; never deletes sources on failure. */
async function executeMove(
  ctx: ArchiveCtx,
  config: PipelineConfig,
  execFn: ExecFn | undefined,
  targets: ArchiveTarget[],
  days: number,
): Promise<string> {
  if ((await probeZipAvailable(execFn)) === false) {
    ctx.ui?.notify?.("System zip command unavailable; no files were changed.");
    await safeWriteAuditLog("pipeline_archive_zip_unavailable", {
      action: "move",
      thresholdDays: String(days),
      fileCount: String(targets.length),
    }, "error");
    return "System zip command unavailable; no files were changed.";
  }

  try {
    // 207: deterministic zip path (millisecond timestamp + optional
    // archiveNameSuffix) + fail-closed availability check — an existing
    // target throws here and lands in the catch below (error audit, no zip,
    // no source deletion).
    const dest = await ensureArchiveDestDir(config.archiveDest);
    const zipAbs = buildArchiveZipPath(dest.absDir, config.archiveNameSuffix);
    await assertZipPathAvailable(zipAbs);
    const zipResult = await createArchiveZip(execFn, config, zipAbs, targets);
    if (!zipResult.ok) {
      ctx.ui?.notify?.(`Zip failed; no files were deleted: ${zipResult.error}`);
      await safeWriteAuditLog("pipeline_archive_error", {
        action: "move",
        thresholdDays: String(days),
        fileCount: String(targets.length),
        zipPath: zipResult.zipAbsPath,
        error: zipResult.error ?? "zip failed without error detail",
      }, "error");
      return `Zip failed; no files were deleted: ${zipResult.error}`;
    }
    const deletion = await deleteArchiveTargets(config, targets, collectScopeRoots(config));
    await emitExecutedAudit("move", days, targets, zipResult.zipAbsPath, deletion);
    return finishWithDeletionReport(ctx, "move", targets, zipResult.zipAbsPath, deletion);
  } catch (err) {
    return reportExecutionError(ctx, "move", days, targets.length, err);
  }
}

/** Step 7b: "Delete permanently" execution. */
async function executeDelete(
  ctx: ArchiveCtx,
  config: PipelineConfig,
  targets: ArchiveTarget[],
  days: number,
): Promise<string> {
  try {
    const deletion = await deleteArchiveTargets(config, targets, collectScopeRoots(config));
    await emitExecutedAudit("delete", days, targets, undefined, deletion);
    return finishWithDeletionReport(ctx, "delete", targets, undefined, deletion);
  } catch (err) {
    return reportExecutionError(ctx, "delete", days, targets.length, err);
  }
}

/** Shared executed-audit emission (single shape for both actions). */
async function emitExecutedAudit(
  action: "move" | "delete",
  days: number,
  targets: ArchiveTarget[],
  zipPath: string | undefined,
  deletion: { deleted: number; removedDirs: number; errors: string[] },
): Promise<void> {
  await safeWriteAuditLog("pipeline_archive_executed", {
    action,
    thresholdDays: String(days),
    fileCount: String(targets.length),
    ...(zipPath !== undefined ? { zipPath } : {}),
    deleted: String(deletion.deleted),
    removedDirs: String(deletion.removedDirs),
    errors: String(deletion.errors.length),
  });
}

/**
 * Produces the user-facing completion message and notifies about deletion
 * errors when present (full-fidelity report even on partial failures).
 */
function finishWithDeletionReport(
  ctx: ArchiveCtx,
  action: "move" | "delete",
  targets: ArchiveTarget[],
  zipPath: string | undefined,
  deletion: { deleted: number; removedDirs: number; errors: string[] },
): string {
  if (deletion.errors.length > 0) {
    ctx.ui?.notify?.(`Deletion errors: ${deletion.errors[0]} (+${deletion.errors.length - 1} more)`);
    return zipPath !== undefined
      ? `Archived to ${zipPath}; ${deletion.errors.length} deletion error(s).`
      : `Deleted ${deletion.deleted}/${targets.length} file(s); ${deletion.errors.length} failed.`;
  }
  return zipPath !== undefined
    ? `Archived ${targets.length} file(s) to ${zipPath}; sources were removed.`
    : `Deleted ${deletion.deleted} file(s).`;
}

/** Shared error path: error-grade audit with full context + notify (no crash). */
async function reportExecutionError(
  ctx: ArchiveCtx,
  action: "move" | "delete",
  days: number,
  fileCount: number,
  err: unknown,
): Promise<string> {
  const message = err instanceof Error ? err.message : String(err);
  await safeWriteAuditLog("pipeline_archive_error", {
    action,
    thresholdDays: String(days),
    fileCount: String(fileCount),
    error: message,
  }, "error");
  ctx.ui?.notify?.(`Archive action failed: ${message}.`);
  return `Archive action failed: ${message}.`;
}

/**
 * Derives the scope roots that bound empty-directory pruning: the union of
 * `archiveDirs` entries + the constant `.pi/audit` root (single source: the
 * scanner's {@link archiveScopeRoots}). Scope roots themselves are never
 * removed by `deleteArchiveTargets`.
 */
function collectScopeRoots(config: PipelineConfig): string[] {
  return archiveScopeRoots(config);
}
