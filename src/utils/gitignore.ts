/**
 * @module gitignore
 * Parses root and nested .gitignore files to produce a unified matcher.
 * Uses the `ignore` npm package for standard gitignore pattern matching.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import ignore, { type Ignore } from "ignore";

/**
 * Parsed gitignore information for a project.
 * Contains a unified matcher and the raw patterns for display.
 */
export interface GitignoreInfo {
  /** The ignore matcher instance (single instance for all patterns) */
  matcher: Ignore;
  /** Raw patterns relative to projectRoot, for prompt display */
  patterns: string[];
}

/** Module-level cache by projectRoot */
const cache = new Map<string, GitignoreInfo | null>();

/**
 * Resets the gitignore cache. Used for testing and hot-reload scenarios.
 */
export function resetGitignoreCache(): void {
  cache.clear();
}

/** Directories to skip when searching for nested .gitignore files */
const SKIP_DIRS = new Set([".git", "node_modules", ".pi", "dist"]);

/**
 * Recursively collects .gitignore files from a project directory.
 * Skips directories in SKIP_DIRS (+ extraSkipDirs when provided) and stops
 * descending into ignored directories.
 *
 * @param root - Project root directory
 * @param ig - The ignore instance to add patterns to
 * @param patterns - Array to collect patterns (prefixed to be root-relative)
 * @param currentDir - Current directory being scanned
 * @param prefix - Path prefix relative to root (for nested gitignore files)
 * @param extraSkipDirs - Additional directory basenames to skip (e.g. custom piWorkDir)
 */
function collectGitignoreFiles(
  root: string,
  ig: Ignore,
  patterns: string[],
  currentDir: string,
  prefix: string,
  extraSkipDirs?: ReadonlySet<string>
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return; // Permission denied or other errors
  }

  // Check for .gitignore in current directory
  const gitignorePath = path.join(currentDir, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    try {
      const content = fs.readFileSync(gitignorePath, "utf-8");
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        // Prefix patterns with the directory path to make them root-relative
        // Handle negation patterns (starting with !)
        let pattern = trimmed;
        let isNegation = false;
        if (pattern.startsWith("!")) {
          isNegation = true;
          pattern = pattern.slice(1);
        }

        // Add prefix to make root-relative
        // For nested gitignore files, strip leading "/" from anchored patterns
        // to avoid double slashes (e.g., "sub/" + "/cache/" → "sub/cache/")
        let prefixedPattern: string;
        if (prefix) {
          const stripped = pattern.startsWith("/") ? pattern.slice(1) : pattern;
          prefixedPattern = prefix + stripped;
        } else {
          // Root-level patterns keep their original form (including leading /)
          prefixedPattern = pattern;
        }

        const finalPattern = isNegation ? "!" + prefixedPattern : prefixedPattern;
        ig.add(finalPattern);
        patterns.push(finalPattern);
      }
    } catch {
      // Ignore read errors
    }
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;

    // Skip special directories (built-in SKIP_DIRS + caller-provided extras)
    if (SKIP_DIRS.has(dirName)) continue;
    if (extraSkipDirs && extraSkipDirs.has(dirName)) continue;

    const subDir = path.join(currentDir, dirName);
    const subPrefix = prefix ? prefix + dirName + "/" : dirName + "/";

    // Check if this directory itself is ignored - if so, don't descend
    if (prefix && ig.ignores(subPrefix.slice(0, -1))) {
      continue; // Parent gitignore ignores this directory
    }

    collectGitignoreFiles(root, ig, patterns, subDir, subPrefix, extraSkipDirs);
  }
}

/**
 * Loads and parses gitignore files for a project.
 * Returns null if no root .gitignore exists.
 * Results are cached by projectRoot + extraSkipDirs signature.
 *
 * @param projectRoot - Absolute path to the project root
 * @param extraSkipDirs - Optional additional directory basenames to skip during traversal
 * @returns GitignoreInfo with unified matcher and patterns, or null if no .gitignore
 */
export async function loadGitignoreInfo(
  projectRoot: string,
  extraSkipDirs?: ReadonlySet<string>
): Promise<GitignoreInfo | null> {
  // Cache key: projectRoot + sorted extra skip dirs (stable signature)
  const extraKey = extraSkipDirs ? [...extraSkipDirs].sort().join(",") : "";
  const cacheKey = `${projectRoot}::${extraKey}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  // Check if root .gitignore exists
  const rootGitignore = path.join(projectRoot, ".gitignore");
  if (!fs.existsSync(rootGitignore)) {
    cache.set(cacheKey, null);
    return null;
  }

  // Create a new ignore instance and collect all patterns
  const ig = ignore();
  const patterns: string[] = [];

  collectGitignoreFiles(projectRoot, ig, patterns, projectRoot, "", extraSkipDirs);

  const info: GitignoreInfo = { matcher: ig, patterns };
  cache.set(cacheKey, info);
  return info;
}

/**
 * Tests if a path is ignored by the gitignore rules.
 *
 * @param info - The gitignore info from loadGitignoreInfo
 * @param relPath - Path relative to project root
 * @returns True if the path is ignored
 */
export function isGitignored(info: GitignoreInfo, relPath: string): boolean {
  return info.matcher.ignores(relPath);
}
