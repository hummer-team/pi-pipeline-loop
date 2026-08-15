/**
 * @module tool-guard
 * Factory for the `tool_call` hook.
 * Enforces tool permissions, bash command prefix restrictions,
 * file write protection (hardcoded + gitignore), and pipeline freeze state.
 *
 * Protection layers:
 * 1. Hardcoded paths (.pi/, AGENTS.md, .git/) - always protected
 * 2. Dynamic gitignore protection - parsed from .gitignore files
 * 3. Allow list - exempts from gitignore for edit only (not git add/commit)
 *
 * Interception channels:
 * - write/edit: hardcoded + allow + gitignore
 * - bash file modification (redirect, rm, mv, cp, touch, tee): same as write/edit
 * - git add: hardcoded + gitignore (allow does NOT exempt)
 * - git commit: hardcoded + gitignore (allow does NOT exempt)
 *
 * Side effects (R4Q2): Protection blocks only return { block, reason } and
 * optionally notify via TUI. They do NOT update meta, freeze pipeline, or
 * increment loop counts.
 */

import path from "node:path";
import type { PipelineConfig, Hook, SessionMeta, ExecFn } from "../types";
import { getFileHash } from "../utils/hash";
import {
  resolveProtectConfig,
  isHardcodedProtected,
  isPathAllowed,
  isPathAllowedWrite,
  isPathProtectedForModify,
  isPathProtectedForGit,
  toProjectRelative,
  type ProtectState,
} from "../utils/protect";
import { ALLOWED_WRITE_ALL } from "../constants";
import { loadGitignoreInfo, isGitignored, type GitignoreInfo } from "../utils/gitignore";
import { extractBashFileTargets } from "../utils/bash-parse";
import { createPipelineUI } from "./pipeline-ui";
import { isFrozen, getFlowState } from "./flow-state";

/** Dependencies for tool-guard (execFn for git dry-run) */
export interface ToolGuardDeps {
  execFn?: ExecFn;
}

/** Regex patterns for git command detection */
const GIT_ADD_PATTERN = /^\s*git\s+add\b/;
const GIT_COMMIT_PATTERN = /^\s*git\s+commit\b/;

/**
 * Result of the stage-level write whitelist check.
 * - "block": Path is denied by stage whitelist or hardcoded protection.
 * - "allow-whitelist": Path is allowed by stage whitelist (skip global chain).
 * - "continue": No stage-level decision (full mode / undefined) — caller should apply global chain.
 */
type StageWriteCheckResult =
  | { status: "block"; reason: string }
  | { status: "allow-whitelist" }
  | { status: "continue" };

/**
 * Checks if a write target is allowed by the stage write whitelist + hardcoded protection.
 *
 * Whitelist mode (allowedWritePaths does NOT contain "**"):
 *   1. Path must hit stage whitelist → otherwise block
 *   2. Path must NOT hit hardcoded protection → block (cannot be exempted)
 *   3. Otherwise → allow-whitelist (gitignore write protection is exempted by whitelist)
 *
 * Full mode (allowedWritePaths contains "**" or is undefined):
 *   Returns "continue" — caller applies global protection chain.
 *
 * @param relPath - Path relative to project root
 * @param allowedWritePaths - Stage write whitelist from StageConfig
 * @param stageName - Current pipeline stage (for error messages)
 * @param state - Protection state (for hardcoded check)
 * @returns StageWriteCheckResult indicating the decision
 */
function checkStageWriteBlock(
  relPath: string,
  allowedWritePaths: string[] | undefined,
  stageName: string,
  state: ProtectState
): StageWriteCheckResult {
  // Determine if stage whitelist is active (whitelist mode)
  const isWhitelistMode =
    allowedWritePaths !== undefined &&
    !allowedWritePaths.includes(ALLOWED_WRITE_ALL);

  if (!isWhitelistMode) {
    // Full mode: no stage-level restriction, fall through to global chain
    return { status: "continue" };
  }

  // Whitelist mode: path must be in the stage write whitelist
  if (!isPathAllowedWrite(relPath, allowedWritePaths)) {
    return {
      status: "block",
      reason: `FORBIDDEN: '${relPath}' not in allowed write paths for '${stageName}' stage.`,
    };
  }

  // Whitelist hit: hardcoded protection cannot be exempted (even by whitelist)
  if (isHardcodedProtected(relPath, state.hardcoded)) {
    return {
      status: "block",
      reason: `FORBIDDEN: Cannot modify protected path '${relPath}' (hardcoded protected).`,
    };
  }

  // Whitelist hit + not hardcoded → allowed (gitignore/allow exemptions are bypassed)
  return { status: "allow-whitelist" };
}

/**
 * Creates the `tool_call` hook that intercepts and validates tool calls.
 *
 * @param config - The pipeline configuration
 * @param deps - Optional dependencies (execFn for git operations)
 * @returns A Hook object for the "tool_call" event
 */
export function createToolGuard(config: PipelineConfig, deps?: ToolGuardDeps): Hook {
  const ui = createPipelineUI(config);
  const execFn = deps?.execFn;

  // Cache for gitignore info
  let gitignoreCache: GitignoreInfo | null | undefined = undefined;

  // Lazy-load gitignore info
  async function getGitignore(): Promise<GitignoreInfo | null> {
    if (gitignoreCache === undefined) {
      if (config.protect?.gitignore === false) {
        gitignoreCache = null;
      } else {
        gitignoreCache = await loadGitignoreInfo(config.projectRoot);
      }
    }
    return gitignoreCache;
  }

  // Build protection state
  async function getProtectState(): Promise<ProtectState> {
    const gitignore = await getGitignore();
    return resolveProtectConfig(config, gitignore);
  }

  // Build protection state for git operations (no allow, respects config)
  // Fixes: merges config.protect.paths (Problem 1), respects gitignore:false (Problem 3),
  // reuses resolveProtectConfig instead of duplicate implementation (Problem 14)
  async function getProtectStateForGit(): Promise<ProtectState> {
    const gitignore = await getGitignore();
    const state = resolveProtectConfig(config, gitignore);
    return { ...state, allow: [] }; // Allow does not exempt from git protection
  }

  return {
    event: "tool_call",
    handler: async (ctx: any): Promise<unknown> => {
      const meta = ctx.session.getMeta() as SessionMeta;
      const stageConfig = config.stages[meta.currentStage];
      const { name: toolName, arguments: args } = ctx.toolCall;

      // 1. Tool permission check
      if (!(stageConfig.allowedTools || []).includes(toolName)) {
        return {
          block: true,
          reason: `Tool "${toolName}" not allowed in "${meta.currentStage}" stage`,
        };
      }

      // 2. Bash command prefix check
      if (toolName === "bash") {
        const command = args.command as string;
        const mergedPrefixes = [
          ...(stageConfig.allowedBashPrefixes || []),
          ...(meta.tempAllowedBash || []),
        ];
        if (
          !mergedPrefixes.some((p: string) => command.startsWith(p))
        ) {
          return {
            block: true,
            reason: `Bash command "${command}" not in allowedBashPrefixes.`,
            suggestAsk: true,
            blockedCommand: command,
          };
        }

        // 2b. Git command protection check
        if (GIT_ADD_PATTERN.test(command)) {
          const gitState = await getProtectStateForGit();
          const blockResult = await checkGitAdd(command, gitState, config.projectRoot, execFn);
          if (blockResult) {
            ui.notify(ctx, blockResult.reason);
            return blockResult;
          }
        } else if (GIT_COMMIT_PATTERN.test(command)) {
          const gitState = await getProtectStateForGit();
          const blockResult = await checkGitCommit(command, gitState, config.projectRoot, execFn);
          if (blockResult) {
            ui.notify(ctx, blockResult.reason);
            return blockResult;
          }
        } else {
          // 2c. Bash file modification protection check
          const state = await getProtectState();
          const targets = extractBashFileTargets(command);
          for (const t of targets) {
            // Resolve target path relative to projectRoot
            const absTarget = path.isAbsolute(t.target)
              ? t.target
              : path.join(config.projectRoot, t.target);
            const relPath = toProjectRelative(config.projectRoot, absTarget);
            if (relPath) {
              // Stage-level write whitelist check (Phase 1)
              const stageCheck = checkStageWriteBlock(relPath, stageConfig.allowedWritePaths, meta.currentStage, state);
              if (stageCheck.status === "block") {
                ui.notify(ctx, stageCheck.reason);
                return { block: true, reason: stageCheck.reason };
              }
              // "allow-whitelist" → skip global chain, path is stage-authorized
              // "continue" → fall through to global protection chain
              if (stageCheck.status !== "allow-whitelist" && isPathProtectedForModify(relPath, state)) {
                const reason = `FORBIDDEN: Bash command modifies protected path '${relPath}'.`;
                ui.notify(ctx, reason);
                return { block: true, reason };
              }
            }
          }
        }
      }

      // 3. Freeze state check (unified via isFrozen)
      if (isFrozen(meta)) {
        const fs = getFlowState(meta);
        let reason: string;
        if (fs === "aborted") {
          reason = "Pipeline aborted. Start a new pipeline with /pipeline_start";
        } else if (meta.currentStage === "awaiting_human") {
          reason = "Pipeline frozen. Contact the user to resume the pipeline";
        } else {
          const shortcutKey = config.decisionShortcutKey ?? "ctrl+d";
          reason = `Pipeline frozen. Press ${shortcutKey} to open the decision menu`;
        }
        return {
          block: true,
          reason,
        };
      }

      // 4. File write protection for write/edit tools
      if (toolName === "write" || toolName === "edit") {
        const filePath = (args.file_path || args.path) as string;
        // Resolve relative paths against projectRoot to avoid cwd dependency (Problem 11)
        const absPath = path.isAbsolute(filePath)
          ? path.normalize(filePath)
          : path.resolve(config.projectRoot, filePath);
        const relPath = toProjectRelative(config.projectRoot, absPath);

        if (relPath) {
          const state = await getProtectState();

          // Stage-level write whitelist check (Phase 1)
          const stageCheck = checkStageWriteBlock(relPath, stageConfig.allowedWritePaths, meta.currentStage, state);
          if (stageCheck.status === "block") {
            ui.notify(ctx, stageCheck.reason);
            return { block: true, reason: stageCheck.reason };
          }

          // "allow-whitelist" → skip global chain, path is stage-authorized
          if (stageCheck.status !== "allow-whitelist") {
            // Global protection chain (hardcoded + allow + gitignore)
            // Check hardcoded protection (allow cannot exempt)
            if (isHardcodedProtected(relPath, state.hardcoded)) {
              const reason = `FORBIDDEN: Cannot modify protected path '${relPath}' (hardcoded protected).`;
              ui.notify(ctx, reason);
              return { block: true, reason };
            }

            // Check allow exemption (only for gitignore protection)
            if (isPathAllowed(relPath, state.allow)) {
              // Allowed - proceed with hash recording
            } else if (state.gitignore) {
              // Check gitignore protection
              if (isGitignored(state.gitignore, relPath)) {
                const reason = `FORBIDDEN: Cannot modify protected path '${relPath}' (gitignore protected).`;
                ui.notify(ctx, reason);
                return { block: true, reason };
              }
            }
          }
        }

        // Record oldHash for diff archiving in loop-breaker
        const hash = await getFileHash(filePath);
        (ctx.toolCall as Record<string, unknown>).oldHash = hash;
      }

      return undefined;
    },
  };
}

/**
 * Checks if a git add command would stage protected paths.
 * Uses `git add --dry-run` to preview what would be staged.
 *
 * @param command - The git add command
 * @param state - Protection state (pre-built by caller)
 * @param projectRoot - Project root directory
 * @param execFn - Optional execution function
 * @returns Block result if protected paths would be staged, undefined otherwise
 */
async function checkGitAdd(
  command: string,
  state: ProtectState,
  projectRoot: string,
  execFn?: ExecFn
): Promise<{ block: true; reason: string } | undefined> {
  // Fail-closed: if no execFn, block for safety
  if (!execFn) {
    return {
      block: true,
      reason: "FORBIDDEN: Cannot verify 'git add' safety (execFn not available).",
    };
  }

  try {
    // Extract args from the original command (after "git add")
    const argsMatch = command.match(/^\s*git\s+add\s+(.*)$/);
    const addArgs = argsMatch ? argsMatch[1].trim() : "";

    // Run dry-run to see what would be added
    const dryRunArgs = ["add", "--dry-run", ...addArgs.split(/\s+/).filter(Boolean)];
    const result = await execFn("git", dryRunArgs, projectRoot);

    // Parse output: "add 'path'" or "add path"
    // Even on non-zero exit, try to extract paths for precise error messages
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

    if (result.code !== 0) {
      // Check stderr for hints about ignored files
      const stderrLower = result.stderr.toLowerCase();
      if (stderrLower.includes("ignored") || stderrLower.includes("did not match")) {
        // Provide more precise feedback based on stderr
        return {
          block: true,
          reason: `FORBIDDEN: 'git add' rejected by git (possibly includes ignored/protected paths): ${result.stderr.trim()}`,
        };
      }
      // Generic fail-closed
      return {
        block: true,
        reason: `FORBIDDEN: 'git add --dry-run' failed (exit ${result.code}).`,
      };
    }
  } catch (err) {
    // Fail closed on any error — log for diagnostics (Problem 7)
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[tool-guard] checkGitAdd error: command="${command}", projectRoot="${projectRoot}", error=${errMsg}`);
    return {
      block: true,
      reason: "FORBIDDEN: Cannot verify 'git add' safety (execution error).",
    };
  }

  return undefined;
}

/**
 * Checks if a git commit command would include protected paths.
 * Uses `git diff --cached --name-only` to see staged files.
 *
 * @param command - The git commit command
 * @param state - Protection state (pre-built by caller)
 * @param projectRoot - Project root directory
 * @param execFn - Optional execution function
 * @returns Block result if protected paths would be committed, undefined otherwise
 */
async function checkGitCommit(
  command: string,
  state: ProtectState,
  projectRoot: string,
  execFn?: ExecFn
): Promise<{ block: true; reason: string } | undefined> {
  // Fail-closed: if no execFn, block for safety
  if (!execFn) {
    return {
      block: true,
      reason: "FORBIDDEN: Cannot verify 'git commit' safety (execFn not available).",
    };
  }

  try {
    // Check staged files
    const stagedResult = await execFn("git", ["diff", "--cached", "--name-only"], projectRoot);
    if (stagedResult.code !== 0) {
      return {
        block: true,
        reason: `FORBIDDEN: 'git diff --cached' failed (exit ${stagedResult.code}).`,
      };
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
    // Problem 2 fix: detect combined flags like -am, -aM, -A etc.
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
      }
    }
  } catch (err) {
    // Fail closed on any error — log for diagnostics (Problem 7)
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[tool-guard] checkGitCommit error: command="${command}", projectRoot="${projectRoot}", error=${errMsg}`);
    return {
      block: true,
      reason: "FORBIDDEN: Cannot verify 'git commit' safety (execution error).",
    };
  }

  return undefined;
}

/**
 * Detects if a git commit command contains -a, -A, or --all flag.
 * Handles combined flags like -am, -aM, -amc etc.
 */
function hasGitCommitAllFlag(command: string): boolean {
  const tokens = command.split(/\s+/);
  for (const token of tokens) {
    if (token === "--all") return true;
    // Match combined single-char flags containing 'a' or 'A' (e.g., -am, -aM, -A)
    if (/^-[a-zA-Z]*[aA][a-zA-Z]*$/.test(token)) return true;
  }
  return false;
}

// Re-exported from the centralized auditLog module for backward compatibility.
export { getDateAuditFileName } from "../utils/auditLog";
