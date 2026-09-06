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
import type { PipelineConfig, Hook, SessionMeta, ExecFn, ViolationItem, PipelineStage } from "../types";
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
import { ALLOWED_WRITE_ALL, AUDIT_THROTTLE_WINDOW_MS, FROZEN_ABORT_EXEMPT_TOOLS, SPAWN_TOOL_NAMES } from "../constants";
import { loadGitignoreInfo, isGitignored, type GitignoreInfo } from "../utils/gitignore";
import { splitShellSegments, extractBashFileTargets } from "../utils/bash-parse";
import { createPipelineUI } from "./pipeline-ui";
import { isFrozen, getFlowState, formatFrozenReason, formatAbortedNotifyText } from "./flow-state";
import { safeWriteAuditLog } from "../utils/auditLog";
import { shouldEmitWithinWindow } from "../utils/audit-throttle";
import { checkGitAdd, checkGitCommit, isGitWriteCommand, isGitForbidden, type GitCheckResult } from "../utils/git-protect";
import { resolveGitModifyPolicy } from "../utils/protect";
import { recordViolation, checkViolationBreaker } from "./violation-tracker";
import { isDestructiveCommand, buildBlockedReason, isSystemPath } from "../utils/destructive-command";
import { askCommandDecision } from "../utils/protect-ask";
import { detectSessionRole } from "./session-role";
import { resolveAgentMention } from "../utils/subagent-rpc";
import { probeAgentState } from "../utils/subagents-introspect";

/** Dependencies for tool-guard (execFn for git dry-run) */
export interface ToolGuardDeps {
  execFn?: ExecFn;
}

/** Active spawn timeout (30 min) — stale entries are treated as absent */
const ACTIVE_SPAWN_STALE_MS = 30 * 60 * 1000;

/**
 * Checks whether there is a live spawn for the given stage.
 * Uses pi-subagents manager singleton probe (primary) and activeSpawns (secondary).
 * Returns null if no live spawn detected, or { agentId } if live.
 *
 * Fail-safe: any probe failure → returns null (do not block).
 *
 * Decision flow:
 * 1. If activeSpawns has an entry for this stage with a recorded agentId,
 *    probe it via probeAgentState (manager singleton).
 *    - "live" → return { agentId }
 *    - "settled" → do not block
 *    - "unknown" → fall through to activeSpawns time check
 * 2. Fallback: activeSpawns time-based check (< 30min → live).
 */
function checkLiveSpawn(
  meta: SessionMeta,
  stage: PipelineStage,
): { agentId?: string } | null {
  const activeSpawn = meta.activeSpawns?.[stage];
  if (activeSpawn) {
    // Primary: probe via manager singleton if we have a recorded agentId
    if (activeSpawn.agentId) {
      const probeResult = probeAgentState(activeSpawn.agentId);
      if (probeResult === "live") {
        return { agentId: activeSpawn.agentId };
      }
      if (probeResult === "settled") {
        return null; // Settled → do not block
      }
      // "unknown" → fall through to activeSpawns time check
    }

    // Secondary: time-based check (30min staleness threshold)
    const age = Date.now() - activeSpawn.startedAt;
    if (age < ACTIVE_SPAWN_STALE_MS) {
      return { agentId: activeSpawn.agentId };
    }
    // Stale → treat as absent
  }

  return null;
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
 * Checks whether a relative path is a `.git/*.lock` file (e.g. `.git/index.lock`).
 * Used for the self-rescue exemption: lock files under `.git/` may be removed
 * in stages with gitPolicy="allow" (develop/fix) to recover from stale locks.
 *
 * @param relPath - Project-relative path
 * @returns true if the path matches `.git/<name>.lock`
 */
function isGitLockFile(relPath: string): boolean {
  return /^\.git\/[^/]+\.lock$/.test(relPath);
}

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
 * @param opts - Optional behavior modifiers
 * @param opts.skipGitDirTargets - When true, targets under `.git/` are skipped
 *   (used for git-native write commands in allow stages — `.git/` writes are expected)
 * @param opts.allowGitLockFiles - When true, `.git/*.lock` targets bypass hardcoded
 *   protection (used for non-git self-rescue commands like `rm -f .git/index.lock`)
 * @returns Block result if a target is denied, undefined if all targets pass
 */
async function checkBashFileTargets(
  segment: string,
  state: ProtectState,
  stageConfig: { allowedWritePaths?: string[] },
  meta: SessionMeta,
  config: PipelineConfig,
  ctx: RuntimeCtx,
  trackViolation: (item: Omit<ViolationItem, "timestamp">) => void,
  ui: ReturnType<typeof createPipelineUI>,
  opts?: { skipGitDirTargets?: boolean; allowGitLockFiles?: boolean },
): Promise<{ block: true; reason: string } | undefined> {
  const targets = extractBashFileTargets(segment);
  const sessionPaths = meta.sessionAllowedWritePaths || [];

  for (const t of targets) {
    const absTarget = path.isAbsolute(t.target)
      ? t.target
      : path.join(config.projectRoot, t.target);
    const relPath = toProjectRelative(config.projectRoot, absTarget);

    if (relPath) {
      // Fix #2: git-native write in allow stage → skip .git/** targets only.
      // Non-.git/** working tree targets still go through the full protection chain.
      if (opts?.skipGitDirTargets && relPath.startsWith(".git/")) continue;

      // Fix #1: `.git/*.lock` self-rescue exemption for non-git commands in allow stages.
      // Allows `rm -f .git/index.lock` etc. when gitPolicy="allow" (develop/fix).
      if (opts?.allowGitLockFiles && isGitLockFile(relPath)) continue;

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
        // Phase 4 (172): per-stage git modify policy + hard blacklist + .git exemption.
        const segments = splitShellSegments(command);
        const warnings: string[] = [];
        let bashFileState: ProtectState | undefined;
        const currentStage = meta.currentStage;
        const gitPolicy = resolveGitModifyPolicy(config, null, currentStage);

        for (const segment of segments) {
          const trimmedSegment = segment.trim();

          // Phase 4 (172): Check if segment is a git command (after rtk normalization)
          const isGitCmd = /^rtk\s+git\s/.test(trimmedSegment) || trimmedSegment.startsWith("git ");

          if (isGitCmd) {
            // Hard blacklist: ALWAYS reject, even in allow stages
            if (isGitForbidden(segment)) {
              const reason = `FORBIDDEN: git command matches forbidden pattern in stage '${currentStage}' (stage git policy=${gitPolicy}).`;
              await trackViolation({
                type: "bash_destructive",
                tool: "bash",
                detail: reason,
                suggestion: `Forbidden git operations: filter-branch, reset --hard, clean -f, worktree remove, push --force.`,
              });
              ui.notify(ctx, reason);
              return { block: true, reason };
            }

            const isWrite = isGitWriteCommand(segment);

            if (isWrite && gitPolicy === "block") {
              // Block policy: hard-block git write commands (no ask popup per Phase 4 Q2-A)
              const reason = `FORBIDDEN: git write command blocked in stage '${currentStage}' (stage git policy=block).`;
              await trackViolation({
                type: "git_protected",
                tool: "bash",
                detail: reason,
                suggestion: `Git write operations are not allowed in the '${currentStage}' stage.`,
              });
              ui.notify(ctx, reason);
              return { block: true, reason };
            }

            // git add / git commit content validation (always runs for these specific commands)
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
              continue; // Skip the checkBashFileTargets for git add segments
            }

            if (GIT_COMMIT_PATTERN.test(segment)) {
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
              continue; // Skip the checkBashFileTargets for git commit segments
            }

              // Phase 4 (172) fix #2: git native write in allow stage → only exempt .git/** targets.
            // Non-.git/** working tree targets (gitignore-protected, .pi/**, etc.) still go
            // through checkBashFileTargets per plan P4 task 2.
            if (isWrite && gitPolicy === "allow") {
              if (!bashFileState) bashFileState = await getProtectState();
              const blockResult = await checkBashFileTargets(
                segment, bashFileState, stageConfig, meta, config, ctx, trackViolation, ui,
                { skipGitDirTargets: true },
              );
              if (blockResult) return blockResult;
              continue;
            }

            // Git read-only commands: pass through without file target check
            // (git status, git log, etc. don't write to working tree)
            continue;
          }

          // Non-git segment: check bash file-modification targets
          // Fix #1: pass allowGitLockFiles when gitPolicy="allow" so that
          // `rm -f .git/index.lock` self-rescue works in develop/fix stages.
          if (!bashFileState) bashFileState = await getProtectState();
          const blockResult = await checkBashFileTargets(
            segment, bashFileState, stageConfig, meta, config, ctx, trackViolation, ui,
            { allowGitLockFiles: gitPolicy === "allow" },
          );
          if (blockResult) return blockResult;
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

        // Phase 2 (171) Q2-B + Phase 4 (172) G6a: aborted/blocked-state exemption for
        // read-only probe tools. pipeline_state and get_subagent_result are safe (no write
        // side effects) and enable self-rescue / state inspection in frozen states.
        // Effective for both aborted and blocked — awaiting_human maintains full block.
        if ((fs === "aborted" || fs === "blocked") && FROZEN_ABORT_EXEMPT_TOOLS.includes(toolName)) {
          // Throttled audit for frozen probe (same 60s window pattern as rejection)
          const probeThrottleKey = `frozen-probe:${meta.pipelineId}:${toolName}`;
          if (shouldEmitWithinWindow(probeThrottleKey, AUDIT_THROTTLE_WINDOW_MS)) {
            await safeWriteAuditLog("tool_allowed_frozen_probe", {
              pipelineId: meta.pipelineId,
              stage: meta.currentStage,
              tool: toolName,
              flowState: fs,
            });
          }
          // Allow the tool call (return undefined = no block)
          return undefined;
        }

        let reason: string;
        if (fs === "aborted") {
          // Phase 1 (171): use shared abort text function for consistency across
          // markPipelineAborted notify / tool-guard rejection / resume notify (3 points, 1 source)
          reason = formatAbortedNotifyText(meta.currentStage, meta.terminateReason ?? "session_quit", meta.requirementDoc);
        } else if (meta.currentStage === "awaiting_human") {
          reason = "Pipeline frozen. Contact the user to resume the pipeline";
        } else {
          reason = `Pipeline frozen: ${formatFrozenReason(meta)}. Open the decision menu to proceed`;
        }
        // Phase 3 (170) ③: throttle audit for frozen rejection (60s window per pipelineId+tool+flowState)
        // Prevents audit flooding when the agent repeatedly hits frozen state.
        // Phase 0 (171): attach sessionFile to distinguish main vs zombie-subagent rejection streams.
        const sm = ((ctx._ctx as unknown) as Record<string, unknown>)?.sessionManager as
          | { getSessionFile?: () => string } | undefined;
        const sessionFile = sm?.getSessionFile?.() ?? "";
        const throttleKey = `frozen:${meta.pipelineId}:${toolName}:${fs}`;
        if (shouldEmitWithinWindow(throttleKey, AUDIT_THROTTLE_WINDOW_MS)) {
          await safeWriteAuditLog("tool_rejected_frozen", {
            pipelineId: meta.pipelineId,
            stage: meta.currentStage,
            tool: toolName,
            flowState: fs,
            reason: formatFrozenReason(meta),
            ...(sessionFile ? { sessionFile } : {}),
          });
        }
        return {
          block: true,
          reason,
        };
      }

      // 3b. Phase 2 (170): Policy tool blocklist — opt-in per-stage guard.
      // When stageConfig.guard.blockedTools contains the current toolName,
      // block with a policy-specific reason. NOT counted as a violation
      // (does not contribute to circuit-breaker).
      const blockedTools = stageConfig.guard?.blockedTools;
      if (blockedTools && blockedTools.length > 0 && blockedTools.includes(toolName)) {
        await safeWriteAuditLog("tool_blocked_by_policy", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          tool: toolName,
        });
        return {
          block: true,
          reason: `Tool '${toolName}' is blocked for answer collection in stage '${meta.currentStage}'. Relay questions and wait for answers in the requirement document.`,
        };
      }

      // 3c. Phase 4 (171) Q5-B: Opt-in duplicate-spawn suppression.
      // When guard.suppressDuplicateSpawn is true AND:
      // - toolName is "Agent" (pi-subagents spawn tool)
      // - args.subagent_type matches the current stage's resolved agent name
      // - stage is clarify or plan (lightweight-advance stages only)
      // - session is the owner (not child/clone — user sovereignty)
      // - probe or activeSpawns indicates a live spawn for this stage
      // → block with reason (NOT counted as violation).
      const guard = stageConfig.guard;
      if (guard?.suppressDuplicateSpawn && SPAWN_TOOL_NAMES.includes(toolName)) {
        const subagentType = args.subagent_type as string | undefined;
        const eligibleStages: PipelineStage[] = ["clarify", "plan"];
        if (subagentType && eligibleStages.includes(meta.currentStage)) {
          const expectedAgent = resolveAgentMention(config, meta.currentStage);
          if (expectedAgent && subagentType === expectedAgent) {
            // Domain restriction: only evaluate for owner sessions (detectSessionRole)
            const { isChild } = detectSessionRole(ctx);
            if (!isChild) {
              // In-run probe: check pi-subagents manager singleton (primary) or activeSpawns (secondary)
              const probeResult = checkLiveSpawn(meta, meta.currentStage);
              if (probeResult) {
                const suppressReason = `Stage executor '${expectedAgent}' is already running${probeResult.agentId ? ` (id ${probeResult.agentId})` : ""}. Await its result; do not spawn a duplicate.`;
                await safeWriteAuditLog("spawn_suppressed", {
                  pipelineId: meta.pipelineId,
                  stage: meta.currentStage,
                  tool: toolName,
                  subagentType,
                  agentId: probeResult.agentId ?? "",
                });
                return { block: true, reason: suppressReason };
              }
            }
          }
        }
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
