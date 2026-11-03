/**
 * @module core/archive/scanner
 * 206 Phase 3: archive scan engine — scope resolution, recursive traversal,
 * time-threshold filtering and active-pipeline-document protection.
 *
 * Contract (206_Feat final decision matrix):
 * - Scan scope = `archive.dirs` (project-relative) + the CONSTANT `.pi/audit`.
 * - Recursive traversal of ALL file types (no extension filter, `history/`
 *   NOT excluded).
 * - Strict time comparison: `now - mtime > thresholdDays * 86_400_000` —
 *   a file exactly N days old is NOT archived; N days + 1ms is.
 * - Active pipeline protection: the current `requirementDoc` and its
 *   same-base Plan/Commit/Design_Review/Code_Review documents are never
 *   collected, so a running pipeline's deliverables survive archiving.
 * - Symlinks are skipped silently (defensive: `zip`/`rm` follow/side-effect
 *   behavior on links is platform-dependent; archiving must not mutate or
 *   duplicate link targets).
 * - Read-only: scanning never mutates the filesystem (writes live in runner.ts).
 *
 * 222 review issues 1/5 (added to the contract above):
 * - The resolved `jobsDir` subtree is never scanned or deleted — job files are
 *   user-maintained, even when the configured `designDir`/`reviewDir` contains
 *   that directory.
 * - A scope covered by another scope is pruned, so a file is collected once and
 *   `totalBytes` matches the logical file set.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { PipelineConfig } from "../../types";
import { DEFAULT_JOBS_DIR } from "../../constants";
import { docsDirsOf, normalizeDocsDir } from "../../docs-paths";
import { resolveAuditDir } from "../../utils/work-dir";
import { reqBaseFromRequirementDoc } from "../naming/doc-naming";

/** One resolved scan scope directory. */
export interface ArchiveScope {
  /** Absolute directory path. */
  absDir: string;
  /** Display path (project-relative when known, otherwise the absolute path). */
  relDir: string;
}

/**
 * Synchronous list of ALL scope roots as ABSOLUTE paths (no fs probing).
 * Used by the delete step to bound empty-directory pruning and mirrors the
 * deduped `archiveDirs + .pi/audit` union resolved by {@link resolveArchiveScope}.
 *
 * 222 review issue 1: the resolved `jobsDir` is appended as a PROTECTED root as
 * well. Pruning walks upward and stops at any root, so a jobs directory that
 * nests under an archive root (`docs.designDir = "docs"` → `docs/jobs`) is
 * preserved even when every file inside it is gone.
 */
export function archiveScopeRoots(config: PipelineConfig): string[] {
  const dirRels = [...(config.archiveDirs ?? []), resolveAuditDir({ auditDir: config.auditDir, piWorkDir: config.piWorkDir })];
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const dirRel of dirRels) {
    const abs = path.isAbsolute(dirRel) ? dirRel : path.resolve(config.projectRoot, dirRel);
    if (seen.has(abs)) continue;
    seen.add(abs);
    roots.push(abs);
  }
  const jobsAbs = resolveJobsDirAbs(config);
  if (!seen.has(jobsAbs)) roots.push(jobsAbs);
  return roots;
}

/**
 * Absolute path of the resolved `jobsDir` (222 review issue 1).
 *
 * `jobsDir` is user-maintained: `/pipeline-auto` job YAML files must never be
 * archived, zipped or deleted. The archive scope already avoids it indirectly
 * (tier 3 is `[designDir, reviewDir]`), but that guarantee collapses as soon as
 * the resolved jobs directory nests under one of them — a legitimate layout
 * such as `docs.designDir = "docs"` puts `docs/jobs` inside the scan root. Both
 * the scanner and the prune boundary therefore exclude this path directly.
 *
 * Mirrors the docs-directory validation: an unusable configured value (absolute
 * / traversal / root) falls back to the built-in default, so this guard can
 * never widen the protected set unintentionally.
 */
export function resolveJobsDirAbs(config: PipelineConfig): string {
  const raw = docsDirsOf(config).jobsDir;
  const normalized = normalizeDocsDir(raw);
  const jobsRel = normalized.value ?? DEFAULT_JOBS_DIR;
  return path.isAbsolute(jobsRel) ? jobsRel : path.resolve(config.projectRoot, jobsRel);
}

/**
 * True when `absPath` is `dirAbs` itself or lives inside it (path-segment safe).
 * Shared with the delete step so scanning and deletion agree on the boundary.
 */
export function isInsideDir(absPath: string, dirAbs: string): boolean {
  const rel = path.relative(dirAbs, absPath);
  return rel.length === 0 || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolves the archive scan scope: every configured `archive.dirs` entry
 * plus the constant `.pi/audit` audit directory (always included, per
 * 206_Feat). Duplicated absolute paths are deduped; entries that do not
 * exist on disk are dropped (the result's missingDirs reports them to the
 * caller for audit) — scanning never throws on missing directories.
 *
 * 222 review issue 5: a scope that is ALREADY covered by another scope (a child
 * of a kept root) is pruned. `archive.dirs` is user-written and 222's tier 3
 * (`[designDir, reviewDir]`) makes nesting a one-line legal configuration
 * (`docs.designDir = "docs"` + `docs.reviewDir = "docs/review"`); keeping both
 * made every file under the child scope a DUPLICATE target — `totalBytes` was
 * counted twice, `zip` received the same relPath twice, and the second delete
 * reported ENOENT as a user-visible failure.
 *
 * 222 review issue 1: the resolved `jobsDir` subtree is removed from the scope
 * as well (see {@link resolveJobsDirAbs}), so no walk can ever reach a
 * `/pipeline-auto` job file.
 */
export async function resolveArchiveScope(config: PipelineConfig): Promise<{
  scopes: ArchiveScope[];
  missingDirs: string[];
}> {
  const configDirs = [...(config.archiveDirs ?? [])];
  configDirs.push(resolveAuditDir({ auditDir: config.auditDir, piWorkDir: config.piWorkDir }));
  const jobsAbs = resolveJobsDirAbs(config);

  const scopes: ArchiveScope[] = [];
  const missingDirs: string[] = [];
  const seenAbs = new Set<string>();
  for (const dirRel of configDirs) {
    const absDir = path.resolve(
      path.isAbsolute(dirRel) ? dirRel : path.join(config.projectRoot, dirRel),
    );
    if (seenAbs.has(absDir)) continue;
    seenAbs.add(absDir);
    // A jobs directory is never a scan scope, and neither is one of its
    // ancestors' leftovers: the subtree is excluded during the walk.
    if (isInsideDir(absDir, jobsAbs)) continue;
    try {
      const stat = await fsp.stat(absDir);
      if (!stat.isDirectory()) continue;
      const relInside = path.relative(config.projectRoot, absDir);
      const relDir = relInside.startsWith("..") || path.isAbsolute(relInside)
        ? absDir
        : relInside.split(path.sep).join("/");
      scopes.push({ absDir, relDir });
    } catch {
      missingDirs.push(dirRel);
    }
  }

  // Review issue 5: drop any scope whose files are already reachable from a
  // kept scope. Iterating in configured order keeps the FIRST (most specific
  // intent) entry, and a parent added later still prunes its earlier children.
  const pruned = scopes.filter(
    (scope) => !scopes.some((other) => other !== scope && isStrictParent(other.absDir, scope.absDir)),
  );
  return { scopes: pruned, missingDirs };
}

/** True when `childAbs` lives strictly INSIDE `parentAbs`. */
function isStrictParent(parentAbs: string, childAbs: string): boolean {
  return parentAbs !== childAbs && isInsideDir(childAbs, parentAbs);
}

/** One file collected for archiving. */
export interface ArchiveTarget {
  /** Project-relative (or absolute, for out-of-project scopes) path. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  /** File size in bytes (for the dry-run preview). */
  sizeBytes: number;
  /** Modification time (ms) — targets are sorted ascending (oldest first). */
  mtimeMs: number;
}

/** Result of a full archive scan. */
export interface ArchiveScanResult {
  /** Files older than the threshold, oldest first. */
  targets: ArchiveTarget[];
  /** Sum of target sizes (bytes). */
  totalBytes: number;
  /** Scope directories that were configured but missing (for audit). */
  missingDirs: string[];
  /** Count of files skipped by active-pipeline-document protection. */
  skippedActive: number;
  /**
   * 222 review issue 1: count of files skipped because they live in the
   * resolved `jobsDir` subtree (user-maintained `/pipeline-auto` job files).
   * Reported in the archive audit so an excluded subtree is visible, not
   * silent.
   */
  skippedJobs: number;
}

/**
 * Determines whether `relPath` is the active pipeline's requirement document
 * or one of its same-base derived documents (Plan / Develop_Commit /
 * Design_Review report / Code_Review report).
 *
 * Re-uses the authoritative naming derivation from `doc-naming.ts`; never
 * re-types naming regexes here.
 *
 * @param relPath - Candidate relative path (posix separators)
 * @param activeDoc - Active requirementDoc (meta) or undefined/empty
 */
export function isActivePipelineDoc(relPath: string, activeDoc: string | undefined): boolean {
  if (!activeDoc || activeDoc.length === 0) return false;
  if (relPath === activeDoc || path.basename(relPath) === path.basename(activeDoc)) {
    return true;
  }
  const relBase = reqBaseFromRequirementDoc(activeDoc);
  if (!relBase) return false;
  const name = path.basename(relPath);
  const cases = [
    `${relBase}_Plan.md`,
    `${relBase}_Develop_Commit.md`,
    // Design review: Design_Review_{round}_{base}_Design.md
    new RegExp(`^Design_Review_\\d+_${escapeRegExp(relBase)}_Design\\.md$`, "i"),
    // Code review: Code_Review_{base}_Develop_Commit_{n}.md
    new RegExp(`^Code_Review_${escapeRegExp(relBase)}_Develop_Commit_\\d+\\.md$`, "i"),
    // Standalone update receipts: Design_Review_Update_{round}_{opId}_{base}_Design.md
    new RegExp(`^Design_Review_Update_\\d+_.+_${escapeRegExp(relBase)}\\.md$`, "i"),
  ];
  for (const pattern of cases) {
    if (pattern instanceof RegExp ? pattern.test(name) : name.toLowerCase() === pattern.toLowerCase()) {
      return true;
    }
  }
  return false;
}

/** Escapes a string for safe embedding into a RegExp source. */
function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Day threshold in milliseconds (86_400_000 per day).
 * Kept as an exported constant so tests can mirror the exact boundary math.
 */
export const MS_PER_DAY = 86_400_000;

/**
 * Recursively collects archive targets older than `thresholdDays`
 * (strict `>` comparison against wall-clock mtime, per 206_Feat Round 4/5).
 *
 * - All file types participate (no extension filter).
 * - `history/` subdirectories participate (NOT excluded — 方案 B).
 * - Symlinks are skipped silently (see module header).
 * - Active-pipeline documents (see {@link isActivePipelineDoc}) are skipped
 *   and counted in `skippedActive`.
 * - The resolved `jobsDir` subtree is never entered, and is counted in
 *   `skippedJobs` when such a directory/file is encountered (222 review issue
 *   1 — `/pipeline-auto` job files are user-maintained and must never be
 *   archived or deleted, even when `designDir` / `reviewDir` contains them).
 * - Nested scopes are pruned upstream ({@link resolveArchiveScope}), so a file
 *   is collected at most once.
 * - Result is sorted by mtime ascending (oldest first — preview-friendly).
 */
export async function collectArchiveTargets(
  config: PipelineConfig,
  thresholdDays: number,
  activeDoc: string | undefined,
  now: number = Date.now(),
): Promise<ArchiveScanResult> {
  const { scopes, missingDirs } = await resolveArchiveScope(config);
  const jobsAbs = resolveJobsDirAbs(config);
  const cutoffMs = thresholdDays * MS_PER_DAY;
  const targets: ArchiveTarget[] = [];
  let skippedActive = 0;
  let skippedJobs = 0;
  let totalBytes = 0;

  for (const scope of scopes) {
    await walk(scope.absDir, scope);
  }

  async function walk(absDir: string, scope: ArchiveScope): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory → fail-open (skip silently)
    }
    for (const entry of entries) {
      const childAbs = path.join(absDir, entry.name);
      if (entry.isSymbolicLink()) {
        continue; // defensive: never archive/follow symlinks (see module header)
      }
      // Review issue 1: the jobs subtree is excluded BEFORE any recursion, so a
      // nested `docs/jobs` inside `docs/` (designDir="docs") is untouchable.
      if (isInsideDir(childAbs, jobsAbs)) {
        if (entry.isDirectory()) {
          skippedJobs += await countFiles(childAbs);
        } else if (entry.isFile()) {
          skippedJobs++;
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walk(childAbs, scope);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const stat = await fsp.stat(childAbs);
        if (now - stat.mtimeMs <= cutoffMs) continue; // strict > comparison
        const relInside = path.relative(config.projectRoot, childAbs);
        const relPath = relInside.startsWith("..") || path.isAbsolute(relInside)
          ? childAbs
          : relInside.split(path.sep).join("/");
        if (isActivePipelineDoc(relPath, activeDoc)) {
          skippedActive++;
          continue;
        }
        targets.push({ relPath, absPath: childAbs, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
        totalBytes += stat.size;
      } catch {
        // stat race (file removed mid-scan) → skip silently
      }
    }
  }

  // Oldest first (stable sort by mtime)
  targets.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return { targets, totalBytes, missingDirs, skippedActive, skippedJobs };
}

/**
 * Counts regular files under `absDir` (recursively) for the `skippedJobs`
 * statistic. Best-effort: unreadable directories and mid-scan races are
 * ignored — the count feeds the audit only, it never gates archiving.
 */
async function countFiles(absDir: string): Promise<number> {
  let entries;
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      count += await countFiles(path.join(absDir, entry.name));
    } else if (entry.isFile()) {
      count++;
    }
  }
  return count;
}
