/**
 * @module core/doc-discovery
 * 206 Phase 1: single-source "stage → doc directory resolver" and "candidate
 * document discovery" shared by the /pipeline-start doc-candidate menu (Phase 2)
 * and the archive fallback (Phase 4).
 *
 * Design goals:
 * - PURE read logic: no writes, no UI calls; only fs stat/readdir (read-only).
 * - DRY: the only implementation of candidate filtering — commands never
 *   re-implement per-stage file-name filters.
 * - Naming contract is reused from `core/naming/doc-naming.ts` (never re-typed).
 *
 * Reused naming constants/functions (206_Feat Round 3/4 decisions):
 * - `REQUIREMENT_DOC_FILE_RE`: `^\d+_.+\.md$` (requirement / design-und docs)
 * - `PLAN_DOC_FILE_RE`: `*_Plan.md` (file-name form of `PLAN_DOC_GLOB`)
 * - `NEW_COMMIT_RE`: `*_Develop_Commit.md` (file-name form of `NEW_COMMIT_DOC_GLOB`)
 * - `NEW_CODE_REVIEW_RE`: `^Code_Review_.+_Develop_Commit_\d+\.md$`
 * - `reqBaseFromRequirementDoc` for active-doc base derivation (Phase 3 usage).
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { PipelineConfig, PipelineStage } from "../types";
import {
  DEFAULT_STAGE_DOC_DIRS,
  MAX_DOC_CANDIDATES,
} from "../constants";
import {
  CODE_REVIEW_DOC_PREFIX,
  MD_FILE_EXTENSION_RE,
  NEW_CODE_REVIEW_RE,
  NEW_COMMIT_RE,
  PLAN_DOC_FILE_RE,
  REQUIREMENT_DOC_FILE_RE,
} from "./naming/doc-naming";

/**
 * One candidate document surfaced by the /pipeline-start doc menu.
 */
export interface DocCandidate {
  /** Project-relative path (what /pipeline-start accepts as `file`). */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Modification time (ms) — candidates are sorted by this, descending. */
  mtimeMs: number;
}

/**
 * Result of resolving the stage's candidate-doc directory.
 * - `autoMatched=true`: `docs.stageDirs` not configured for this stage;
 *   the built-in default directory was used.
 * - `autoMatched=false`: explicit user configuration took precedence.
 */
export interface StageDocDirResolution {
  /** Project-relative directory path. */
  dir: string;
  /** Whether the directory came from the built-in default (not user config). */
  autoMatched: boolean;
}

/**
 * Resolves the candidate-document directory for a stage (206 Phase 1 / 206_Feat
 * Round 2): explicit `config.docsStageDirs[stage]` wins; otherwise the
 * built-in `DEFAULT_STAGE_DOC_DIRS` map applies (falling back to `"docs"` for
 * stages without a default entry).
 */
export function resolveStageDocDir(
  config: PipelineConfig,
  stage: PipelineStage,
): StageDocDirResolution {
  const configured = config.docsStageDirs?.[stage];
  if (typeof configured === "string" && configured.length > 0) {
    return { dir: configured, autoMatched: false };
  }
  const fallback = DEFAULT_STAGE_DOC_DIRS[stage] ?? "docs";
  return { dir: fallback, autoMatched: true };
}

/**
 * Builds the per-stage candidate file-name filter (206_Feat Round 3 Q3-1 /
 * Q2-A decisions, 方案 A):
 *
 * - `clarify` / `plan`: requirement docs only — `^\d+_.+\.md$`, EXCLUDING
 *   `*_Plan.md` (plans are not requirement inputs) and `^Code_Review_`
 *   (review reports are never requirement inputs).
 * - `design-review` / `develop`: plan docs — `*_Plan.md` (file-name form of
 *   `PLAN_DOC_GLOB`).
 * - `review`: develop/fix commit docs — `*_Develop_Commit.md` (file-name form
 *   of `NEW_COMMIT_DOC_GLOB`).
 * - `fix`: code-review reports — `NEW_CODE_REVIEW_RE`
 *   (`^Code_Review_.+_Develop_Commit_\d+\.md$`).
 *
 * All other stages return a constant `false` (no candidates offered).
 *
 * The patterns are the authoritative `doc-naming.ts` definitions (never
 * re-typed here); requirement/plan matchers tolerate `.MD`, commit/code-review
 * matchers use the exact exported matchers from `doc-naming.ts`.
 */
export function stageDocCandidateFilter(stage: PipelineStage): (fileName: string) => boolean {
  switch (stage) {
    case "clarify":
    case "plan":
      // Q3-1 方案 A: requirement doc pattern minus Plan/Code_Review derivatives
      return (fileName: string) =>
        REQUIREMENT_DOC_FILE_RE.test(fileName)
        && !PLAN_DOC_FILE_RE.test(fileName)
        && !fileName.startsWith(CODE_REVIEW_DOC_PREFIX);
    case "design-review":
    case "develop":
      // *_Plan.md (file-name form of PLAN_DOC_GLOB)
      return (fileName: string) => PLAN_DOC_FILE_RE.test(fileName);
    case "review":
      // *_Develop_Commit.md (file-name form of NEW_COMMIT_DOC_GLOB)
      return (fileName: string) => NEW_COMMIT_RE.test(fileName);
    case "fix":
      // Code_Review_{reqBase}_Develop_Commit_{n}.md (NEW_CODE_REVIEW_RE)
      return (fileName: string) => NEW_CODE_REVIEW_RE.test(fileName);
    default:
      // awaiting_human / completed: no candidate documents
      return () => false;
  }
}

/**
 * Lists candidate documents for a stage from the stage's resolved directory.
 *
 * Scan contract (206_Feat Round 3 Q3-A / Round 5):
 * - Only the directory's DIRECT children (no recursion — `history/` is a
 *   subdirectory and is naturally excluded).
 * - Files only (`entry.isFile()`), `.md`/`.MD` extension, stage filter match.
 * - Looks only at file NAMES (mtime desc, capped at `limit`, default 5).
 * - Missing/unreadable directory → `[]` (fail-open, caller decides fallback).
 */
export async function listDocCandidates(
  config: PipelineConfig,
  stage: PipelineStage,
  limit: number = MAX_DOC_CANDIDATES,
): Promise<DocCandidate[]> {
  const { dir } = resolveStageDocDir(config, stage);
  const absDir = path.isAbsolute(dir) ? dir : path.join(config.projectRoot, dir);

  let entries;
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    // Directory missing / permission error → no candidates (fail-open)
    return [];
  }

  const filter = stageDocCandidateFilter(stage);
  const candidates: DocCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue; // subdirectories (e.g. history/) excluded
    if (!filter(entry.name)) continue;
    if (!MD_FILE_EXTENSION_RE.test(entry.name)) continue;
    const absPath = path.join(absDir, entry.name);
    try {
      const stat = await fsp.stat(absPath);
      candidates.push({
        relPath: isPathInsideProject(config.projectRoot, absDir)
          ? toProjectRelativeRelPath(config.projectRoot, absDir, entry.name)
          : path.join(absDir, entry.name),
        absPath,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // Stat failure (race) → skip this entry
    }
  }

  // Newest first, capped
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, limit);
}

/** True when `absDir` sits inside (or equals) the project root. */
function isPathInsideProject(projectRoot: string, absDir: string): boolean {
  const rel = path.relative(projectRoot, absDir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Builds the project-relative path "dir/file" with posix separators. */
function toProjectRelativeRelPath(projectRoot: string, absDir: string, fileName: string): string {
  const relDir = path.relative(projectRoot, absDir).split(path.sep).join("/");
  return relDir.length > 0 ? `${relDir}/${fileName}` : fileName;
}

/**
 * Finds the single newest candidate document for a stage (206_Feat Round 4
 * Q2-A / Q4-C — no-candidate fallback):
 *
 * Channel 1: stage dir direct children (`listDocCandidates(...,1)`).
 * Channel 2 (fallback): recursive scan across `config.archiveDirs`,
 * filtered by the stage filter, taking the globally newest one.
 *
 * Returns `null` when both channels are empty.
 */
export async function findLatestDocForStage(
  config: PipelineConfig,
  stage: PipelineStage,
): Promise<DocCandidate | null> {
  const channel1 = await listDocCandidates(config, stage, 1);
  if (channel1.length > 0) return channel1[0];

  const filter = stageDocCandidateFilter(stage);
  const scopeDirs = config.archiveDirs ?? [];
  let best: DocCandidate | null = null;
  for (const scopeDir of scopeDirs) {
    const absRoot = path.isAbsolute(scopeDir) ? scopeDir : path.join(config.projectRoot, scopeDir);
    const found = await newestMatchingRecursive(absRoot, scopeDir, config, filter);
    if (found && (best === null || found.mtimeMs > best.mtimeMs)) {
      best = found;
    }
  }
  return best;
}

/** Recursive depth cap for fallback scans (defensive, avoids runaway trees). */
const FALLBACK_SCAN_MAX_DEPTH = 8;

/**
 * Recursive newest-matching scan under one scope root.
 * Read-only; unreadable entries are skipped (fail-open).
 * `relScope` names the scope for building project-relative paths.
 */
async function newestMatchingRecursive(
  absRoot: string,
  relScope: string,
  config: PipelineConfig,
  filter: (fileName: string) => boolean,
): Promise<DocCandidate | null> {
  let best: DocCandidate | null = null;
  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    if (depth > FALLBACK_SCAN_MAX_DEPTH) return;
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // missing/unreadable scope or subdirectory → skip
    }
    for (const entry of entries) {
      const childAbs = path.join(absDir, entry.name);
      const childRel = relDir.length > 0 ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(childAbs, childRel, depth + 1);
      } else if (entry.isFile() && filter(entry.name) && MD_FILE_EXTENSION_RE.test(entry.name)) {
        try {
          const stat = await fsp.stat(childAbs);
          // Project-relative path: scope name + scope-relative descent
          const relPath = path.posix.join(relScope.replace(/\\/g, "/").replace(/\/+$/, ""), childRel);
          if (!best || stat.mtimeMs > best.mtimeMs) {
            best = { relPath, absPath: childAbs, mtimeMs: stat.mtimeMs };
          }
        } catch {
          // stat race → skip
        }
      }
    }
  };
  await walk(absRoot, "", 0);
  return best;
}

/**
 * 206 Phase 1 (used by Phase 3): re-export of the authoritative requirement
 * base derivation from `doc-naming.ts` so consumers of this module need only
 * one import for doc discovery + base resolution.
 */
export { reqBaseFromRequirementDoc as resolveRequirementBase } from "./naming/doc-naming";
