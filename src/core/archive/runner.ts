/**
 * @module core/archive/runner
 * 206 Phase 3: archive execution engine — zip-name/timestamp formatting,
 * destination resolution, unique-path allocation, system-`zip` invocation
 * (zero new dependencies, 206_Feat Q7-A) and deletion with empty-directory
 * pruning.
 *
 * Failure contract (206_Feat Round 6 / hard constraints):
 * - `createArchiveZip` NEVER deletes source files; the command layer deletes
 *   sources via {@link deleteArchiveTargets} ONLY after a verified-successful zip.
 * - Any zip batch failure aborts immediately with `{ ok: false }`.
 * - All fs mutation happens ONLY in this module (scanner + command layer stay clean).
 */

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecFn, PipelineConfig } from "../../types";
import { DEFAULT_ARCHIVE_DEST } from "../../constants";

/**
 * Formats a Date into the archive timestamp `yyyy_MM_dd_HHmmsss`.
 *
 * The trailing triple `s` segment is intentional and comes verbatim from the
 * locked 206_Feat requirement («命名 yyyy_MM_dd_HHmmsss_pipeline.zip»): the
 * last group is TWO-digit seconds PLUS one extra digit encoding
 * `Math.floor(milliseconds / 100)` (0–9). So `HH`/`mm`/`ss`/`s` — THREE
 * `s` characters total in the mask. Preserved bit-for-bit so existing zip
 * names remain grep-able.
 */
export function formatArchiveTimestamp(d: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const tenthSecond = Math.floor(d.getMilliseconds() / 100);
  return `${d.getFullYear()}_${p2(d.getMonth() + 1)}_${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}${tenthSecond}`;
}

/** Builds the zip base name for the archive run: `yyyy_MM_dd_HHmmsss_pipeline`. */
export function buildArchiveZipName(d: Date = new Date()): string {
  return `${formatArchiveTimestamp(d)}_pipeline`;
}

/**
 * Result of resolving the archive destination directory.
 * `relDisplay` is a user-facing path for previews (absolute form).
 */
export interface ArchiveDest {
  /** Absolute destination directory (parent of the zip file). */
  absDir: string;
  /** User-facing display value (always absolute for preview clarity). */
  relDisplay: string;
}

/**
 * Resolves the archive landing directory (206_Feat Round 4 Q1):
 * - `~`-prefixed → expanded via `os.homedir()`
 * - absolute → used as-is
 * - relative (default) → resolved against `os.homedir()`
 * Invalid values (empty, or containing a suspicious `..` segment) warn and
 * fall back to `DEFAULT_ARCHIVE_DEST`. No `mkdir` here — the caller invokes
 * {@link ensureArchiveDestDir} right before execution.
 */
export function resolveArchiveDestDir(dest: string | undefined): ArchiveDest {
  let value = dest && dest.trim().length > 0 ? dest.trim() : DEFAULT_ARCHIVE_DEST;
  if (path.isAbsolute(value)) {
    return { absDir: value, relDisplay: value };
  }
  if (value === ".." || value.includes("../") || value.includes("..\\") || value.split("/").some((s) => s === "..")) {
    console.warn(
      `[pi-pipeline] Invalid archive.dest "${value}" — contains ".." segment, falling back to "${DEFAULT_ARCHIVE_DEST}"`,
    );
    value = DEFAULT_ARCHIVE_DEST;
  }
  const expanded = value === "~" || value.startsWith("~/")
    ? value.replace(/^~/, os.homedir())
    : path.join(os.homedir(), value);
  return { absDir: expanded, relDisplay: expanded };
}

/** Creates the archive destination directory (recursive) before execution. */
export async function ensureArchiveDestDir(dest: string | undefined): Promise<ArchiveDest> {
  const resolved = resolveArchiveDestDir(dest);
  await fsp.mkdir(resolved.absDir, { recursive: true });
  return resolved;
}

/**
 * Allocates a non-colliding zip path: when `{dir}/{base}.zip` already exists,
 * `pipeline_1.zip`, `pipeline_2.zip`, … (inserted before the extension).
 */
export async function uniqueZipPath(destDirAbs: string, baseName: string): Promise<string> {
  const first = path.join(destDirAbs, `${baseName}.zip`);
  let exists = true;
  try {
    await fsp.access(first);
  } catch {
    exists = false;
  }
  if (!exists) return first;
  for (let i = 1; i < 100_000; i++) {
    const candidate = path.join(destDirAbs, `${baseName}_${i}.zip`);
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  }
  // Defensive cap (never hit in practice)
  return path.join(destDirAbs, `${baseName}_${Date.now()}.zip`);
}

/**
 * Maximum accumulated argv characters per zip batch.
 * Keeps each invocation well below the OS argv limit (~2 MB on macOS,
 * ~2 MB Linux ARG_MAX for args+env); 80 KB leaves a large safety margin.
 */
export const MAX_ARG_CHARS = 80_000;

/** Result of a zip run. */
export interface ZipRunResult {
  /** true only when every batch succeeded AND the zip file is non-empty. */
  ok: boolean;
  /** Absolute zip path (may not exist when ok=false). */
  zipAbsPath: string;
  /** First failing exit code (when the process was spawned). */
  code?: number;
  /** Human-readable failure detail (when ok=false). */
  error?: string;
}

/**
 * Probes whether the system `zip` command is usable.
 * No execFn (tests / no pi host) → false. A `code === 0` on `zip -h` counts
 * as available; any exception also resolves to false (never throws).
 */
export async function probeZipAvailable(execFn?: ExecFn): Promise<boolean> {
  if (!execFn) return false;
  try {
    const result = await execFn("zip", ["-h"], process.cwd());
    return result.code === 0;
  } catch {
    return false;
  }
}

/** POSIX-ifies a project-relative path for zip argv usage. */
function toPosixRel(rel: string): string {
  return rel.replace(/\\/g, "/");
}

/**
 * Creates the archive zip under `zipAbsPath` from `targets` using the system
 * `zip` command with batched argv (see MAX_ARG_CHARS):
 *
 * - Batch 1 creates the archive (`zip -q -X <zip> <rel...>`); later batches
 *   append to it (zip's default add behavior).
 * - cwd is `config.projectRoot`, so relPaths are embedded project-relative.
 * - ANY failing batch returns `{ ok: false }` immediately — SOURCE FILES ARE
 *   NEVER TOUCHED (deletion is the command layer's explicit post-success step).
 * - After success the zip file must exist with size > 0 (empty-archive guard).
 */
export async function createArchiveZip(
  execFn: ExecFn | undefined,
  config: PipelineConfig,
  zipAbsPath: string,
  targets: Array<{ relPath: string }>,
): Promise<ZipRunResult> {
  if (!execFn) {
    return { ok: false, zipAbsPath, error: "zip exec unavailable" };
  }
  if (targets.length === 0) {
    return { ok: false, zipAbsPath, error: "no targets to archive" };
  }

  // Batch relPaths by accumulated argv budget
  const batches: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const target of targets) {
    const rel = toPosixRel(target.relPath);
    if (current.length > 0 && currentChars + rel.length + 1 > MAX_ARG_CHARS) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(rel);
    currentChars += rel.length + 1;
  }
  if (current.length > 0) batches.push(current);

  for (const batch of batches) {
    let result;
    try {
      result = await execFn(
        "zip",
        ["-q", "-X", zipAbsPath, ...batch],
        config.projectRoot,
      );
    } catch (err) {
      return {
        ok: false,
        zipAbsPath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (result.code !== 0) {
      return {
        ok: false,
        zipAbsPath,
        code: result.code,
        error: result.stderr.trim() || result.stdout.trim() || `zip exited with code ${result.code}`,
      };
    }
  }

  // Post-check: zip file must exist and be non-empty
  try {
    const stat = await fsp.stat(zipAbsPath);
    if (stat.size <= 0) {
      return { ok: false, zipAbsPath, error: "zip file is empty after creation" };
    }
  } catch (err) {
    return {
      ok: false,
      zipAbsPath,
      error: `zip file missing after creation: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, zipAbsPath };
}

/** Result of the delete step (with empty-directory pruning). */
export interface DeleteRunResult {
  /** Files actually deleted. */
  deleted: number;
  /** Empty directories removed (scope roots are NEVER removed). */
  removedDirs: number;
  /** Per-file error messages (deletion continues past individual failures). */
  errors: string[];
}

/**
 * Deletes `targets` from disk, then prunes now-empty parent directories —
 * BUT NEVER past the corresponding scope root (an `archive.dirs` root or the
 * `.pi/audit` root itself is preserved even when emptied).
 *
 * Individual failures are recorded and do not stop the remaining deletions.
 */
export async function deleteArchiveTargets(
  config: PipelineConfig,
  targets: Array<{ absPath: string }>,
  scopeRootsAbs: string[],
): Promise<DeleteRunResult> {
  const result: DeleteRunResult = { deleted: 0, removedDirs: 0, errors: [] };

  for (const target of targets) {
    try {
      await fsp.rm(target.absPath, { force: false });
      result.deleted++;
      result.removedDirs += await pruneEmptyDirs(target.absPath, scopeRootsAbs);
    } catch (err) {
      result.errors.push(
        `${target.absPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}

/**
 * Walks upward from the just-deleted file, removing directories that became
 * empty, stopping BEFORE any scope root (roots themselves are never removed).
 * Returns the number of directories removed.
 */
async function pruneEmptyDirs(
  filePath: string,
  scopeRootsAbs: string[],
): Promise<number> {
  let removed = 0;
  let dir = path.dirname(filePath);
  for (;;) {
    if (scopeRootsAbs.some((root) => path.resolve(root) === path.resolve(dir))) {
      break; // scope root boundary — never remove the root itself
    }
    try {
      const entries = await fsp.readdir(dir);
      if (entries.length > 0) break; // not empty → stop
      await fsp.rmdir(dir);
      removed++;
      const parent = path.dirname(dir);
      if (parent === dir) break; // filesystem root safety
      dir = parent;
    } catch {
      break; // unreadable / race → stop pruning silently
    }
  }
  return removed;
}
