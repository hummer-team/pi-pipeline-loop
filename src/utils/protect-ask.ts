/**
 * @module protect-ask
 * Shared TUI 3-choice dialogs for protection decisions (protect.ask=true).
 *
 * Extracted from tool-guard.ts so that pipeline-init verify merge writes can
 * reuse the same decision flow when overwriting an existing verify.md.
 *
 * Two decision flows:
 * 1. askProtectDecision — for protected-path edit decisions
 * 2. askCommandDecision — for destructive command decisions
 *
 * Options:
 * - "Follow plugin default rules (default)" → block
 * - "Allow this edit/command only" → allow (one-shot)
 * - "Allow for this session" → allow + add to session-level allowlist
 *
 * Esc / undefined / no UI → treated as default (block).
 * Every outcome (including Esc) is audit-logged.
 */

import type { SessionMeta } from "../types";
import { safeWriteAuditLog, encodeAuditValue } from "./auditLog";

/**
 * Prompt the user with a 3-choice dialog for a protected-path decision.
 *
 * @param ctx - Runtime context (must expose `ui.select` and `session.updateMeta`)
 * @param meta - Current session metadata
 * @param relPath - Relative path of the protected file (for display + audit)
 * @returns "allow" to continue the operation, "block" to reject it
 */
export async function askProtectDecision(
  ctx: any,
  meta: SessionMeta,
  relPath: string,
): Promise<"allow" | "block"> {
  const options = [
    "Follow plugin default rules (default)",
    "Allow this edit only",
    "Allow edits for this session",
  ];

  let selection: string | undefined;
  try {
    if (typeof ctx?.ui?.select === "function") {
      selection = await ctx.ui.select(`Protected file edit: ${relPath}`, options);
    }
  } catch (err) {
    // Log diagnostic info on select failure, then fall through to canceled/block (fail-safe).
    // Style consistent with checkGitAdd / checkGitCommit catch blocks.
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[protect-ask] askProtectDecision select error: relPath="${relPath}", error=${errMsg}`);
    selection = undefined;
  }

  // Encode file path for audit (| → %7C, = → %3D)
  const encodedFile = encodeAuditValue(relPath);

  let action: string;
  let decision: "allow" | "block";

  if (selection === undefined) {
    // Esc or no UI → treat as canceled (default = block)
    action = "canceled";
    decision = "block";
  } else if (selection === options[0]) {
    action = "follow_default";
    decision = "block";
  } else if (selection === options[1]) {
    action = "allow_once";
    decision = "allow";
  } else if (selection === options[2]) {
    action = "allow_session";
    decision = "allow";
    // Add to sessionAllowedWritePaths (precise relative path)
    const existing = meta.sessionAllowedWritePaths || [];
    if (!existing.includes(relPath)) {
      ctx.session.updateMeta({
        sessionAllowedWritePaths: [...existing, relPath],
      });
    }
  } else {
    // Unknown selection → treat as canceled (default = block)
    action = "canceled";
    decision = "block";
  }

  await safeWriteAuditLog("pipeline_protect_ask", {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    action,
    file: encodedFile,
  });

  return decision;
}

/**
 * Prompt the user with a 3-choice dialog for a destructive command decision.
 *
 * @param ctx - Runtime context (must expose `ui.select` and `session.updateMeta`)
 * @param meta - Current session metadata
 * @param command - The destructive command (for display + audit)
 * @returns "allow" to continue the operation, "block" to reject it
 */
export async function askCommandDecision(
  ctx: any,
  meta: SessionMeta,
  command: string,
): Promise<"allow" | "block"> {
  const options = [
    "Follow default rules (block, default)",
    "Allow this command once",
    "Allow this command for session",
  ];

  let selection: string | undefined;
  try {
    if (typeof ctx?.ui?.select === "function") {
      // Truncate long commands for display
      const displayCmd = command.length > 50 ? command.slice(0, 47) + "..." : command;
      selection = await ctx.ui.select(`Destructive command: ${displayCmd}`, options);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[protect-ask] askCommandDecision select error: command="${command}", error=${errMsg}`);
    selection = undefined;
  }

  // Encode command for audit (| → %7C, = → %3D, newlines → space)
  const encodedCmd = encodeAuditValue(command);

  let action: string;
  let decision: "allow" | "block";

  if (selection === undefined) {
    // Esc or no UI → treat as canceled (default = block)
    action = "canceled";
    decision = "block";
  } else if (selection === options[0]) {
    action = "follow_default";
    decision = "block";
  } else if (selection === options[1]) {
    action = "allow_once";
    decision = "allow";
  } else if (selection === options[2]) {
    action = "allow_session";
    decision = "allow";
    // Add to sessionAllowedCommands
    const existing = meta.sessionAllowedCommands || [];
    if (!existing.includes(command)) {
      ctx.session.updateMeta({
        sessionAllowedCommands: [...existing, command],
      });
    }
  } else {
    // Unknown selection → treat as canceled (default = block)
    action = "canceled";
    decision = "block";
  }

  await safeWriteAuditLog("pipeline_command_ask", {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    action,
    command: encodedCmd,
  });

  return decision;
}
