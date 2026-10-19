/**
 * @module core/archive/runner
 * 206 Phase 3: archive execution engine — zip-name/timestamp formatting,
 * destination resolution, deterministic zip path construction, system-`zip`
 * invocation (zero new dependencies, 206_Feat Q7-A) and deletion with
 * empty-directory pruning.
 *
 * 207 naming contract (replaces the 206 ten-millisecond digit and the
 * `_1`/`_2` collision probing previously done by the unique-path allocator):
 * - `formatArchiveTimestamp` emits milliseconds: `yyyy_MM_dd_HHmmssSSS`
 *   (local timezone, 9-digit tail). Two archives in the same clock second
 *   now produce distinct names, and the zip path is built deterministically.
 * - Optional `archiveNameSuffix` (from `archive.namesuffix`) is sanitized via
 *   {@link sanitizeArchiveName} and appended as `_{suffix}` when non-empty.
 * - The built path is checked ONCE via {@link assertZipPathAvailable};
 *   an existing target FAILS CLOSED (no zip, no source deletion) and the
 *   command layer writes the error audit.
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
 * Formats a Date into the archive timestamp `yyyy_MM_dd_HHmmssSSS`.
 *
 * 207: millisecond precision (the 206 ten-millisecond digit `s` is replaced
 * by the full 3-digit millisecond tail `SSS`), local timezone, 9-digit tail.
 * Example: 2026-10-19 14:25:07.420 → `"2026_10_19_142507420"`.
 */
export function formatArchiveTimestamp(d: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${d.getFullYear()}_${p2(d.getMonth() + 1)}_${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}${ms}`;
}

/**
 * 207: Characters/carrier-runs that must never appear in an archive zip
 * file name. Includes whitespace, path separators (`/`, `\`) — this also
 * blocks `../` traversal — and Windows-reserved characters plus control chars.
 */
const UNSAFE_ARCHIVE_NAME_RE = /[\s/\\:*?"<>|\u0000-\u001F\u007F]+/g;

/**
 * 207: Sanitizes a raw archive name suffix into a filesystem-safe fragment.
 *
 * Rules (207_Feat Round 5 Q3):
 * - trim, then replace every unsafe run (whitespace, `/`, `\`, `:*?"<>|`,
 *   control chars) with a single `-`, collapsing consecutive `-` runs;
 * - strip leading/trailing `.` and `-` (twice — replacing unsafe runs can
 *   expose new edge runs);
 * - cap at 64 code points;
 * - a result that ends up empty means "no suffix" (caller must fall back to
 *   the plain `{timestamp}_pipeline` name).
 */
export function sanitizeArchiveName(raw: string): string {
  const collapsed = raw.trim().replace(UNSAFE_ARCHIVE_NAME_RE, "-").replace(/-+/g, "-");
  const trimmed = collapsed.replace(/^[.-]+|[.-]+$/g, "");
  const capped = Array.from(trimmed).slice(0, 64).join("");
  return capped.replace(/^[.-]+|[.-]+$/g, "");
}

/**
 * Builds the zip base name for the archive run:
 * `{timestamp}_pipeline` — or `{timestamp}_pipeline_{suffix}` when the
 * sanitized `nameSuffix` (207) is non-empty. `d` stays the first parameter
 * for compatibility with existing callers/tests.
 */
export function buildArchiveZipName(d: Date = new Date(), nameSuffix?: string): string {
  const base = `${formatArchiveTimestamp(d)}_pipeline`;
  const suffix = sanitizeArchiveName(nameSuffix ?? "");
  return suffix.length > 0 ? `${base}_${suffix}` : base;
}

/**
 * 207: Builds the deterministic archive zip path for the run. No collision
 * probing — an existing target is handled fail-closed by
 * {@link assertZipPathAvailable} (call right before zip creation).
 */
export function buildArchiveZipPath(
  destDirAbs: string,
  nameSuffix?: string,
  d: Date = new Date(),
): string {
  return path.join(destDirAbs, `${buildArchiveZipName(d, nameSuffix)}.zip`);
}

/**
 * 207: Fail-closed existence check for the resolved zip path.
 *
 * - Path does not exist (including broken-symlink, via `stat` semantics) →
 *   resolves normally.
 * - Path exists (file or directory) → throws `/already exists/`.
 * - Any other stat error (`EACCES`/`EPERM`/`ENOTDIR`/…) is rethrown as-is —
 *   the command layer audits and aborts; nothing is silently swallowed.
 */
export async function assertZipPathAvailable(zipAbsPath: string): Promise<void> {
  try {
    await fsp.stat(zipAbsPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw err; // EACCES/EPERM/ENOTDIR … → command layer audits and aborts
  }
  throw new Error(`Archive path already exists: ${zipAbsPath}`);
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
