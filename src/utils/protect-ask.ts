/**
 * @module protect-ask
 * Shared TUI 3-choice dialogs for protection decisions (protect.ask=true).
 *
 * Phase 4 (173) C11: Tri-state outcome classification.
 * - "dismissed": Fast dismiss (< 1500ms) — streaming output auto-dismiss, NOT a violation.
 * - "canceled": User Esc (≥ 1500ms) — genuine user cancel, counts as violation.
 * - "denied": User selected "Follow plugin default" — explicit deny, counts as violation.
 *
 * dismissCount accumulates across asks. When >= DEFAULT_MAX_DISMISS_COUNT (5),
 * triggers freezeAndPrompt("dismiss_overflow") on the owner side.
 *
 * Two decision flows:
 * 1. askProtectDecision — for protected-path edit decisions
 * 2. askCommandDecision — for destructive command decisions
 *
 * Options:
 * - "Follow plugin default rules (default)" → block (denied)
 * - "Allow this edit/command only" → allow (one-shot)
 * - "Allow for this session" → allow + add to session-level allowlist
 *
 * Esc / undefined / no UI → treated as dismissed or canceled based on elapsed time.
 * Every outcome is audit-logged with elapsedMs and hostRole fields.
 */

import type { SessionMeta, PipelineConfig } from "../types";
import { safeWriteAuditLog, encodeAuditValue } from "./auditLog";
import { PROTECT_ASK_DISMISS_MS, DEFAULT_MAX_DISMISS_COUNT } from "../constants";
import { freezeAndPrompt } from "../core/flow-state";
import { getHostRole } from "../core/dormancy";

/**
 * Tri-state outcome for protect-ask decisions.
 * - decision: "allow" or "block" (backward-compatible)
 * - action: "dismissed" | "canceled" | "denied" | "allow_once" | "allow_session"
 */
export interface ProtectAskOutcome {
  decision: "allow" | "block";
  action: "dismissed" | "canceled" | "denied" | "allow_once" | "allow_session";
}

/**
 * Classify the ask outcome based on selection and elapsed time.
 * - undefined + fast → dismissed (no violation, increment dismissCount)
 * - undefined + slow → canceled (violation)
 * - options[0] → denied (violation)
 * - options[1] → allow_once
 * - options[2] → allow_session
 */
function classifyOutcome(
  selection: string | undefined,
  elapsed: number,
  options: string[],
): { action: ProtectAskOutcome["action"]; decision: "allow" | "block" } {
  if (selection === undefined) {
    // Fast dismiss → streaming output auto-dismiss (not user Esc)
    if (elapsed < PROTECT_ASK_DISMISS_MS) {
      return { action: "dismissed", decision: "block" };
    }
    // Slow dismiss → user Esc (genuine cancel)
    return { action: "canceled", decision: "block" };
  }
  if (selection === options[0]) {
    return { action: "denied", decision: "block" };
  }
  if (selection === options[1]) {
    return { action: "allow_once", decision: "allow" };
  }
  if (selection === options[2]) {
    return { action: "allow_session", decision: "allow" };
  }
  // Unknown selection → treat as canceled
  return { action: "canceled", decision: "block" };
}

/**
 * Handle dismissCount increment and overflow guardrail.
 * Called when action is "dismissed". If dismissCount >= threshold, triggers freeze.
 */
async function handleDismissOverflow(
  ctx: any,
  meta: SessionMeta,
  config: PipelineConfig,
): Promise<void> {
  const currentCount = (meta.dismissCount ?? 0) + 1;
  ctx.session.updateMeta({ dismissCount: currentCount });

  if (currentCount >= DEFAULT_MAX_DISMISS_COUNT) {
    // Trigger freeze on owner side (P1 gate ensures child → owner presentation)
    const freshMeta = ctx.session.getMeta() ?? meta;
    await freezeAndPrompt(ctx, freshMeta, "dismiss_overflow", config);
  }
}

/**
 * Prompt the user with a 3-choice dialog for a protected-path decision.
 *
 * @param ctx - Runtime context (must expose `ui.select` and `session.updateMeta`)
 * @param meta - Current session metadata
 * @param relPath - Relative path of the protected file (for display + audit)
 * @param config - Pipeline configuration (for dismiss_overflow freeze)
 * @returns ProtectAskOutcome with decision and action
 */
export async function askProtectDecision(
  ctx: any,
  meta: SessionMeta,
  relPath: string,
  config: PipelineConfig,
): Promise<ProtectAskOutcome> {
  const options = [
    "Follow plugin default rules (default)",
    "Allow this edit only",
    "Allow edits for this session",
  ];

  let selection: string | undefined;
  // Phase 4 (173) C11: Track whether UI is available for noUi audit tagging.
  // Per plan Phase 4 §2: no UI / select throws ⇒ classify as dismissed but
  // do NOT increment dismissCount (environment fact, not user behavior).
  const hasUi = typeof ctx?.ui?.select === "function";
  let selectThrew = false;
  const attemptAt = Date.now();
  try {
    if (hasUi) {
      selection = await ctx.ui.select(`Protected file edit: ${relPath}`, options);
    }
  } catch (err) {
    // Log diagnostic info on select failure, then fall through to dismissed/block (fail-safe).
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[protect-ask] askProtectDecision select error: relPath="${relPath}", error=${errMsg}`);
    selection = undefined;
    selectThrew = true;
  }
  const elapsed = Date.now() - attemptAt;
  // noUi: true when UI is absent OR select threw (environment fact, not user behavior)
  const noUi = !hasUi || selectThrew;

  // Encode file path for audit (| → %7C, = → %3D)
  const encodedFile = encodeAuditValue(relPath);

  const { action, decision } = classifyOutcome(selection, elapsed, options);

  // Handle allow_session: add to sessionAllowedWritePaths
  if (action === "allow_session") {
    const existing = meta.sessionAllowedWritePaths || [];
    if (!existing.includes(relPath)) {
      ctx.session.updateMeta({
        sessionAllowedWritePaths: [...existing, relPath],
      });
    }
  }

  // Handle dismissed: increment dismissCount and check overflow ONLY when UI was
  // actually presented (noUi=false). Per plan Phase 4 §2: no-UI/throw must NOT
  // accumulate dismissCount — it is an environment fact, not user dismiss behavior.
  if (action === "dismissed" && !noUi) {
    await handleDismissOverflow(ctx, meta, config);
  }

  await safeWriteAuditLog("pipeline_protect_ask", {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    action,
    file: encodedFile,
    elapsedMs: String(elapsed),
    hostRole: getHostRole(ctx),
    ...(noUi ? { noUi: "true" } : {}),
  });

  return { decision, action };
}

/**
 * Prompt the user with a 3-choice dialog for a destructive command decision.
 *
 * @param ctx - Runtime context (must expose `ui.select` and `session.updateMeta`)
 * @param meta - Current session metadata
 * @param command - The destructive command (for display + audit)
 * @param config - Pipeline configuration (for dismiss_overflow freeze)
 * @returns ProtectAskOutcome with decision and action
 */
export async function askCommandDecision(
  ctx: any,
  meta: SessionMeta,
  command: string,
  config: PipelineConfig,
): Promise<ProtectAskOutcome> {
  const options = [
    "Follow default rules (block, default)",
    "Allow this command once",
    "Allow this command for session",
  ];

  let selection: string | undefined;
  // Phase 4 (173) C11: Track whether UI is available for noUi audit tagging.
  const hasUi = typeof ctx?.ui?.select === "function";
  let selectThrew = false;
  const attemptAt = Date.now();
  try {
    if (hasUi) {
      // Truncate long commands for display
      const displayCmd = command.length > 50 ? command.slice(0, 47) + "..." : command;
      selection = await ctx.ui.select(`Destructive command: ${displayCmd}`, options);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[protect-ask] askCommandDecision select error: command="${command}", error=${errMsg}`);
    selection = undefined;
    selectThrew = true;
  }
  const elapsed = Date.now() - attemptAt;
  const noUi = !hasUi || selectThrew;

  // Encode command for audit (| → %7C, = → %3D, newlines → space)
  const encodedCmd = encodeAuditValue(command);

  const { action, decision } = classifyOutcome(selection, elapsed, options);

  // Handle allow_session: add to sessionAllowedCommands
  if (action === "allow_session") {
    const existing = meta.sessionAllowedCommands || [];
    if (!existing.includes(command)) {
      ctx.session.updateMeta({
        sessionAllowedCommands: [...existing, command],
      });
    }
  }

  // Handle dismissed: skip dismissCount increment when noUi (environment fact).
  if (action === "dismissed" && !noUi) {
    await handleDismissOverflow(ctx, meta, config);
  }

  await safeWriteAuditLog("pipeline_command_ask", {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    action,
    command: encodedCmd,
    elapsedMs: String(elapsed),
    hostRole: getHostRole(ctx),
    ...(noUi ? { noUi: "true" } : {}),
  });

  return { decision, action };
}
