/**
 * @module git-verifier
 * Verifies git repository state: last commit time, branch name, working tree cleanliness.
 */

import type { ExecFn } from "../../types";
import type { VerifierResult } from "./file-verifier";

/**
 * Parses a time-window string (e.g., "10min", "1h", "30s") into seconds.
 *
 * @param timeStr - Time window string (e.g., "10min", "1h", "30s")
 * @returns Number of seconds, or null if parsing fails
 */
function parseTimeWindow(timeStr: string): number | null {
  const match = timeStr.match(/^(\d+)\s*(s|sec|second|seconds|min|minute|minutes|h|hour|hours|d|day|days)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (unit.startsWith("s")) return value;
  if (unit.startsWith("min")) return value * 60;
  if (unit.startsWith("h")) return value * 3600;
  if (unit.startsWith("d")) return value * 86400;
  return null;
}

/**
 * Verifies git repository state against the specified rules.
 * Uses dependency-injected execFn to route git commands through pi SDK sandbox.
 *
 * @param rules - Git verification rules (lastCommitWithin, branch, cleanWorkingTree)
 * @param projectRoot - Working directory for git commands
 * @param execFn - Injected shell execution function
 * @returns Verification result with git state failure details
 */
export async function verifyRequiredGit(
  rules: { lastCommitWithin?: string; branch?: string; cleanWorkingTree?: boolean } | undefined,
  projectRoot: string,
  execFn?: ExecFn,
): Promise<VerifierResult> {
  if (!rules) {
    return { passed: true, detail: "No git rules to check" };
  }

  const failures: string[] = [];

  /** Helper to execute a command via execFn or fallback to child_process */
  async function runCmd(args: string[]): Promise<string> {
    if (execFn) {
      const result = await execFn("git", args, projectRoot);
      return result.stdout;
    }
    // Fallback for backward compatibility
    const { execSync } = await import("node:child_process");
    return execSync(`git ${args.join(" ")}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  // Check last commit time
  if (rules.lastCommitWithin) {
    const windowSeconds = parseTimeWindow(rules.lastCommitWithin);
    if (windowSeconds === null) {
      failures.push(`Invalid time window format: "${rules.lastCommitWithin}"`);
    } else {
      try {
        const commitTimestamp = (await runCmd(["log", "-1", "--format=%ct"])).trim();

        const commitTime = parseInt(commitTimestamp, 10);
        if (isNaN(commitTime)) {
          failures.push("Could not parse last commit timestamp");
        } else {
          const now = Math.floor(Date.now() / 1000);
          const elapsed = now - commitTime;
          if (elapsed > windowSeconds) {
            failures.push(
              `Last commit was ${elapsed}s ago, expected within ${windowSeconds}s (${rules.lastCommitWithin})`,
            );
          }
        }
      } catch {
        failures.push("Failed to read git log (not a git repository or no commits)");
      }
    }
  }

  // Check current branch
  if (rules.branch) {
    try {
      const currentBranch = (await runCmd(["rev-parse", "--abbrev-ref", "HEAD"])).trim();

      if (currentBranch !== rules.branch) {
        failures.push(`Expected branch "${rules.branch}", currently on "${currentBranch}"`);
      }
    } catch {
      failures.push("Failed to read current git branch");
    }
  }

  // Check working tree cleanliness
  if (rules.cleanWorkingTree === true) {
    try {
      const status = (await runCmd(["status", "--porcelain"])).trim();

      if (status.length > 0) {
        failures.push("Working tree is not clean (uncommitted changes detected)");
      }
    } catch {
      failures.push("Failed to check git working tree status");
    }
  }

  if (failures.length > 0) {
    return {
      passed: false,
      detail: failures.join("; "),
    };
  }

  return { passed: true, detail: "All git rules satisfied" };
}
