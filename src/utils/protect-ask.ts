/**
 * @module protect-ask
 * Shared TUI 3-choice dialog for protected-path edit decisions (protect.ask=true).
 *
 * Extracted from tool-guard.ts so that pipeline-init verify merge writes can
 * reuse the same decision flow when overwriting an existing verify.md.
 *
 * Options:
 * - "Follow plugin default rules (default)" → block
 * - "Allow this edit only" → allow (one-shot)
 * - "Allow edits for this session" → allow + add to sessionAllowedWritePaths
 *
 * Esc / undefined / no UI → treated as default (block).
 * Every outcome (including Esc) is audit-logged under event `pipeline_protect_ask`.
 */

import type { SessionMeta } from "../types";
import { safeWriteAuditLog } from "./auditLog";

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
  const encodedFile = relPath.replace(/\|/g, "%7C").replace(/=/g, "%3D");

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
