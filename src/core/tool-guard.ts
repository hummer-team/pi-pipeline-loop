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
  isPathReadOnly,
  isPathProtectedForModify,
  toProjectRelative,
  resolveSymlinkPathStrict,
  type ProtectState,
} from "../utils/protect";
import {
  isPathWithinWriteScope,
  describeWriteScope,
} from "./design-review/write-policy";
// 194 Phase 3 (C4, task 1): lifecycle access decision (runtime identity →
// dynamic scope → stage/global protect) lives in ONE small policy module.
import {
  resolveLifecycleWriteAccess,
  collectLifecycleEvidence,
  isFinishedReleaseProtectedPath,
  type LifecycleWriteAccess,
} from "./stage-executor/lifecycle-access";
import { ALLOWED_WRITE_ALL, AUDIT_THROTTLE_WINDOW_MS, FROZEN_ABORT_EXEMPT_TOOLS, SPAWN_TOOL_NAMES } from "../constants";
import { resolveGitignoreSkipDirs } from "../utils/work-dir";
import { loadGitignoreInfo, isGitignored, type GitignoreInfo } from "../utils/gitignore";
import { splitShellSegments, extractBashFileTargets } from "../utils/bash-parse";
import { createPipelineUI } from "./pipeline-ui";
import { isFrozen, getFlowState, formatFrozenReason, formatAbortedNotifyText, formatDecisionMenuHint } from "./flow-state";
import { safeWriteAuditLog } from "../utils/auditLog";
import { shouldEmitWithinWindow } from "../utils/audit-throttle";
import { getStageDeliverableExemptions } from "./verify-path-resolver";
import { checkGitAdd, checkGitCommit, isGitWriteCommand, isGitForbidden } from "../utils/git-protect";
import { resolveGitModifyPolicy, describeGitModifySource } from "../utils/protect";
import { staleConfigNotice } from "../utils/config-staleness";
import { recordViolation, checkViolationBreaker } from "./violation-tracker";
import { isDestructiveCommand, buildBlockedReason, isSystemPath } from "../utils/destructive-command";
import { askCommandDecision } from "../utils/protect-ask";
import { detectSessionRole } from "./session-role";
import { resolveAgentMention } from "../utils/subagent-rpc";
import { scanActiveSpawnEvidence } from "../utils/spawn-evidence";
// Phase 0 (182): secondary name-probe for manual/out-of-band agent detection
import { findLiveAgentByName } from "../utils/subagents-introspect";
import { isDormant, DORMANT_KEEP_PROTECTION } from "./dormancy";
// 193 Phase 3 (task 8): paused/decision-pending read-only enforcement
import { designReviewPendingWriteBlockReason } from "./design-review/decision-guard";

/** Dependencies for tool-guard (execFn for git dry-run) */
export interface ToolGuardDeps {
  execFn?: ExecFn;
}

/** Regex patterns for git command detection */
const GIT_ADD_PATTERN = /^\s*git\s+add\b/;
const GIT_COMMIT_PATTERN = /^\s*git\s+commit\b/;

/**
 * Checks whether the (currentStage → targetStage) pair is a legitimate manual
 * progression path that should be allowed by the 3e out-of-stage exception.
 *
 * Only the review→fix transition qualifies: when a reviewer manually triggers
 * the fix executor after a failed review, this is a normal human workflow that
 * the confirm-gate routing would otherwise impede. All other cross-stage spawns
 * (including plan→develop) must be blocked per Plan Phase 4 task 3 / G6.
 */
function isLegitimateManualProgression(currentStage: PipelineStage, targetStage: PipelineStage): boolean {
  return currentStage === "review" && targetStage === "fix";
}

/**
 * Phase 1 / 177 (D2): Builds the git-write block reason, including the policy
 * source (stage/global/matrix) and a stale-config notice. Shared by the
 * hard-block path and the ask-deny path to keep the message single-sourced.
 *
 * @param config - Pipeline configuration
 * @param currentStage - The stage being evaluated
 * @returns Human-readable block reason
 */
function buildGitWriteBlockReason(config: PipelineConfig, currentStage: PipelineStage): string {
  const policySource = describeGitModifySource(config, currentStage);
  const staleNotice = staleConfigNotice(config);
  const sourceHint = policySource === "stage"
    ? `stages.${currentStage}.protect.gitModify`
    : policySource === "global"
      ? "protect.gitModify"
      : `matrix default for "${currentStage}"`;
  return `FORBIDDEN: git write command blocked in stage '${currentStage}'. Policy source: ${sourceHint}. To permit git writes, set protect.gitModify="allow" or stages.${currentStage}.protect.gitModify="allow" in pipeline_loop.json (protect.allow does NOT exempt git commands).${staleNotice ? " " + staleNotice : ""}`;
}
/**
 * Result of the stage-level write whitelist check.
 * - "block": Path is denied by stage whitelist or hardcoded protection.
 * - "allow-whitelist": Path is allowed by stage whitelist (skip global chain).
 * - "continue": No stage-level decision (full mode / undefined) — caller should apply global chain.
 * - exempted?: boolean indicates the path was exempted from read-only check (195 Phase 1)
 */
type StageWriteCheckResult =
  | { status: "block"; reason: string; exempted?: boolean }
  | { status: "allow-whitelist"; exempted?: boolean }
  | { status: "continue"; exempted?: boolean };

/**
 * Test-only hook retained for backwards compatibility.
 * The intersection warning dedup is now stored in session meta
 * (per-session, per-stage), so there is no module-level state to clear.
 * Kept as a no-op so existing tests that call it before each case still compile.
 */
export function __resetReadOnlyIntersectionWarned(): void {
  // No-op: dedup state lives in session meta, not module scope.
}

/**
 * Detects overlap between allowedReadOnlyPaths and allowedWritePaths for a stage.
 * When overlap exists, writes an audit warning and emits a TUI notification.
 * One-time per stage per session (dedup via session meta flag).
 *
 * @param stageName - Current pipeline stage
 * @param allowedReadOnlyPaths - Read-only path patterns
 * @param allowedWritePaths - Write whitelist patterns
 * @param ui - Pipeline UI for notifications
 * @param ctx - Runtime context for UI calls and meta access
 * @param meta - Current session metadata (for per-stage dedup flag)
 */
function warnReadOnlyWriteIntersection(
  stageName: string,
  allowedReadOnlyPaths: string[] | undefined,
  allowedWritePaths: string[] | undefined,
  ui: ReturnType<typeof createPipelineUI>,
  ctx: RuntimeCtx,
  meta: SessionMeta,
): void {
  if (!allowedReadOnlyPaths?.length || !allowedWritePaths?.length) return;

  // Per-session, per-stage dedup: skip if the flag is already set in meta
  if (meta.readOnlyIntersectionWarned?.[stageName]) return;

  // Check for overlap: any read-only pattern also covered by a write pattern
  const normalizedWrite = allowedWritePaths.includes(ALLOWED_WRITE_ALL)
    ? null
    : allowedWritePaths;

  let hasOverlap = false;
  if (normalizedWrite === null) {
    // "**" write-all overlaps with everything
    hasOverlap = true;
  } else {
    for (const roPattern of allowedReadOnlyPaths) {
      // Check if any write path covers the same area as the read-only pattern
      for (const wp of normalizedWrite) {
        // Simple overlap detection: one is prefix of the other, or they share a common directory
        if (roPattern.startsWith(wp) || wp.startsWith(roPattern) || roPattern === wp) {
          hasOverlap = true;
          break;
        }
      }
      if (hasOverlap) break;
    }
  }

  if (hasOverlap) {
    // Mark this stage as warned in session meta (per-session, per-stage dedup)
    ctx.session.updateMeta({
      readOnlyIntersectionWarned: {
        ...(meta.readOnlyIntersectionWarned ?? {}),
        [stageName]: true,
      },
    });
    const msg = `Warning: allowedReadOnlyPaths and allowedWritePaths overlap for stage '${stageName}'. Read-only paths take priority.`;
    // Audit log (fail-open, fire-and-forget)
    safeWriteAuditLog("readonly_write_intersection_warning", {
      stage: stageName,
      allowedReadOnlyPaths: allowedReadOnlyPaths.join(","),
      allowedWritePaths: (allowedWritePaths || []).join(","),
    }, "warn").catch(() => {});
    ui.notify(ctx, msg);
  }
}

/**
 * Phase 2 (190) Fix-C: Build FORBIDDEN message for hardcoded protected paths.
 * When the path is under .pi/audit/, append guidance directing the model to use
 * generate_stage_summary tool instead of writing directly.
 */
function buildHardcodedForbiddenReason(relPath: string, _hardcoded: string[]): string {
  const base = `FORBIDDEN: Cannot modify protected path '${relPath}' (hardcoded protected).`;
  if (relPath.startsWith(".pi/audit/")) {
    return (
      base +
      " To record commit IDs: call `generate_stage_summary(commitIds: [\"<hash>\", ...])` — the tool writes to .pi/audit/ internally." +
      " To create a human-readable commit record: write to docs/design/ (e.g. {plan_stem}_plan_commit.md)."
    );
  }
  return base;
}

/**
 * Phase 1 (190) Fix-A extension: Child session hard-block for protected paths.
 * Prevents child sessions from entering askProtectDecision, which would cause
 * dismissCount to be incorrectly accumulated when child inherits owner's ui.select.
 *
 * @param isChild - Whether the current session is a child session
 * @param relPath - Relative path being accessed
 * @param protectionType - Type of protection ("hardcoded" | "gitignore")
 * @param state - Protection state
 * @param toolName - Name of the tool being used
 * @param trackViolation - Violation tracking function (sync or async)
 * @param ui - Pipeline UI
 * @param ctx - Runtime context
 * @returns Block result if child session, undefined otherwise
 */
async function childHardBlockForProtectedPath(
  isChild: boolean,
  relPath: string,
  protectionType: "hardcoded" | "gitignore",
  state: ProtectState,
  toolName: string,
  trackViolation: (item: Omit<ViolationItem, "timestamp">) => void | Promise<void>,
  ui: ReturnType<typeof createPipelineUI>,
  ctx: RuntimeCtx,
): Promise<{ block: true; reason: string } | undefined> {
  if (!isChild) return undefined;

  const reason = protectionType === "hardcoded"
    ? buildHardcodedForbiddenReason(relPath, state.hardcoded)
    : `FORBIDDEN: Cannot modify protected path '${relPath}' (gitignore protected).`;

  const suggestion = protectionType === "hardcoded"
    ? `Hardcoded protected: ${state.hardcoded.join(", ")}.`
    : `Gitignore protected. Use protect.allow to exempt specific paths.`;

  await trackViolation({
    type: "write_protected",
    tool: toolName,
    detail: reason,
    suggestion,
  });

  ui.notify(ctx, reason);
  return { block: true, reason };
}

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
  state: ProtectState,
  allowedReadOnlyPaths?: string[],
  exemptedPaths?: string[]
): StageWriteCheckResult {
  // 195 Phase 1: Check if path is in exempted list before read-only check.
  // Exempted paths skip read-only interception and return exempted: true.
  if (exemptedPaths && exemptedPaths.length > 0) {
    const normalizedPath = path.normalize(relPath);
    const isExempted = exemptedPaths.some(exempt => path.normalize(exempt) === normalizedPath);
    if (isExempted) {
      return { status: "continue", exempted: true };
    }
  }

  // Phase 0 (186): read-only path check BEFORE write whitelist.
  // Read-only paths take priority over allowedWritePaths on intersection.
  if (isPathReadOnly(relPath, allowedReadOnlyPaths)) {
    return {
      status: "block",
      reason: `FORBIDDEN: '${relPath}' is in read-only paths for '${stageName}' stage.`,
    };
  }

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
      reason: buildHardcodedForbiddenReason(relPath, state.hardcoded),
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
 * @param access - Resolved lifecycle write access for this bash call (194
 *   Phase 3 C4: runtime identity already folded in; single policy per call)
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
  stageConfig: { allowedWritePaths?: string[]; allowedReadOnlyPaths?: string[] },
  meta: SessionMeta,
  config: PipelineConfig,
  ctx: RuntimeCtx,
  trackViolation: (item: Omit<ViolationItem, "timestamp">) => void,
  ui: ReturnType<typeof createPipelineUI>,
  access: LifecycleWriteAccess,
  opts?: { skipGitDirTargets?: boolean; allowGitLockFiles?: boolean },
): Promise<{ block: true; reason: string } | undefined> {
  const targets = extractBashFileTargets(segment);

  // 193 Phase 3 (task 8): a PENDING design-review human decision puts the
  // session in READ-ONLY mode. The check runs right after the EXISTING bash
  // classification (no new shell parser) and BEFORE the git-scope exception
  // and every permission opening: any command with a file-mutation target
  // (redirect, tee, install, git file writes, ...) is refused while a
  // decision waits. Pure reads (no classified targets) continue to the
  // regular chain.
  if (targets.length > 0) {
    const pendingReason = designReviewPendingWriteBlockReason(meta);
    if (pendingReason) {
      await trackViolation({
        type: "write_protected",
        tool: "bash",
        detail: pendingReason,
        suggestion: "Resolve the pending human decision via /pipeline-resume (owner session) first.",
      });
      ui.notify(ctx, pendingReason);
      return { block: true, reason: pendingReason };
    }
  }

  // 194 Phase 3 (C4): a blocked/readonly lifecycle (fail-closed identity,
  // stale/unknown closed-loop child, paused loop, unproven finished release)
  // refuses EVERY mutating target BEFORE the session allowance, the stage
  // whitelist and any protection opening can pass.
  if (targets.length > 0 && (access.policy.mode === "blocked" || access.policy.mode === "readonly")) {
    const reason =
      `FORBIDDEN: Bash command mutates files while the design-review lifecycle refuses writes ` +
      `(${access.policy.reason ?? access.policy.mode}). Writable now: ${describeWriteScope(access.policy)}`;
    await trackViolation({
      type: "write_protected",
      tool: "bash",
      detail: reason,
      suggestion: "Resolve the lifecycle state via the owner (decision / recovery) first.",
    });
    ui.notify(ctx, reason);
    return { block: true, reason };
  }

  const sessionPaths = meta.sessionAllowedWritePaths || [];
  // Phase 1 (190) Fix-A extension: detect session role once for child hard-block checks
  const { isChild } = detectSessionRole(ctx);
  // 194 Phase 1 (C4) / Phase 3 (task 1): the scope comes from the lifecycle
  // access decision (runtime identity + shared write policy), so the guard
  // authorizes exactly what the lifecycle declares and nothing wider.
  const writePolicy = access.policy;
  const drState = meta.designReview;

  for (const t of targets) {
    // Phase 1 / 177 (D3): a "suspicious" target is source text captured by `>`
    // rather than a real path (e.g. `List<String> ids,`). Route it to the user
    // via ask instead of silently blocking or allowing it.
    if (t.suspicious) {
      const outcome = await askCommandDecision(ctx, meta, segment, config);
      if (outcome.decision === "block") {
        const reason = `FORBIDDEN: ambiguous write target '${t.target}' in bash command (looks like non-path text).`;
        // Phase 4 (173) C11: dismissed action does NOT count as violation
        if (outcome.action !== "dismissed") {
          await trackViolation({
            type: "write_protected", tool: "bash", detail: reason,
            suggestion: `Confirm the ambiguous write target or rewrite the command.`,
          });
        }
        ui.notify(ctx, reason);
        return { block: true, reason };
      }
      continue;
    }

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

      // Phase 4 (191) + 192 Phase 4 (F07): Design-review dynamic scope
      // enforcement over the CANONICAL path (parent-directory links of
      // not-yet-existing leaves included). Resolution errors BLOCK — broken
      // links / ELOOP / permission problems are never "file does not exist"
      // pass-throughs.
      // 194 Phase 3 (task 1): the branch is keyed on the POLICY MODE, not on
      // the mere presence of an operation, so `blocked`/`readonly` decisions
      // above and the `finished` release below are never swallowed here.
      if (writePolicy.mode === "scoped" && drState && drState.operation) {
        const strictRes = await resolveSymlinkPathStrict(absTarget);
        if (!strictRes.ok) {
          const reason = `FORBIDDEN: cannot canonicalize bash target '${relPath}' (${strictRes.reason}); design-review scope requires a resolvable path.`;
          await trackViolation({
            type: "write_protected",
            tool: "bash",
            detail: reason,
            suggestion: "Resolve or remove the broken/looping symlink before writing.",
          });
          ui.notify(ctx, reason);
          return { block: true, reason };
        }
        const resolvedAbsTarget = strictRes.resolved;
        const resolvedRelPath = toProjectRelative(config.projectRoot, resolvedAbsTarget);
        // 192 fix (issue 4, plan Phase 4 task 9): verify SOURCE and REAL
        // TARGET both against the dynamic scope. A link that resolves
        // OUTSIDE the project root (resolvedRelPath === null) is
        // out-of-scope — fail closed, never fall back to the lexical path.
        // 194 Phase 1 (C4): the EXACT writable list comes from the shared
        // write policy (single source for guard + prompt), so a standalone
        // update can create exactly its own receipt document and nothing
        // else; paused/blocked lifecycle states refuse every mutation.
        const sourceInScope = isPathWithinWriteScope(writePolicy, config.projectRoot, absTarget);
        const realTargetInScope =
          resolvedRelPath !== null &&
          isPathWithinWriteScope(writePolicy, config.projectRoot, resolvedAbsTarget);
        if (!sourceInScope || !realTargetInScope) {
          const reason = `FORBIDDEN: Target '${relPath}' is outside design-review dynamic write scope for operation '${drState.operation.kind}'. Writable now: ${describeWriteScope(writePolicy)}`;
          await trackViolation({
            type: "write_protected",
            tool: "bash",
            detail: reason,
            suggestion: `Design-review scope: operation=${drState.operation.kind}, phase=${drState.phase}.`,
          });
          ui.notify(ctx, reason);
          return { block: true, reason };
        }
      }

      // 194 Phase 3 (C4, task 1): the finished release keeps the cycle's own
      // documents closed — plan, every round's review report, update receipts.
      // This runs BEFORE the session allowance bypass below, because
      // sessionAllowedWritePaths must never reopen a finished artifact.
      if (writePolicy.finishedRelease && drState) {
        const strictRes = await resolveSymlinkPathStrict(absTarget);
        if (!strictRes.ok) {
          const reason = `FORBIDDEN: cannot canonicalize bash target '${relPath}' (${strictRes.reason}); the finished design-review cycle requires a resolvable path to check its read-only documents.`;
          await trackViolation({
            type: "write_protected",
            tool: "bash",
            detail: reason,
            suggestion: "Resolve or remove the broken/looping symlink before writing.",
          });
          ui.notify(ctx, reason);
          return { block: true, reason };
        }
        const artifactHit =
          isFinishedReleaseProtectedPath(config.projectRoot, absTarget, drState)
          || isFinishedReleaseProtectedPath(config.projectRoot, strictRes.resolved, drState);
        if (artifactHit) {
          const reason = `FORBIDDEN: Bash target '${relPath}' belongs to the finished design-review cycle (plan, review report or update receipt) and stays read-only. Writable now: ${describeWriteScope(writePolicy)}`;
          await trackViolation({
            type: "write_protected",
            tool: "bash",
            detail: reason,
            suggestion: "The design-review cycle is finished; its documents are closed. Write the develop deliverables instead.",
          });
          ui.notify(ctx, reason);
          return { block: true, reason };
        }
      }

      // Session allowance early bypass
      if (sessionPaths.includes(relPath)) continue;

      // 195 Phase 1: Get stage deliverable exemptions for read-only path checks
      const exemptedPaths = getStageDeliverableExemptions(meta, meta.currentStage);
      
      // Stage-level write whitelist check (with read-only path priority)
      const stageCheck = checkStageWriteBlock(relPath, stageConfig.allowedWritePaths, meta.currentStage, state, stageConfig.allowedReadOnlyPaths, exemptedPaths);
      
      // 195 Phase 1: Audit log when path is exempted from read-only check
      if (stageCheck.exempted) {
        await safeWriteAuditLog(
          meta.currentStage,
          {

            readonly_exempt_applied: `tool=bash, path=${relPath}`,

          },
          "info"
        );
      }
      if (stageCheck.status === "block") {
        if (config.protect?.ask === true && isPathProtectedForModify(relPath, state)) {
          // Phase 1 (190) Fix-A extension: child sessions hard-block immediately
          const protectionType = isHardcodedProtected(relPath, state.hardcoded) ? "hardcoded" : "gitignore";
          const childBlock = await childHardBlockForProtectedPath(
            isChild, relPath, protectionType, state, "bash", trackViolation, ui, ctx
          );
          if (childBlock) return childBlock;
          
          const outcome = await askProtectDecision(ctx, meta, relPath, config);
          if (outcome.decision === "block") {
            // Phase 4 (173) C11: dismissed action does NOT count as violation
            if (outcome.action !== "dismissed") {
              await trackViolation({
                type: "write_protected", tool: "bash", detail: stageCheck.reason,
                suggestion: `Stage whitelist: [${(stageConfig.allowedWritePaths || []).join(", ")}].`,
              });
            }
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
            // Phase 1 (190) Fix-A extension: child sessions hard-block immediately
            const protectionType = isHardcodedProtected(relPath, state.hardcoded) ? "hardcoded" : "gitignore";
            const childBlock = await childHardBlockForProtectedPath(
              isChild, relPath, protectionType, state, "bash", trackViolation, ui, ctx
            );
            if (childBlock) return childBlock;
            
            const outcome = await askProtectDecision(ctx, meta, relPath, config);
            if (outcome.decision === "block") {
              const reason = `FORBIDDEN: Bash command modifies protected path '${relPath}'.`;
              // Phase 4 (173) C11: dismissed action does NOT count as violation
              if (outcome.action !== "dismissed") {
                await trackViolation({ type: "write_protected", tool: "bash", detail: reason, suggestion: `Protected paths: ${state.hardcoded.join(", ")} + gitignore patterns.` });
              }
              ui.notify(ctx, reason);
              return { block: true, reason };
            }
            continue;
          }
          const reason = `FORBIDDEN: Bash command modifies protected path '${relPath}'.`;
          await trackViolation({ type: "write_protected", tool: "bash", detail: reason, suggestion: `Protected paths: ${state.hardcoded.join(", ")} + gitignore patterns.` });
          ui.notify(ctx, reason);
          return { block: true, reason };
        }
      }
    } else {
      // Path outside project root
      // 194 Phase 3 (C4, task 1): a finished cycle's PINNED documents (plan
      // living outside the project root) stay read-only even as absolute
      // out-of-root targets — canonical exact match, no directory grants.
      if (writePolicy.finishedRelease && drState && isFinishedReleaseProtectedPath(config.projectRoot, absTarget, drState)) {
        const reason = `FORBIDDEN: Bash target '${t.target}' resolves to a finished design-review cycle document (plan, review report or update receipt) and stays read-only. Writable now: ${describeWriteScope(writePolicy)}`;
        await trackViolation({
          type: "write_protected",
          tool: "bash",
          detail: reason,
          suggestion: "The design-review cycle is finished; its documents are closed.",
        });
        ui.notify(ctx, reason);
        return { block: true, reason };
      }
      const isWhitelistMode =
        stageConfig.allowedWritePaths !== undefined &&
        !stageConfig.allowedWritePaths.includes(ALLOWED_WRITE_ALL);

      // Redirect-class out-of-project targets are always allowed
      if (t.kind === "redirect") continue;

      // file-arg class: block in whitelist mode
      if (isWhitelistMode) {
        // G5 (188): when protect.ask is enabled, prompt the user before blocking
        if (config.protect?.ask) {
          const outcome = await askCommandDecision(ctx, meta, absTarget, config);
          if (outcome.decision === "allow") {
            continue; // user allowed this out-of-project target
          }
        }
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
        // When piWorkDir differs from default, also skip traversing into it
        const extraSkip = resolveGitignoreSkipDirs(config);
        gitignoreCache = await loadGitignoreInfo(config.projectRoot, extraSkip);
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
      const rawMeta = ctx.session.getMeta() as SessionMeta | undefined;
      // Phase 2b (173) C3: dormant guard — full pass-through (🔴-1)
      // Default (DORMANT_KEEP_PROTECTION=false): ALL checks bypassed
      // Switch=true: only silencing side bypassed; protection chain remains
      // When KEEP_PROTECTION=true: skip stage whitelist and frozen intercept,
      // fall through directly to protection chain (protect/gitignore/blacklist).
      const dormantKeepProtection = !!(rawMeta && isDormant(rawMeta) && DORMANT_KEEP_PROTECTION);
      if (rawMeta && isDormant(rawMeta)) {
        if (!DORMANT_KEEP_PROTECTION) return undefined;
        // DORMANT_KEEP_PROTECTION=true: fall through to protection chain only
        // Implementation: stage whitelist and frozen sections are skipped below
      }
      if (!rawMeta?.pipelineId) return undefined;
      const meta: SessionMeta = rawMeta;
      // Phase 2b (173) C3 fix: when dormant with KEEP_PROTECTION, disable stage whitelist
      // by treating allowedWritePaths as undefined (full mode). This ensures dormant
      // sessions bypass stage-aware checks while keeping the global protection chain.
      const stageConfig = dormantKeepProtection
        ? { ...config.stages[meta.currentStage], allowedWritePaths: undefined }
        : config.stages[meta.currentStage];
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

      // Phase 0 (186): intersection detection — warn once per stage per session when
      // allowedReadOnlyPaths and allowedWritePaths overlap.
      // Dedup uses session meta flag (per-session, per-stage) instead of module-level state.
      warnReadOnlyWriteIntersection(
        meta.currentStage,
        stageConfig.allowedReadOnlyPaths,
        stageConfig.allowedWritePaths,
        ui,
        ctx,
        meta,
      );

      // 1. Tool permission check — REMOVED in Phase 0 (D0)
      // Tools are no longer restricted by allowlist; protection relies on
      // write-path whitelist, git content check, and destructive command block.

      // 2. Bash command handling
      if (toolName === "bash") {
        const command = args.command as string;
        // 194 Phase 3 (C4, task 1): ONE lifecycle decision per bash call —
        // runtime identity first, then the dynamic write scope, then the
        // original stage/global protect chains (ordinary flow untouched).
        const bashAccess = resolveLifecycleWriteAccess(
          meta,
          collectLifecycleEvidence(ctx, meta, detectSessionRole(ctx).isChild),
        );

        // ── DESTRUCTIVE COMMAND CHECK (full command, pre-split) ──
        if (isDestructiveCommand(command)) {
          const sessionCommands = meta.sessionAllowedCommands || [];
          if (!sessionCommands.includes(command)) {
            if (config.protect?.ask === true) {
              const outcome = await askCommandDecision(ctx, meta, command, config);
              if (outcome.decision === "block") {
                const reason = buildBlockedReason(command);
                // Phase 4 (173) C11: dismissed action does NOT count as violation
                if (outcome.action !== "dismissed") {
                  await trackViolation({
                    type: "bash_destructive",
                    tool: "bash",
                    detail: reason,
                    suggestion: `Use protect.ask dialog to allow, or avoid dangerous commands.`,
                  });
                }
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

            // 194 Phase 3 (C4, task 1): the lifecycle refusal covers git
            // mutations as well. A blocked/readonly/scoped decision is never
            // bypassed through the stage git policy or an ask answer — only
            // the ordinary chain (no loop, or a trusted finished release)
            // consults the existing policy.
            if (isWrite && bashAccess.policy.mode !== "ordinary") {
              const reason =
                `FORBIDDEN: Git mutation refused by the design-review lifecycle ` +
                `(${bashAccess.policy.reason ?? bashAccess.policy.mode}). Writable now: ${describeWriteScope(bashAccess.policy)}`;
              await trackViolation({
                type: "git_protected",
                tool: "bash",
                detail: reason,
                suggestion: "Resolve the lifecycle state via the owner (decision / recovery) first.",
              });
              ui.notify(ctx, reason);
              return { block: true, reason };
            }

            if (isWrite && gitPolicy !== "allow") {
              // Phase 1 / 177 (D2) tri-state truth table:
              // - "ask": always ask first (allow_once/session → pass; deny/cancel → block+violation;
              //   dismissed → block without violation)
              // - "block" (or matrix default): ask only when protect.ask === true; else hard-block
              const shouldAsk =
                gitPolicy === "ask" || (gitPolicy === "block" && config.protect?.ask === true);
              if (shouldAsk) {
                const outcome = await askCommandDecision(ctx, meta, segment, config);
                if (outcome.decision === "allow") {
                  // Allowed for this command → fall through to content validation below.
                } else {
                  const reason = buildGitWriteBlockReason(config, currentStage);
                  // Phase 4 (173) C11: dismissed action does NOT count as violation
                  if (outcome.action !== "dismissed") {
                    await trackViolation({
                      type: "git_protected",
                      tool: "bash",
                      detail: reason,
                      suggestion: `Git write operations are not allowed in the '${currentStage}' stage.`,
                    });
                  }
                  ui.notify(ctx, reason);
                  return { block: true, reason };
                }
              } else {
                // Hard block (policy "block" with protect.ask disabled, or matrix default)
                const reason = buildGitWriteBlockReason(config, currentStage);
                await trackViolation({
                  type: "git_protected",
                  tool: "bash",
                  detail: reason,
                  suggestion: `Git write operations are not allowed in the '${currentStage}' stage.`,
                });
                ui.notify(ctx, reason);
                return { block: true, reason };
              }
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
                  suggestion: `git add cannot stage protected paths (${gitState.hardcoded.join(", ")}, gitignore).`,
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
                  suggestion: `git commit cannot include protected paths (${gitState.hardcoded.join(", ")}, gitignore).`,
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
                bashAccess,
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
            bashAccess,
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
      // Phase 2b (173) C3 fix: dormant with KEEP_PROTECTION skips frozen intercept
      if (isFrozen(meta) && !dormantKeepProtection) {
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
          reason = `Pipeline frozen: ${formatFrozenReason(meta)}. ${formatDecisionMenuHint()}`;
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

      // 3c. Phase 2 / 175 (R2Q5A): Default-on evidence-based duplicate-spawn suppression.
      // Enable: stageConfig.guard?.suppressDuplicateSpawn ?? true (default true, explicit false disables).
      // Block conditions (ALL must hold):
      //   - Owner session (not child/clone — user sovereignty)
      //   - toolName in SPAWN_TOOL_NAMES
      //   - subagent_type matches resolveAgentMention(stage)
      //   - Evidence: (agentId AND probeAgentState=live) OR (reserved in-flight <60s)
      // → block with reason (NOT counted as violation).
      // Removed: 30min time-window heuristic (was unreliable without hard evidence).
      const guard = stageConfig.guard;
      const suppressEnabled = guard?.suppressDuplicateSpawn ?? true;
      if (suppressEnabled && SPAWN_TOOL_NAMES.includes(toolName)) {
        const subagentType = args.subagent_type as string | undefined;
        if (subagentType) {
          const expectedAgent = resolveAgentMention(config, meta.currentStage);
          if (expectedAgent && subagentType === expectedAgent) {
            // Domain restriction: only evaluate for owner sessions (detectSessionRole)
            const { isChild } = detectSessionRole(ctx);
            if (!isChild) {
              // Phase 2 / 179 (G3): scan ALL stage keys, not just currentStage.
              // A still-live same-agent child left over from a previous stage was
              // invisible to the single-key read (cross-stage blind spot).
              const hit = scanActiveSpawnEvidence(meta.activeSpawns, expectedAgent);
              if (hit) {
                const crossStageSuffix = hit.stage !== meta.currentStage ? `, stage: ${hit.stage}` : "";
                const suppressReason = `Stage executor '${expectedAgent}' is already running${hit.agentId ? ` (id ${hit.agentId})` : ""} [evidence: ${hit.basis}${crossStageSuffix}]. Await its result; do not spawn a duplicate.`;
                await safeWriteAuditLog("spawn_suppressed", {
                  pipelineId: meta.pipelineId,
                  stage: meta.currentStage,
                  tool: toolName,
                  subagentType,
                  agentId: hit.agentId ?? "",
                  basis: hit.basis,
                  evidenceStage: hit.stage,
                });
                return { block: true, reason: suppressReason };
              }

              // Phase 0 (182): secondary name-probe — detect manual/out-of-band
              // agents that are live but not in the activeSpawns ledger.
              // Reuses the spawn_suppressed audit event with basis "manual_live_probe".
              const nameProbe = findLiveAgentByName(expectedAgent);
              if (nameProbe) {
                const suppressReason = `Stage executor '${expectedAgent}' is already running (id ${nameProbe.agentId}) [evidence: manual_live_probe]. Await its result; do not spawn a duplicate.`;
                await safeWriteAuditLog("spawn_suppressed", {
                  pipelineId: meta.pipelineId,
                  stage: meta.currentStage,
                  tool: toolName,
                  subagentType,
                  agentId: nameProbe.agentId,
                  basis: "manual_live_probe",
                  evidenceStage: meta.currentStage,
                });
                return { block: true, reason: suppressReason };
              }
            }
          }
        }
      }

      // 3d. Phase 4 / 177 (D7): plugin-owned spawn takeover.
      // Four conditions (ALL must hold):
      //   - owner session (child sessions never spawn in place)
      //   - currentStage ∈ config.takeoverStages (default: ["clarify"])
      //   - toolName ∈ SPAWN_TOOL_NAMES (Agent)
      //   - subagent_type === resolveAgentMention(config, stage)
      // On hit: write reserved evidence FIRST (side effect ①), then block and
      // route the spawn to the owner via pendingSpawns. NOT a violation (②).
      const takeoverStages = config.takeoverStages ?? ["clarify"];
      if (SPAWN_TOOL_NAMES.includes(toolName) && takeoverStages.includes(meta.currentStage)) {
        const takeoverSubagentType = args.subagent_type as string | undefined;
        if (takeoverSubagentType) {
          const takeoverAgent = resolveAgentMention(config, meta.currentStage);
          if (takeoverAgent && takeoverSubagentType === takeoverAgent) {
            const { isChild: takeoverIsChild } = detectSessionRole(ctx);
            if (!takeoverIsChild) {
              const reservedId = `takeover-${meta.currentStage}-${Date.now()}`;
              const latest = ctx.session.getMeta() as SessionMeta;
              // Side effect ①: reserve evidence BEFORE returning block so an
              // immediate model retry is caught by the 3c duplicate-spawn guard.
              ctx.session.updateMeta({
                activeSpawns: {
                  ...(latest.activeSpawns ?? {}),
                  [meta.currentStage]: {
                    agentName: takeoverAgent,
                    agentId: reservedId,
                    startedAt: Date.now(),
                    reserved: true,
                  },
                },
                pendingSpawns: {
                  ...(latest.pendingSpawns ?? {}),
                  [meta.currentStage]: {
                    agentName: takeoverAgent,
                    requestedAt: Date.now(),
                    attempts: latest.pendingSpawns?.[meta.currentStage]?.attempts ?? 0,
                  },
                },
              });
              await safeWriteAuditLog("spawn_takeover_blocked", {
                pipelineId: meta.pipelineId,
                stage: meta.currentStage,
                tool: toolName,
                subagentType: takeoverSubagentType,
                reservedId,
              });
              // Side effect ②: takeover block is NOT counted as a violation.
              return {
                block: true,
                reason: `Plugin-owned spawn: the ${meta.currentStage} executor (id ${reservedId}) has been queued; await its result. Direct Agent/task calls are rewritten to the plugin spawn path.`,
              };
            }
          }
        }
      }

      // 3e. Phase 4 / 179 (G6): out-of-stage spawn block.
      // Spawning another stage's executor directly (e.g. develop during plan) is
      // blocked and routed to the normal confirm-gate progression. Owner-only;
      // NOT counted as a violation. The current-stage executor is handled by
      // 3c/3d above, which short-circuit first.
      // Legitimate manual progression exception (review→fix only): spawning
      // the fix executor during the review stage is allowed — this is a normal
      // human workflow after a failed review. All other cross-stage spawns
      // (including plan→develop) are blocked per Plan Phase 4 task 3 / G6.
      if (SPAWN_TOOL_NAMES.includes(toolName)) {
        const outOfStageType = args.subagent_type as string | undefined;
        if (outOfStageType) {
          const { isChild: oosIsChild } = detectSessionRole(ctx);
          if (!oosIsChild) {
            const currentAgent = resolveAgentMention(config, meta.currentStage);
            if (outOfStageType !== currentAgent) {
              let matchedStage: PipelineStage | null = null;
              for (const stageName of Object.keys(config.stages) as PipelineStage[]) {
                if (stageName === meta.currentStage) continue;
                if (!config.stages[stageName]?.agentPath) continue;
                if (resolveAgentMention(config, stageName) === outOfStageType) {
                  matchedStage = stageName;
                  break;
                }
              }
              if (matchedStage && isLegitimateManualProgression(meta.currentStage, matchedStage)) {
                // review→fix is a legitimate manual progression path — allow
                // the spawn. All other cross-stage spawns (e.g. plan→develop)
                // are blocked per Plan Phase 4 task 3 / G6.
                await safeWriteAuditLog("out_of_stage_spawn_allowed_review_fix", {
                  pipelineId: meta.pipelineId,
                  stage: meta.currentStage,
                  tool: toolName,
                  subagentType: outOfStageType,
                  targetStage: matchedStage,
                });
              } else if (matchedStage) {
                await safeWriteAuditLog("out_of_stage_spawn_blocked", {
                  pipelineId: meta.pipelineId,
                  stage: meta.currentStage,
                  tool: toolName,
                  subagentType: outOfStageType,
                  targetStage: matchedStage,
                });
                return {
                  block: true,
                  reason:
                    `Current stage is "${meta.currentStage}"; spawning the "${matchedStage}" executor ("${outOfStageType}") directly is not allowed. ` +
                    `Advance through the confirm gate (or exit/override) so the pipeline routes it correctly.`,
                };
              }
            }
          }
        }
      }

      // 4. File write protection for write/edit tools
      if (toolName === "write" || toolName === "edit") {
        // 193 Phase 3 (task 8): a PENDING design-review human decision makes
        // the session READ-ONLY — refuse mutating tools at the OPENING of the
        // permission chain (before any whitelist/scope "opening"), while the
        // corrective window of an INVALID running report (phase still
        // running) and every non-design-review flow keep working normally.
        const pendingReason = designReviewPendingWriteBlockReason(meta);
        if (pendingReason) {
          await trackViolation({
            type: "write_protected",
            tool: toolName,
            detail: pendingReason,
            suggestion: "Resolve the pending human decision via /pipeline-resume (owner session) first.",
          });
          ui.notify(ctx, pendingReason);
          return { block: true, reason: pendingReason };
        }

        const filePath = (args.file_path || args.path) as string;
        // Resolve relative paths against projectRoot to avoid cwd dependency (Problem 11)
        const absPath = path.isAbsolute(filePath)
          ? path.normalize(filePath)
          : path.resolve(config.projectRoot, filePath);
        const relPath = toProjectRelative(config.projectRoot, absPath);

        // Phase 4 (191): Design-review dynamic write scope enforcement.
        // 194 Phase 3 (C4, task 1): ONE lifecycle decision ordered runtime
        // identity → dynamic scope → the original stage/global protect chain.
        // `finished` releases writes ONLY on the trusted handoff receipt,
        // and even then the cycle's plan/report/receipt documents stay
        // read-only; a stale or unverifiable closed-loop child never
        // inherits the current operation's permissions. The decision runs
        // BEFORE the in/out-of-root split so a refused lifecycle cannot be
        // dodged with an absolute path.
        const { isChild } = detectSessionRole(ctx);
        const lifecycleAccess = resolveLifecycleWriteAccess(
          meta,
          collectLifecycleEvidence(ctx, meta, isChild),
        );
        const writePolicy = lifecycleAccess.policy;
        const drState = meta.designReview;

        // blocked/readonly lifecycle: refuse EVERY write attempt, fail closed,
        // before any whitelist/session-allowance opening can pass.
        if (writePolicy.mode === "blocked" || writePolicy.mode === "readonly") {
          const reason =
            `FORBIDDEN: Path '${relPath ?? absPath}' is refused by the design-review lifecycle ` +
            `(${writePolicy.reason ?? writePolicy.mode}). Writable now: ${describeWriteScope(writePolicy)}`;
          await trackViolation({
            type: "write_protected",
            tool: toolName,
            detail: reason,
            suggestion: "Resolve the lifecycle state via the owner (decision / recovery) first.",
          });
          ui.notify(ctx, reason);
          return { block: true, reason };
        }

        if (relPath) {
          const state = await getProtectState();

          // scoped lifecycle: the EXACT writable list (shared with the prompt),
          // checked against BOTH the lexical source and the symlink-resolved
          // real target. ordinary + finishedRelease: the cycle's own documents
          // are closed; everything else falls through to the original chain.
          if (
            (writePolicy.mode === "scoped" && drState && drState.operation)
            || (writePolicy.mode === "ordinary" && writePolicy.finishedRelease && drState)
          ) {
            // 192 Phase 4 (F07): canonical resolution covering parent dirs of
            // not-yet-existing files; a resolution error BLOCKS (fail-closed).
            const strictRes = await resolveSymlinkPathStrict(absPath);
            if (!strictRes.ok) {
              const reason = `FORBIDDEN: cannot canonicalize '${relPath}' (${strictRes.reason}); refusing to guess scope from a lexical path.`;
              await trackViolation({
                type: "write_protected",
                tool: toolName,
                detail: reason,
                suggestion: "Resolve or remove the broken/looping symlink before writing.",
              });
              ui.notify(ctx, reason);
              return { block: true, reason };
            }
            const resolvedAbsPath = strictRes.resolved;
            const resolvedRelPath = toProjectRelative(config.projectRoot, resolvedAbsPath);

            if (writePolicy.mode === "scoped") {
              // 192 fix (issue 4, plan Phase 4 task 9): verify SOURCE and REAL
              // TARGET both against the dynamic scope. A link that resolves
              // OUTSIDE the project root (resolvedRelPath === null) is
              // out-of-scope — fail closed, never fall back to the lexical path.
              const sourceInScope = isPathWithinWriteScope(writePolicy, config.projectRoot, absPath);
              const realTargetInScope =
                resolvedRelPath !== null &&
                isPathWithinWriteScope(writePolicy, config.projectRoot, resolvedAbsPath);

              if (!sourceInScope || !realTargetInScope) {
                const operationKind = writePolicy.operationKind ?? drState.operation?.kind ?? "design-review";
                const reason = `FORBIDDEN: Path '${relPath}' is outside design-review dynamic write scope for operation '${operationKind}'. ` +
                  `Writable now: ${describeWriteScope(writePolicy)}`;
                await trackViolation({
                  type: "write_protected",
                  tool: toolName,
                  detail: reason,
                  suggestion: `Design-review scope: operation=${operationKind}, phase=${drState.phase}.`,
                });
                ui.notify(ctx, reason);
                return { block: true, reason };
              }
            } else {
              // finished release: the cycle's documents stay read-only. The
              // check runs BEFORE the session allowance bypass below, so
              // sessionAllowedWritePaths can never reopen a closed artifact.
              const artifactHit =
                isFinishedReleaseProtectedPath(config.projectRoot, absPath, drState)
                || isFinishedReleaseProtectedPath(config.projectRoot, resolvedAbsPath, drState);
              if (artifactHit) {
                const reason = `FORBIDDEN: Path '${relPath}' belongs to the finished design-review cycle (plan, review report or update receipt) and stays read-only. ` +
                  `Writable now: ${describeWriteScope(writePolicy)}`;
                await trackViolation({
                  type: "write_protected",
                  tool: toolName,
                  detail: reason,
                  suggestion: "The design-review cycle is finished; its documents are closed. Write the develop deliverables instead.",
                });
                ui.notify(ctx, reason);
                return { block: true, reason };
              }
            }
          }

          // Session-level file allowance: bypasses whitelist + global chain entirely.
          // Pre-evaluated once so downstream branches can skip redundant checks.
          const sessionPaths = meta.sessionAllowedWritePaths || [];
          const sessionAllowed = sessionPaths.includes(relPath);

          if (!sessionAllowed) {
            // 195 Phase 1: Get stage deliverable exemptions for read-only path checks
            const exemptedPaths = getStageDeliverableExemptions(meta, meta.currentStage);
            
            // Stage-level write whitelist check (with read-only path priority)
            const stageCheck = checkStageWriteBlock(relPath, stageConfig.allowedWritePaths, meta.currentStage, state, stageConfig.allowedReadOnlyPaths, exemptedPaths);
            
            // 195 Phase 1: Audit log when path is exempted from read-only check
            if (stageCheck.exempted) {
              await safeWriteAuditLog(
                meta.currentStage,
                {

                  readonly_exempt_applied: `tool=${toolName}, path=${relPath}`,

                },
                "info"
              );
            }

            if (stageCheck.status === "block") {
              // Phase 1 (190) Fix-A: child sessions hard-block immediately on protected paths
              // without entering askProtectDecision (prevents dismissCount accumulation on child)
              if (config.protect?.ask === true && isPathProtectedForModify(relPath, state)) {
                // Determine protection type for appropriate error message
                const protectionType = isHardcodedProtected(relPath, state.hardcoded) ? "hardcoded" : "gitignore";
                const childBlock = await childHardBlockForProtectedPath(
                  isChild, relPath, protectionType, state, toolName, trackViolation, ui, ctx
                );
                if (childBlock) return childBlock;
                
                const outcome = await askProtectDecision(ctx, meta, relPath, config);
                if (outcome.decision === "block") {
                  // Phase 4 (173) C11: dismissed action does NOT count as violation
                  if (outcome.action !== "dismissed") {
                    await trackViolation({
                      type: "write_protected",
                      tool: toolName,
                      detail: stageCheck.reason,
                      suggestion: `Stage whitelist: [${(stageConfig.allowedWritePaths || []).join(", ")}].`,
                    });
                  }
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
                  // Phase 1 (190) Fix-A: child sessions hard-block immediately
                  // without entering askProtectDecision (prevents dismissCount accumulation on child)
                  const childBlock = await childHardBlockForProtectedPath(
                    isChild, relPath, "hardcoded", state, toolName, trackViolation, ui, ctx
                  );
                  if (childBlock) return childBlock;
                  
                  const outcome = await askProtectDecision(ctx, meta, relPath, config);
                  if (outcome.decision === "block") {
                    const reason = buildHardcodedForbiddenReason(relPath, state.hardcoded);
                    // Phase 4 (173) C11: dismissed action does NOT count as violation
                    if (outcome.action !== "dismissed") {
                      await trackViolation({
                        type: "write_protected",
                        tool: toolName,
                        detail: reason,
                        suggestion: `Hardcoded protected: ${state.hardcoded.join(", ")}.`,
                      });
                    }
                    ui.notify(ctx, reason);
                    return { block: true, reason };
                  }
                  // "allow" → proceed with hash recording
                } else {
                  const reason = buildHardcodedForbiddenReason(relPath, state.hardcoded);
                  await trackViolation({
                    type: "write_protected",
                    tool: toolName,
                    detail: reason,
                    suggestion: `Hardcoded protected: ${state.hardcoded.join(", ")}.`,
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
                      // Phase 1 (190) Fix-A extension: child sessions hard-block on gitignore paths
                      const childBlock = await childHardBlockForProtectedPath(
                        isChild, relPath, "gitignore", state, toolName, trackViolation, ui, ctx
                      );
                      if (childBlock) return childBlock;
                      
                      const outcome = await askProtectDecision(ctx, meta, relPath, config);
                      if (outcome.decision === "block") {
                        const reason = `FORBIDDEN: Cannot modify protected path '${relPath}' (gitignore protected).`;
                        // Phase 4 (173) C11: dismissed action does NOT count as violation
                        if (outcome.action !== "dismissed") {
                          await trackViolation({
                            type: "write_protected",
                            tool: toolName,
                            detail: reason,
                            suggestion: `Gitignore protected. Use protect.allow to exempt specific paths.`,
                          });
                        }
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
          // Path outside project root
          // 194 Phase 3 (C4, task 1): a finished cycle's PINNED documents stay
          // read-only even when addressed as absolute out-of-root targets
          // (exact canonical match only — no directory grants).
          if (
            writePolicy.finishedRelease
            && drState
            && isFinishedReleaseProtectedPath(config.projectRoot, absPath, drState)
          ) {
            const reason = `FORBIDDEN: Path '${absPath}' is a document of the finished design-review cycle and stays read-only. ` +
              `Writable now: ${describeWriteScope(writePolicy)}`;
            await trackViolation({
              type: "write_protected",
              tool: toolName,
              detail: reason,
              suggestion: "The design-review cycle is finished; its documents are closed.",
            });
            ui.notify(ctx, reason);
            return { block: true, reason };
          }
          const isWhitelistMode =
            stageConfig.allowedWritePaths !== undefined &&
            !stageConfig.allowedWritePaths.includes(ALLOWED_WRITE_ALL);
          if (isWhitelistMode) {
            // G5 (188): when protect.ask is enabled, prompt the user before blocking
            if (config.protect?.ask) {
              const outcome = await askCommandDecision(ctx, meta, absPath, config);
              if (outcome.decision === "allow") {
                // User allowed — skip the block, fall through to hash recording
              } else {
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
            } else {
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
