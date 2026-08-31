/**
 * @module tool-guard
 * Factory for the `tool_call` hook.
 * Enforces destructive command interception, file write protection
 * (hardcoded + gitignore + stage whitelist), and pipeline freeze state.
 *
 * Protection layers:
 * 1. Destructive command blacklist — sudo, rm -rf /, mkfs, etc. (with user confirmation dialog)
 * 2. Hardcoded paths (.pi/, .git/) - always protected
 * 3. Dynamic gitignore protection - parsed from .gitignore files
 * 4. Allow list - exempts from gitignore for edit only (not git add/commit)
 * 5. Stage write whitelist — restricts writable paths per stage
 *
 * Interception channels:
 * - bash: destructive command check → git protection → file modification protection
 * - write/edit: hardcoded + allow + gitignore + stage whitelist
 * - git add: hardcoded + gitignore (allow does NOT exempt)
 * - git commit: hardcoded + gitignore (allow does NOT exempt)
 *
 * Side effects (R4Q2): Protection blocks only return { block, reason } and
 * optionally notify via TUI. They do NOT update meta, freeze pipeline, or
 * increment loop counts.
 */

import path from "node:path";
import type { PipelineConfig, Hook, SessionMeta, ExecFn, ViolationItem } from "../types";
import type { RuntimeCtx } from "./runtime-ctx";
import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
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
import { splitShellSegments, extractBashFileTargets } from "../utils/bash-parse";
import { createPipelineUI } from "./pipeline-ui";
import { isFrozen, getFlowState, formatFrozenReason } from "./flow-state";
import { safeWriteAuditLog } from "../utils/auditLog";
import { checkGitAdd, checkGitCommit, type GitCheckResult } from "../utils/git-protect";
import { recordViolation, checkViolationBreaker } from "./violation-tracker";
import { isDestructiveCommand, buildBlockedReason, isSystemPath } from "../utils/destructive-command";
import { askCommandDecision } from "../utils/protect-ask";

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

// askProtectDecision is shared with pipeline-init (verify merge ask).
// Implementation moved to ../utils/protect-ask.ts — imported below.
import { askProtectDecision } from "../utils/protect-ask";

/**
 * Checks a single non-git bash segment for file-modification targets
 * against the protection chain: session allowance → stage whitelist →
 * global protection (hardcoded → allow → gitignore).
 *
 * @param segment - Single bash command segment
 * @param state - Protection state (pre-built by caller)
 * @param stageConfig - Current stage configuration (for whitelist)
 * @param meta - Current session metadata
 * @param config - Pipeline configuration
 * @param ctx - Runtime context (for TUI ask dialogs)
 * @param trackViolation - Violation recorder
 * @param ui - Pipeline UI for notifications
 * @returns Block result if a target is denied, undefined if all targets pass
 */
async function checkBashFileTargets(
  segment: string,
  state: ProtectState,
  stageConfig: { allowedWritePaths?: string[] },
  meta: SessionMeta,
  config: PipelineConfig,
  ctx: RuntimeCtx,
  trackViolation: (item: Omit<ViolationItem, "timestamp">) => Promise<void>,
  ui: ReturnType<typeof createPipelineUI>,
): Promise<{ block: true; reason: string } | undefined> {
  const targets = extractBashFileTargets(segment);
  const sessionPaths = meta.sessionAllowedWritePaths || [];

  for (const t of targets) {
    const absTarget = path.isAbsolute(t.target)
      ? t.target
      : path.join(config.projectRoot, t.target);
    const relPath = toProjectRelative(config.projectRoot, absTarget);

    if (relPath) {
      // Session allowance early bypass
      if (sessionPaths.includes(relPath)) continue;

      // Stage-level write whitelist check
      const stageCheck = checkStageWriteBlock(relPath, stageConfig.allowedWritePaths, meta.currentStage, state);
      if (stageCheck.status === "block") {
        if (config.protect?.ask === true && isPathProtectedForModify(relPath, state)) {
          const decision = await askProtectDecision(ctx, meta, relPath);
          if (decision === "block") {
            await trackViolation({
              type: "write_protected", tool: "bash", detail: stageCheck.reason,
              suggestion: `Stage whitelist: [${(stageConfig.allowedWritePaths || []).join(", ")}].`,
            });
            ui.notify(ctx, stageCheck.reason);
            return { block: true, reason: stageCheck.reason };
          }
          continue;
        }
        await trackViolation({
          type: "write_protected", tool: "bash", detail: stageCheck.reason,
          suggestion: `Stage whitelist: [${(stageConfig.allowedWritePaths || []).join(", ")}].`,
        });
        ui.notify(ctx, stageCheck.reason);
        return { block: true, reason: stageCheck.reason };
      }

      // Global protection chain (only when whitelist did not allow)
      if (stageCheck.status !== "allow-whitelist") {
        if (isPathProtectedForModify(relPath, state)) {
          if (config.protect?.ask === true) {
            const decision = await askProtectDecision(ctx, meta, relPath);
            if (decision === "block") {
              const reason = `FORBIDDEN: Bash command modifies protected path '${relPath}'.`;
              await trackViolation({ type: "write_protected", tool: "bash", detail: reason, suggestion: `Protected paths: .pi/, .git/ + gitignore patterns.` });
              ui.notify(ctx, reason);
              return { block: true, reason };
            }
            continue;
          }
          const reason = `FORBIDDEN: Bash command modifies protected path '${relPath}'.`;
          await trackViolation({ type: "write_protected", tool: "bash", detail: reason, suggestion: `Protected paths: .pi/, .git/ + gitignore patterns.` });
          ui.notify(ctx, reason);
          return { block: true, reason };
        }
      }
    } else {
      // Path outside project root
      const isWhitelistMode =
        stageConfig.allowedWritePaths !== undefined &&
        !stageConfig.allowedWritePaths.includes(ALLOWED_WRITE_ALL);

      // Redirect-class out-of-project targets are always allowed
      if (t.kind === "redirect") continue;

      // file-arg class: block in whitelist mode
      if (isWhitelistMode) {
        const reason = `FORBIDDEN: Target '${absTarget}' is outside project root and not allowed by '${meta.currentStage}' stage whitelist.`;
        await trackViolation({
          type: "write_protected", tool: "bash", detail: reason,
          suggestion: `Stage whitelist: [${(stageConfig.allowedWritePaths || []).join(", ")}].`,
        });
        ui.notify(ctx, reason);
        return { block: true, reason };
      }

      // Full mode: safety net for destructive commands targeting system paths
      const baseCmd = segment.trim().split(/\s+/)[0];
      if (["rm", "mv", "chmod", "chown"].includes(baseCmd) && isSystemPath(absTarget)) {
        const reason = `FORBIDDEN: Destructive command '${baseCmd}' targets system path '${absTarget}' outside project root.`;
        await trackViolation({
          type: "bash_destructive", tool: "bash", detail: reason,
          suggestion: `Avoid destructive operations targeting system paths.`,
        });
        ui.notify(ctx, reason);
        return { block: true, reason };
      }
    }
  }
  return undefined;
}

/**
 * Creates the `tool_call` hook that intercepts and validates tool calls.
 *
 * @param config - The pipeline configuration
 * @param deps - Optional dependencies (execFn for git operations)
 * @returns A Hook object for the "tool_call" event
 */
export function createToolGuard(config: PipelineConfig, deps?: ToolGuardDeps): Hook<"tool_call"> {
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
    handler: async (ctx: RuntimeCtx): Promise<ToolCallEventResult | void> => {
      const meta = ctx.session.getMeta() as SessionMeta;
      const stageConfig = config.stages[meta.currentStage];
      // tool_call events always populate toolCall (buildRuntimeCtx guarantees it)
      const { name: toolName, arguments: args } = ctx.toolCall!;

      // Helper: record a violation and check the breaker (pure recording, no block side effects)
      async function trackViolation(item: Omit<ViolationItem, "timestamp">): Promise<void> {
        const full: ViolationItem = { ...item, timestamp: Date.now() };
        await recordViolation(ctx, meta, full);
        // Re-read meta after updateMeta to get latest violations count
        const updatedMeta = ctx.session.getMeta() as SessionMeta;
        await checkViolationBreaker(ctx, updatedMeta, config);
      }

      // 1. Tool permission check — REMOVED in Phase 0 (D0)
      // Tools are no longer restricted by allowlist; protection relies on
      // write-path whitelist, git content check, and destructive command block.

      // 2. Bash command handling
      if (toolName === "bash") {
        const command = args.command as string;

        // ── DESTRUCTIVE COMMAND CHECK (full command, pre-split) ──
        if (isDestructiveCommand(command)) {
          const sessionCommands = meta.sessionAllowedCommands || [];
          if (!sessionCommands.includes(command)) {
            if (config.protect?.ask === true) {
              const decision = await askCommandDecision(ctx, meta, command);
              if (decision === "block") {
                const reason = buildBlockedReason(command);
                await trackViolation({
                  type: "bash_destructive",
                  tool: "bash",
                  detail: reason,
                  suggestion: `Use protect.ask dialog to allow, or avoid dangerous commands.`,
                });
                ui.notify(ctx, reason);
                return { block: true, reason };
              }
            } else {
              const reason = buildBlockedReason(command) + ". Enable protect.ask for user confirmation.";
              await trackViolation({
                type: "bash_destructive",
                tool: "bash",
                detail: reason,
                suggestion: `Avoid dangerous commands or enable protect.ask in config.`,
              });
              ui.notify(ctx, reason);
              return { block: true, reason };
            }
          }
        }

        // ── SEGMENT-LEVEL PROTECTION (Bug 2: split compound commands) ──
        const segments = splitShellSegments(command);
        const warnings: string[] = [];
        let bashFileState: ProtectState | undefined;

        for (const segment of segments) {
          if (GIT_ADD_PATTERN.test(segment)) {
            const gitState = await getProtectStateForGit();
            const result = await checkGitAdd(segment, gitState, config.projectRoot, execFn);
            if (result.block) {
              await trackViolation({
                type: "git_protected",
                tool: "bash",
                detail: result.reason!,
                suggestion: `git add cannot stage protected paths (.pi/, .git/, gitignore).`,
              });
              ui.notify(ctx, result.reason!);
              return { block: true, reason: result.reason! };
            }
            if (result.warn) warnings.push(result.warn);
          } else if (GIT_COMMIT_PATTERN.test(segment)) {
            const gitState = await getProtectStateForGit();
            const result = await checkGitCommit(segment, gitState, config.projectRoot, execFn);
            if (result.block) {
              await trackViolation({
                type: "git_protected",
                tool: "bash",
                detail: result.reason!,
                suggestion: `git commit cannot include protected paths (.pi/, .git/, gitignore).`,
              });
              ui.notify(ctx, result.reason!);
              return { block: true, reason: result.reason! };
            }
            if (result.warn) warnings.push(result.warn);
          } else {
            // Non-git segment: check bash file-modification targets
            if (!bashFileState) bashFileState = await getProtectState();
            const blockResult = await checkBashFileTargets(
              segment, bashFileState, stageConfig, meta, config, ctx, trackViolation, ui,
            );
            if (blockResult) return blockResult;
          }
        }

        // Aggregate warnings (non-blocking, not counted as violations)
        if (warnings.length > 0) {
          const warnMsg = `[git-protect warn] ${warnings.join("; ")}`;
          ui.notify(ctx, warnMsg);
          await safeWriteAuditLog("git_protect_warn", { warnings: warnings.join("|"), command }, "warn");
        }
      }

      // 3. Freeze state check (unified via isFrozen)
      if (isFrozen(meta)) {
        const fs = getFlowState(meta);
        let reason: string;
        if (fs === "aborted") {
          reason = "Pipeline aborted. Start a new pipeline with /pipeline-start";
        } else if (meta.currentStage === "awaiting_human") {
          reason = "Pipeline frozen. Contact the user to resume the pipeline";
        } else {
          reason = `Pipeline frozen: ${formatFrozenReason(meta)}. Open the decision menu to proceed`;
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

          // Session-level file allowance: bypasses whitelist + global chain entirely.
          // Pre-evaluated once so downstream branches can skip redundant checks.
          const sessionPaths = meta.sessionAllowedWritePaths || [];
          const sessionAllowed = sessionPaths.includes(relPath);

          if (!sessionAllowed) {
            // Stage-level write whitelist check
            const stageCheck = checkStageWriteBlock(relPath, stageConfig.allowedWritePaths, meta.currentStage, state);

            if (stageCheck.status === "block") {
              // Phase 1: if protect.ask=true AND path is protected, surface ask dialog.
              // This lets users override a stage-whitelist rejection for protected paths.
              if (config.protect?.ask === true && isPathProtectedForModify(relPath, state)) {
                const decision = await askProtectDecision(ctx, meta, relPath);
                if (decision === "block") {
                  await trackViolation({
                    type: "write_protected",
                    tool: toolName,
                    detail: stageCheck.reason,
                    suggestion: `Stage whitelist: [${(stageConfig.allowedWritePaths || []).join(", ")}].`,
                  });
                  ui.notify(ctx, stageCheck.reason);
                  return { block: true, reason: stageCheck.reason };
                }
                // "allow" → fall through to hash recording
              } else {
                // ask=false or non-protected path: keep original whitelist block behavior
                await trackViolation({
                  type: "write_protected",
                  tool: toolName,
                  detail: stageCheck.reason,
                  suggestion: `Stage whitelist: [${(stageConfig.allowedWritePaths || []).join(", ")}].`,
                });
                ui.notify(ctx, stageCheck.reason);
                return { block: true, reason: stageCheck.reason };
              }
            } else if (stageCheck.status !== "allow-whitelist") {
              // "continue" → global protection chain (hardcoded + allow + gitignore)
              // Hardcoded protection (allow cannot exempt)
              if (isHardcodedProtected(relPath, state.hardcoded)) {
                if (config.protect?.ask === true) {
                  const decision = await askProtectDecision(ctx, meta, relPath);
                  if (decision === "block") {
                    const reason = `FORBIDDEN: Cannot modify protected path '${relPath}' (hardcoded protected).`;
                    await trackViolation({
                      type: "write_protected",
                      tool: toolName,
                      detail: reason,
                      suggestion: `Hardcoded protected: .pi/, .git/.`,
                    });
                    ui.notify(ctx, reason);
                    return { block: true, reason };
                  }
                  // "allow" → proceed with hash recording
                } else {
                  const reason = `FORBIDDEN: Cannot modify protected path '${relPath}' (hardcoded protected).`;
                  await trackViolation({
                    type: "write_protected",
                    tool: toolName,
                    detail: reason,
                    suggestion: `Hardcoded protected: .pi/, .git/.`,
                  });
                  ui.notify(ctx, reason);
                  return { block: true, reason };
                }
              } else {
                // Allow exemption check (only for gitignore protection)
                if (isPathAllowed(relPath, state.allow)) {
                  // Allowed - proceed with hash recording
                } else if (state.gitignore) {
                  // Check gitignore protection
                  if (isGitignored(state.gitignore, relPath)) {
                    if (config.protect?.ask === true) {
                      const decision = await askProtectDecision(ctx, meta, relPath);
                      if (decision === "block") {
                        const reason = `FORBIDDEN: Cannot modify protected path '${relPath}' (gitignore protected).`;
                        await trackViolation({
                          type: "write_protected",
                          tool: toolName,
                          detail: reason,
                          suggestion: `Gitignore protected. Use protect.allow to exempt specific paths.`,
                        });
                        ui.notify(ctx, reason);
                        return { block: true, reason };
                      }
                      // "allow" → proceed with hash recording
                    } else {
                      const reason = `FORBIDDEN: Cannot modify protected path '${relPath}' (gitignore protected).`;
                      await trackViolation({
                        type: "write_protected",
                        tool: toolName,
                        detail: reason,
                        suggestion: `Gitignore protected. Use protect.allow to exempt specific paths.`,
                      });
                      ui.notify(ctx, reason);
                      return { block: true, reason };
                    }
                  }
                }
              }
            }
            // "allow-whitelist" → fall through to hash recording (gitignore exemption implicit)
          }
        } else {
          // Path outside project root: block in whitelist mode (cannot satisfy whitelist)
          const isWhitelistMode =
            stageConfig.allowedWritePaths !== undefined &&
            !stageConfig.allowedWritePaths.includes(ALLOWED_WRITE_ALL);
          if (isWhitelistMode) {
            const reason = `FORBIDDEN: Target '${absPath}' is outside project root and not allowed by '${meta.currentStage}' stage whitelist.`;
            await trackViolation({
              type: "write_protected",
              tool: toolName,
              detail: reason,
              suggestion: `Stage whitelist: [${(stageConfig.allowedWritePaths || []).join(", ")}].`,
            });
            ui.notify(ctx, reason);
            return { block: true, reason };
          }
          // Full mode: out-of-project paths bypass global chain (legacy behavior)
        }

        // Record oldHash for diff archiving in loop-breaker
        const hash = await getFileHash(filePath);
        (ctx.toolCall as Record<string, unknown>).oldHash = hash;
      }

      return undefined;
    },
  };
}

// Re-exported from the centralized auditLog module for backward compatibility.
export { getDateAuditFileName } from "../utils/auditLog";
