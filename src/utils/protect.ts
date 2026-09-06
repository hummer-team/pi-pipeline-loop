/**
 * @module protect
 * Protection judgment logic for file modification and git operations.
 * Implements three-layer protection: hardcoded > gitignore dynamic > allow exemption.
 */

import * as path from "node:path";
import type { PipelineConfig, PipelineStage, ProtectConfig } from "../types";
import { PROTECTED_PATHS, ALLOWED_WRITE_ALL } from "../constants";
import { type GitignoreInfo, isGitignored } from "./gitignore";

/**
 * Internal state for protection judgment.
 * Contains normalized hardcoded paths, allow list, and gitignore info.
 */
export interface ProtectState {
  /** Hardcoded protected paths (built-in + user-configured paths) */
  hardcoded: string[];
  /** Normalized allow list entries (directories end with /) */
  allow: string[];
  /** Parsed gitignore info (null if gitignore disabled or not found) */
  gitignore: GitignoreInfo | null;
}

/**
 * Resolves protect configuration into a ProtectState for judgment.
 *
 * @param config - Pipeline configuration with protect settings
 * @param gitignore - Optional gitignore info (injected by caller for lazy loading)
 * @returns ProtectState with normalized hardcoded/allow paths and gitignore
 */
export function resolveProtectConfig(
  config: PipelineConfig,
  gitignore: GitignoreInfo | null
): ProtectState {
  const protect: ProtectConfig = config.protect ?? {};

  // Merge built-in PROTECTED_PATHS with user-configured paths
  const hardcoded = [...PROTECTED_PATHS, ...(protect.paths ?? [])];

  // Normalize allow list
  const allow = normalizeAllow(protect.allow ?? []);

  return { hardcoded, allow, gitignore };
}

/**
 * Normalizes allow list entries.
 * Directory entries (without extension) get trailing / added for boundary matching.
 * File entries (with extension) are kept as-is for exact matching.
 *
 * @param entries - Raw allow list from config
 * @returns Normalized allow list
 */
export function normalizeAllow(entries: string[]): string[] {
  return entries.map((entry) => {
    // If entry already ends with /, keep as-is
    if (entry.endsWith("/")) return entry;
    // Entries containing "/" are directory paths — always add trailing /
    // This fixes dotted directories like "docs/design.v2" being misclassified
    // as files due to path.extname() returning ".v2"
    if (entry.includes("/")) return entry + "/";
    // Root-level entries with a file extension are treated as files (e.g., README.md)
    if (path.extname(entry)) return entry;
    // Otherwise, treat as directory and add trailing /
    return entry + "/";
  });
}

/**
 * Checks if a path is in the allow list.
 * Uses prefix matching for directories (with trailing /) for boundary safety.
 *
 * @param relPath - Path relative to project root
 * @param allow - Normalized allow list
 * @returns True if the path is allowed for edit
 */
export function isPathAllowed(relPath: string, allow: string[]): boolean {
  for (const entry of allow) {
    // Directory entry (ends with /): prefix match
    if (entry.endsWith("/")) {
      if (relPath === entry.slice(0, -1) || relPath.startsWith(entry)) {
        return true;
      }
    } else {
      // File entry: exact match
      if (relPath === entry) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks if a path is within the stage-level write whitelist.
 *
 * @param relPath - Path relative to project root
 * @param allowedWritePaths - Stage write whitelist (undefined = full access fallback)
 * @returns True if the path is allowed by the stage write whitelist
 */
export function isPathAllowedWrite(
  relPath: string,
  allowedWritePaths: string[] | undefined
): boolean {
  // Undefined = no stage restriction configured → full access (backward compatible)
  if (allowedWritePaths === undefined) return true;

  // "**" = all paths allowed (full access sentinel)
  if (allowedWritePaths.includes(ALLOWED_WRITE_ALL)) return true;

  // Empty array = no writes allowed at all
  if (allowedWritePaths.length === 0) return false;

  // Normalize and use directory prefix matching (multi-candidate: any match = allowed)
  const normalized = normalizeAllow(allowedWritePaths);
  return isPathAllowed(relPath, normalized);
}

/**
 * Checks if a path matches hardcoded protection.
 * Handles both directory entries (with trailing /) and file entries.
 *
 * @param relPath - Path relative to project root
 * @param hardcoded - List of hardcoded protected paths
 * @returns True if the path is hardcoded protected
 */
export function isHardcodedProtected(
  relPath: string,
  hardcoded: string[]
): boolean {
  for (const entry of hardcoded) {
    // Remove trailing / for comparison
    const normalized = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    // Exact match or starts with entry + "/"
    if (relPath === normalized || relPath.startsWith(normalized + "/")) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if a path is protected for modification (write/edit/bash).
 * Three-layer logic: hardcoded → allow → gitignore.
 *
 * @param relPath - Path relative to project root
 * @param state - Protection state
 * @returns True if the path is protected (modification blocked)
 */
export function isPathProtectedForModify(
  relPath: string,
  state: ProtectState
): boolean {
  // Layer 1: Hardcoded always protected (allow cannot exempt)
  if (isHardcodedProtected(relPath, state.hardcoded)) {
    return true;
  }

  // Layer 2: Allow exempts from gitignore protection
  if (isPathAllowed(relPath, state.allow)) {
    return false;
  }

  // Layer 3: Gitignore dynamic protection
  if (state.gitignore && isGitignored(state.gitignore, relPath)) {
    return true;
  }

  return false;
}

/**
 * Checks if a path is protected for git operations (add/commit).
 * Allow list does NOT exempt from git protection.
 *
 * @param relPath - Path relative to project root
 * @param state - Protection state
 * @returns True if the path is protected for git (staging blocked)
 */
export function isPathProtectedForGit(
  relPath: string,
  state: ProtectState
): boolean {
  // Hardcoded always protected
  if (isHardcodedProtected(relPath, state.hardcoded)) {
    return true;
  }

  // Allow does NOT exempt from git protection (per R3Q4)
  // Only gitignore matters for dynamic protection
  if (state.gitignore && isGitignored(state.gitignore, relPath)) {
    return true;
  }

  return false;
}

/**
 * Converts an absolute path to a project-relative path.
 * Returns null if the path is outside the project (starts with ..).
 *
 * @param projectRoot - Absolute path to project root
 * @param absPath - Absolute path to convert
 * @returns Relative path or null if outside project
 */
export function toProjectRelative(
  projectRoot: string,
  absPath: string
): string | null {
  const normalized = path.normalize(absPath);
  const rel = path.relative(projectRoot, normalized);
  // If relative path is outside the project (starts with ../ or equals ..)
  // Use exact check to avoid false positive on paths like "..foo" inside project
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
    return null;
  }
  return rel;
}

// ─── Git Modify Policy (Phase 0 / 172) ─────────────────────────────────────

/**
 * Built-in default git-modify policy per stage.
 * Read-only stages (clarify/plan/review) and terminal states (completed/awaiting_human)
 * block git-native writes by default; implementation stages (develop/fix) allow them.
 *
 * Unknown stage names fall back to "block" (fail-safe).
 */
export const GIT_MODIFY_DEFAULT_MATRIX: Readonly<Partial<Record<PipelineStage, "allow" | "block">>> = {
  clarify: "block",
  plan: "block",
  develop: "allow",
  review: "block",
  fix: "allow",
  awaiting_human: "block",
  completed: "block",
} as const;

/**
 * Resolves the effective git-modify policy for a given stage using a 3-tier chain:
 *
 *   1. stages[stage].protect?.gitModify  (stage-level override)
 *   2. config.protect?.gitModify         (global override)
 *   3. GIT_MODIFY_DEFAULT_MATRIX[stage]  (built-in matrix; unknown stage → "block")
 *
 * This pure function has no side effects and does not consult gitignore or protect.ask.
 *
 * @param config - Full pipeline configuration (used for global protect.gitModify)
 * @param _gitignore - Unused parameter, kept for API symmetry with resolveProtectConfig
 * @param stage - The pipeline stage to resolve for
 * @returns "allow" or "block"
 */
export function resolveGitModifyPolicy(
  config: PipelineConfig,
  _gitignore?: GitignoreInfo | null,
  stage?: PipelineStage,
): "allow" | "block" {
  // Tier 1: stage-level override
  if (stage) {
    const stageProtect = config.stages?.[stage]?.protect;
    if (stageProtect?.gitModify !== undefined) {
      return stageProtect.gitModify;
    }
  }

  // Tier 2: global override
  const globalGitModify = config.protect?.gitModify;
  if (globalGitModify !== undefined) {
    return globalGitModify;
  }

  // Tier 3: built-in matrix (unknown stage → "block")
  if (stage && stage in GIT_MODIFY_DEFAULT_MATRIX) {
    return GIT_MODIFY_DEFAULT_MATRIX[stage]!;
  }
  return "block";
}
