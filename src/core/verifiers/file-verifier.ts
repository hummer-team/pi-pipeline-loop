/**
 * @module file-verifier
 * Verifies file existence and file content regex patterns.
 * Supports glob patterns (* and ?) for dynamic product paths.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AuditLogFn } from "../../types";

/** Result of a single verification check */
export interface VerifierResult {
  passed: boolean;
  detail: string;
}

/**
 * Checks whether a string contains glob wildcard characters.
 */
function isGlobPattern(s: string): boolean {
  return s.includes("*") || s.includes("?");
}

/**
 * Converts a simple glob pattern to a RegExp.
 * Supports `*` (matches any chars except `/`) and `?` (matches single char except `/`).
 */
function globToRegex(glob: string): RegExp {
  let regexStr = "^";
  for (const ch of glob) {
    if (ch === "*") regexStr += "[^/]*";
    else if (ch === "?") regexStr += "[^/]";
    else if (".+^${}()|[]\\".includes(ch)) regexStr += "\\" + ch;
    else regexStr += ch;
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * Recursively collects all file paths under `dir` (relative to `baseDir`).
 */
async function walkDir(dir: string, baseDir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true }) as import("node:fs").Dirent[];
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await walkDir(fullPath, baseDir);
      results.push(...sub);
    } else if (entry.isFile()) {
      results.push(path.relative(baseDir, fullPath));
    }
  }
  return results;
}

/**
 * Matches files against a glob pattern relative to projectRoot.
 * Returns an array of matching file paths (relative to projectRoot).
 */
export async function globMatchFiles(pattern: string, projectRoot: string): Promise<string[]> {
  const allFiles = await walkDir(projectRoot, projectRoot);
  const regex = globToRegex(pattern);
  return allFiles.filter((relPath) => regex.test(relPath));
}

/**
 * Verifies that all required files exist relative to projectRoot.
 * Supports glob patterns — a pattern matches if at least one file exists.
 *
 * @param requiredFiles - Array of file paths or glob patterns (relative to projectRoot)
 * @param projectRoot - Absolute path to the project root directory
 * @returns Verification result with list of missing files on failure
 */
export async function verifyRequiredFiles(
  requiredFiles: string[] | undefined,
  projectRoot: string,
): Promise<VerifierResult> {
  if (!requiredFiles || requiredFiles.length === 0) {
    return { passed: true, detail: "No required files to check" };
  }

  const missing: string[] = [];

  for (const filePath of requiredFiles) {
    if (isGlobPattern(filePath)) {
      // Glob pattern: at least one match counts as present
      const matches = await globMatchFiles(filePath, projectRoot);
      if (matches.length === 0) {
        missing.push(filePath);
      }
    } else {
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(projectRoot, filePath);

      try {
        await fs.access(absolutePath);
      } catch {
        missing.push(filePath);
      }
    }
  }

  if (missing.length > 0) {
    return {
      passed: false,
      detail: `Missing files: ${missing.join(", ")}`,
    };
  }

  return { passed: true, detail: `All ${requiredFiles.length} required files exist` };
}

/**
 * Verifies that file contents match specified regex patterns.
 * Supports glob patterns in path — when pattern contains wildcards,
 * collects matching files and checks the most recent (by mtime).
 *
 * @param rules - Array of { path, pattern } rules
 * @param projectRoot - Absolute path to the project root directory
 * @param logError - Optional audit log callback for recording errors
 * @returns Verification result with pattern mismatch details on failure
 */
export async function verifyFileContentPattern(
  rules: { path: string; pattern: string }[] | undefined,
  projectRoot: string,
  logError?: AuditLogFn,
): Promise<VerifierResult> {
  if (!rules || rules.length === 0) {
    return { passed: true, detail: "No file content patterns to check" };
  }

  const failures: string[] = [];

  for (const rule of rules) {
    if (isGlobPattern(rule.path)) {
      // Glob path: find matching files, pick the most recent by mtime
      const matchedFiles = await globMatchFiles(rule.path, projectRoot);
      if (matchedFiles.length === 0) {
        failures.push(`${rule.path}: no files matched glob pattern`);
        continue;
      }

      // Sort by mtime descending to get the most recently modified file
      const withMtime = await Promise.all(
        matchedFiles.map(async (relPath) => {
          const absPath = path.join(projectRoot, relPath);
          try {
            const stat = await fs.stat(absPath);
            return { relPath, absPath, mtime: stat.mtimeMs };
          } catch {
            return { relPath, absPath, mtime: 0 };
          }
        }),
      );
      withMtime.sort((a, b) => b.mtime - a.mtime);
      const latest = withMtime[0];

      try {
        const content = await fs.readFile(latest.absPath, "utf-8");
        const regex = new RegExp(rule.pattern, "m");
        if (!regex.test(content)) {
          failures.push(`${rule.path}: pattern "${rule.pattern}" not found in latest match "${latest.relPath}"`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failures.push(`${rule.path}: file read error on "${latest.relPath}" (${errMsg})`);
        await logError?.("verify_error", { ruleType: "fileContentPattern", path: rule.path, error: errMsg });
      }
    } else {
      // Exact path
      // Phase 1 (L1): pre-validate path to prevent EISDIR from path.join(root, "")
      if (rule.path.trim() === "") {
        failures.push(`fileContentPattern path 为空（配置错误）`);
        continue;
      }

      const absolutePath = path.isAbsolute(rule.path)
        ? rule.path
        : path.join(projectRoot, rule.path);

      try {
        // Phase 1 (L1): check if path points to a directory
        let stat: import("node:fs").Stats;
        try {
          stat = await fs.stat(absolutePath);
        } catch {
          // stat failed — fall through to readFile which will produce its own error
        }
        if (stat! && stat!.isDirectory()) {
          failures.push(`${rule.path}: path 指向目录而非文件（配置错误）`);
          continue;
        }

        const content = await fs.readFile(absolutePath, "utf-8");
        const regex = new RegExp(rule.pattern, "m");
        if (!regex.test(content)) {
          failures.push(`${rule.path}: pattern "${rule.pattern}" not found`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Phase 1 (L1): EISDIR friendly message
        const isDir = (err as NodeJS.ErrnoException).code === "EISDIR";
        const detail = isDir
          ? `${rule.path}: path 指向目录（EISDIR）（配置错误）`
          : `${rule.path}: file read error (${errMsg})`;
        failures.push(detail);
        await logError?.("verify_error", { ruleType: "fileContentPattern", path: rule.path, error: errMsg });
      }
    }
  }

  if (failures.length > 0) {
    return {
      passed: false,
      detail: failures.join("; "),
    };
  }

  return { passed: true, detail: `All ${rules.length} content patterns matched` };
}
