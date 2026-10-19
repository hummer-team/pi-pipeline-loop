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
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { PipelineConfig } from "../../types";
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
 * Resolves the archive scan scope: every configured `archive.dirs` entry
 * plus the constant `.pi/audit` audit directory (always included, per
 * 206_Feat). Duplicated absolute paths are deduped; entries that do not
 * exist on disk are dropped (the result's missingDirs reports them to the
 * caller for audit) — scanning never throws on missing directories.
 */
export async function resolveArchiveScope(config: PipelineConfig): Promise<{
  scopes: ArchiveScope[];
  missingDirs: string[];
}> {
  const configDirs = [...(config.archiveDirs ?? [])];
  configDirs.push(resolveAuditDir({ auditDir: config.auditDir, piWorkDir: config.piWorkDir }));

  const scopes: ArchiveScope[] = [];
  const missingDirs: string[] = [];
  const seenAbs = new Set<string>();
  for (const dirRel of configDirs) {
    const absDir = path.isAbsolute(dirRel) ? dirRel : path.join(config.projectRoot, dirRel);
    if (seenAbs.has(absDir)) continue;
    seenAbs.add(absDir);
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
  return { scopes, missingDirs };
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
 * - Result is sorted by mtime ascending (oldest first — preview-friendly).
 */
export async function collectArchiveTargets(
  config: PipelineConfig,
  thresholdDays: number,
  activeDoc: string | undefined,
  now: number = Date.now(),
): Promise<ArchiveScanResult> {
  const { scopes, missingDirs } = await resolveArchiveScope(config);
  const cutoffMs = thresholdDays * MS_PER_DAY;
  const targets: ArchiveTarget[] = [];
  let skippedActive = 0;
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
  return { targets, totalBytes, missingDirs, skippedActive };
}
