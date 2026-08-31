/**
 * @module git-protect
 * Git operation protection functions extracted from tool-guard.
 * Provides per-segment dry-run checks for `git add` and `git commit`,
 * returning structured results that distinguish block (positive confirmation
 * of protected path) from warn (dry-run failure, execution error, etc.).
 *
 * Design rationale (Phase 0 / Bug 2):
 * - Block only when dry-run positively confirms a protected path would be
 *   staged or committed (fail-open for infrastructure errors).
 * - Degrade non-positive failures (exit≠0, stderr hints, exec errors,
 *   missing execFn) to warn — log via safeWriteAuditLog, do not count as
 *   violations.
 */

import type { ExecFn } from "../types";
import type { ProtectState } from "./protect";
import { isPathProtectedForGit } from "./protect";
import { tokenize } from "./bash-parse";
import { safeWriteAuditLog } from "./auditLog";

/**
 * Result of a git protection check.
 * - block: true when dry-run positively confirms a protected path.
 * - warn: set when the check encountered an error but could not positively
 *   confirm protection. Caller should log and continue (not count as violation).
 */
export interface GitCheckResult {
  /** Whether the operation should be blocked (positive confirmation of protected path) */
  block: boolean;
  /** Human-readable reason for blocking (present when block=true) */
  reason?: string;
  /** Warning message for non-fatal check failures (present when block=false but check was inconclusive) */
  warn?: string;
}

/**
 * Detects if a git commit command contains -a, -A, or --all flag.
 * Handles combined flags like -am, -aM, -amc etc.
 *
 * @param command - The git commit command string
 * @returns True if the command includes an "all" flag
 */
export function hasGitCommitAllFlag(command: string): boolean {
  const tokens = command.split(/\s+/);
  for (const token of tokens) {
    if (token === "--all") return true;
    // Match combined single-char flags containing 'a' or 'A' (e.g., -am, -aM, -A)
    if (/^-[a-zA-Z]*[aA][a-zA-Z]*$/.test(token)) return true;
  }
  return false;
}

/**
 * Checks if a single-segment `git add` command would stage protected paths.
 * Uses `git add --dry-run` with pathspec extracted via `tokenize`.
 *
 * Block condition: dry-run output positively shows `add <path>` where
 * `isPathProtectedForGit(path, state)` is true.
 *
 * Degrade to warn: exit≠0, stderr hints (ignored/did not match),
 * exec exception, no execFn.
 *
 * @param command - Single shell segment of a git add command
 * @param state - Protection state (pre-built by caller)
 * @param projectRoot - Project root directory
 * @param execFn - Optional execution function
 * @returns GitCheckResult (block if positively confirmed, warn otherwise)
 */
export async function checkGitAdd(
  command: string,
  state: ProtectState,
  projectRoot: string,
  execFn?: ExecFn
): Promise<GitCheckResult> {
  // Fail-open: if no execFn, degrade to warn (audit as error per plan)
  if (!execFn) {
    await safeWriteAuditLog(
      "git_protect",
      { check: "add", outcome: "degrade", reason: "execFn not available", command },
      "error"
    );
    return { block: false, warn: "Cannot verify 'git add' safety (execFn not available)." };
  }

  try {
    // Extract pathspec tokens after "git add" using tokenize (quote-aware)
    const allTokens = tokenize(command);
    // Find "add" subcommand index and collect remaining tokens as pathspec
    const addIndex = allTokens.indexOf("add");
    const pathspecTokens = addIndex >= 0 ? allTokens.slice(addIndex + 1) : [];

    // Run dry-run to see what would be added
    const dryRunArgs = ["add", "--dry-run", ...pathspecTokens];
    const result = await execFn("git", dryRunArgs, projectRoot);

    // Parse output: "add 'path'" or "add path"
    const lines = result.stdout.split("\n");
    for (const line of lines) {
      const match = line.match(/^add\s+['"]?([^'"]+)['"]?$/);
      if (match) {
        const stagedPath = match[1];
        if (isPathProtectedForGit(stagedPath, state)) {
          return {
            block: true,
            reason: `FORBIDDEN: 'git add' would stage protected path '${stagedPath}'.`,
          };
        }
      }
    }

    // Non-zero exit → degrade to warn (audit as error per plan)
    if (result.code !== 0) {
      const stderrLower = result.stderr.toLowerCase();
      if (stderrLower.includes("ignored") || stderrLower.includes("did not match")) {
        await safeWriteAuditLog(
          "git_protect",
          { check: "add", outcome: "degrade", reason: "git rejected", stderr: result.stderr.trim(), command },
          "error"
        );
        return {
          block: false,
          warn: `'git add' rejected by git (possibly ignored/protected paths): ${result.stderr.trim()}`,
        };
      }
      await safeWriteAuditLog(
        "git_protect",
        { check: "add", outcome: "degrade", reason: `exit ${result.code}`, command },
        "error"
      );
      return { block: false, warn: `'git add --dry-run' failed (exit ${result.code}).` };
    }
  } catch (err) {
    // Exec exception → degrade to warn (audit as error per plan)
    const errMsg = err instanceof Error ? err.message : String(err);
    await safeWriteAuditLog(
      "git_protect",
      { check: "add", outcome: "degrade", reason: "exec error", error: errMsg, command, projectRoot },
      "error"
    );
    return { block: false, warn: "Cannot verify 'git add' safety (execution error)." };
  }

  return { block: false };
}

/**
 * Checks if a single-segment `git commit` command would include protected paths.
 * Uses `git diff --cached --name-only` for positive detection.
 * Also checks `-a/-A/--all` flag for unstaged changes.
 *
 * Block condition: staged (or -a unstaged) files positively include a protected path.
 * Degrade to warn: diff failure, exec exception, no execFn.
 *
 * @param command - Single shell segment of a git commit command
 * @param state - Protection state (pre-built by caller)
 * @param projectRoot - Project root directory
 * @param execFn - Optional execution function
 * @returns GitCheckResult (block if positively confirmed, warn otherwise)
 */
export async function checkGitCommit(
  command: string,
  state: ProtectState,
  projectRoot: string,
  execFn?: ExecFn
): Promise<GitCheckResult> {
  // Fail-open: if no execFn, degrade to warn (audit as error per plan)
  if (!execFn) {
    await safeWriteAuditLog(
      "git_protect",
      { check: "commit", outcome: "degrade", reason: "execFn not available", command },
      "error"
    );
    return { block: false, warn: "Cannot verify 'git commit' safety (execFn not available)." };
  }

  try {
    // Check staged files
    const stagedResult = await execFn("git", ["diff", "--cached", "--name-only"], projectRoot);
    if (stagedResult.code !== 0) {
      await safeWriteAuditLog(
        "git_protect",
        { check: "commit", outcome: "degrade", reason: `diff --cached exit ${stagedResult.code}`, command },
        "error"
      );
      return { block: false, warn: `'git diff --cached' failed (exit ${stagedResult.code}).` };
    }

    const stagedFiles = stagedResult.stdout.trim().split("\n").filter(Boolean);

    for (const file of stagedFiles) {
      if (isPathProtectedForGit(file, state)) {
        return {
          block: true,
          reason: `FORBIDDEN: 'git commit' includes protected path '${file}'.`,
        };
      }
    }

    // If -a, -A, --all flag (including combined flags like -am), also check unstaged changes
    if (hasGitCommitAllFlag(command)) {
      const unstagedResult = await execFn("git", ["diff", "--name-only"], projectRoot);
      if (unstagedResult.code === 0) {
        const unstagedFiles = unstagedResult.stdout.trim().split("\n").filter(Boolean);
        for (const file of unstagedFiles) {
          if (isPathProtectedForGit(file, state)) {
            return {
              block: true,
              reason: `FORBIDDEN: 'git commit -a' includes protected path '${file}'.`,
            };
          }
        }
      } else {
        // Unstaged diff failed — degrade to warn (audit as error per plan)
        await safeWriteAuditLog(
          "git_protect",
          { check: "commit", outcome: "degrade", reason: `diff --name-only exit ${unstagedResult.code}`, command },
          "error"
        );
      }
    }
  } catch (err) {
    // Exec exception → degrade to warn (audit as error per plan)
    const errMsg = err instanceof Error ? err.message : String(err);
    await safeWriteAuditLog(
      "git_protect",
      { check: "commit", outcome: "degrade", reason: "exec error", error: errMsg, command, projectRoot },
      "error"
    );
    return { block: false, warn: "Cannot verify 'git commit' safety (execution error)." };
  }

  return { block: false };
}
