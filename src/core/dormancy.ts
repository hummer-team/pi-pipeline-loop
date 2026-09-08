/**
 * @module dormancy
 * Phase 2a (173) C2 — Single source of truth for "dormant" (silent) pipeline state.
 *
 * A pipeline is "dormant" when the plugin should not intervene in the session:
 * - No meta / no pipelineId (never started)
 * - flowState === "aborted" (user_quit / user_abort / stale_startup)
 * - currentStage === "completed" (terminal state, equivalent to silent)
 *
 * The predicate is the sole determinant for the dormant-silencing matrix (Phase 2b).
 * Phase 2a introduces the predicate and no-meta defensive guards; behavior is
 * unchanged because session_start always creates meta before hooks fire.
 *
 * 🔴-1 rollback switch: DORMANT_KEEP_PROTECTION (default false).
 * When set to true, tool-guard retains protection-chain behavior for dormant sessions
 * (protect/gitignore/blacklist still active); only the silencing side (injection,
 * notification, verify, loop counting) is affected by isDormant elsewhere.
 * This switch does NOT affect other dormant consumers (prompt-injector, agent-settled,
 * session-shutdown, commands, shortcut) — only tool-guard reads it.
 */

import type { SessionMeta } from "../types";
import { detectSessionRole } from "./session-role";
import type { RuntimeCtx } from "./runtime-ctx";

/**
 * 🔴-1 Single-point rollback switch for dormant protection-chain behavior.
 *
 * When false (default): dormant sessions bypass ALL tool-guard checks
 * (stage whitelist, frozen intercept, protect, gitignore, destructive blacklist).
 * This is the Goal 4 literal semantic: "未 start = plugin does not exist".
 *
 * When true: dormant sessions still bypass injection/notification/verify/loop-counting,
 * BUT the protection chain (protect/gitignore/blacklist) remains active.
 * Use this if the business environment lacks SDK-level permission guards and
 * needs the plugin's protection chain as a safety net for dormant sessions.
 *
 * This constant only affects tool-guard's dormant branch; all other dormant
 * consumers (prompt-injector, agent-settled, session-shutdown, etc.) ignore it.
 */
export const DORMANT_KEEP_PROTECTION = false;

/**
 * Determines whether the pipeline is in a dormant (silent) state.
 *
 * Dormant conditions (any one ⇒ dormant):
 * 1. No meta or no pipelineId (never started)
 * 2. flowState === "aborted" (user_quit / user_abort / stale_startup)
 * 3. currentStage === "completed" (terminal state = silent equivalent)
 *
 * For child sessions: JOIN failure → no meta → condition 1 naturally hits
 * (no fallback pipeline creation — linked to C4). JOIN success → inherits
 * parent meta → follows parent state.
 *
 * The `role` parameter does not affect the dormant determination result.
 * It is provided for audit `hostRole` field and logging purposes.
 *
 * Wake-up point: only `/pipeline-start` (fresh / resume / adopt).
 * `/pipeline-resume` does NOT wake dormant sessions.
 *
 * @param meta - Current session metadata (may be undefined)
 * @param ctx - Optional runtime context for role detection (audit/logging only)
 * @returns true if the pipeline is dormant
 */
export function isDormant(
  meta: SessionMeta | undefined,
  ctx?: RuntimeCtx,
): boolean {
  // Condition 1: No meta or no pipelineId (never started)
  if (!meta || !meta.pipelineId) {
    return true;
  }

  // Condition 2: flowState === "aborted"
  if (meta.flowState === "aborted") {
    return true;
  }

  // Condition 3: currentStage === "completed" (terminal = silent equivalent)
  if (meta.currentStage === "completed") {
    return true;
  }

  return false;
}

/**
 * Returns the host role string for audit purposes.
 * Convenience wrapper around detectSessionRole for consistent audit field naming.
 *
 * @param ctx - Optional runtime context
 * @returns "owner" or "child"
 */
export function getHostRole(ctx?: RuntimeCtx): "owner" | "child" {
  if (!ctx) return "owner";
  try {
    const { isChild } = detectSessionRole(ctx);
    return isChild ? "child" : "owner";
  } catch {
    return "owner";
  }
}
