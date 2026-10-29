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
// Phase 0 (182): dispatch stage executor after choose_stage from frozen menu
import { buildOnStageChangedCallback } from "../commands/pipeline-start";
// 218 T2.5: declared-UI predicate for the merged write decision (type-only
// candidates import — no runtime utils→core dependency beyond the existing
// freeze/pipeline-start edges this file already declares).
import { isMenuCapable } from "../core/ui-capability";
import type { WriteCandidate } from "../core/write-scope/types";
import { formatCandidateList } from "../core/write-scope/types";

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
    await freezeAndPrompt(ctx, freshMeta, "dismiss_overflow", config, {
      onStageChanged: buildOnStageChangedCallback(ctx, config),
    });
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

/**
 * 218 Phase 2 (T2.5, F.3-2/Q15-B): ONE merged decision for ALL write
 * candidates of ONE tool call (bash segments included). Reuses the tri-state
 * classifier; deliberately does NOT touch `dismissCount` — whitelistMiss has
 * its own explicit-Deny breaker (`whitelistMissDenials`), and dismissed /
 * canceled are environment/user-pressure facts that must never feed
 * `dismiss_overflow`.
 *
 * Semantics:
 * - "allow_once"   → pass THIS call only (Q22-A: no persistent token).
 * - "allow_session"→ record EVERY candidate path (project-relative when in-root,
 *                    absolute when out-of-root) in `sessionAllowedWritePaths`.
 * - noUi (declared false, select absent, or select threw) → `{ block,
 *   "dismissed" }` with `noUi: true` audit — an environment fact, never a
 *   user selection. The primary no-UI host route is the caller's hard-block
 *   fallback (T2.3 flow 6); this return shape keeps a throwing select honest.
 *
 * @param ctx - Runtime context (`ui.select`, `session.getMeta/updateMeta`)
 * @param meta - Current session metadata
 * @param candidates - ALL write candidates of this tool call (protected + whitelist_miss)
 * @param config - Pipeline configuration
 * @returns ProtectAskOutcome for the merged batch
 */
export async function askWriteDecision(
  ctx: any,
  meta: SessionMeta,
  candidates: WriteCandidate[],
  config: PipelineConfig,
): Promise<ProtectAskOutcome> {
  const options = [
    "Follow plugin default rules (default)",
    "Allow these writes only",
    "Allow these writes for this session",
  ];

  // 217 review issue 2 + 218 review #5 in ONE predicate: declared false wins
  // over a present select, and a declared true WITHOUT a real select control
  // is no longer trusted (the caller's isMenuCapable gate already routes that
  // host to the visible fallback; this stays the single source of truth).
  const menuCapable = isMenuCapable(ctx);
  let selection: string | undefined;
  let selectThrew = false;
  const attemptAt = Date.now();
  try {
    if (menuCapable) {
      const display = formatCandidateList(candidates);
      selection = await ctx.ui.select(`Pipeline write approval — allow these writes?\n  ${display}`, options);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // 218 review #9: stderr is invisible to pipeline operators — the failure
    // goes to the audit sink instead (fire-and-forget, fail-open like every
    // other audit edge here).
    void safeWriteAuditLog("pipeline_write_ask_select_error", {
      pipelineId: meta.pipelineId, stage: meta.currentStage,
      count: String(candidates.length), error: encodeAuditValue(errMsg),
    }, "error");
    selection = undefined;
    selectThrew = true;
  }
  const elapsed = Date.now() - attemptAt;
  const noUi = !menuCapable || selectThrew;

  const { action, decision } = classifyOutcome(selection, elapsed, options);
  // noUi is an environment fact: force the honest "dismissed" classification
  // (block, no deny-breaker count, no dismissCount) regardless of timing.
  const finalAction: ProtectAskOutcome["action"] = noUi ? "dismissed" : action;
  const finalDecision: ProtectAskOutcome["decision"] = noUi ? "block" : decision;

  // allow_session: record ALL candidate paths in one write (deduped). The
  // caller (write-scope/decision) additionally clears the deny breaker — the
  // meta write here is idempotent against that follow-up.
  if (finalAction === "allow_session" && !noUi && ctx?.session?.updateMeta) {
    const freshMeta = (ctx.session.getMeta?.() as SessionMeta | undefined) ?? meta;
    const existing = freshMeta.sessionAllowedWritePaths || [];
    const toAdd = candidates.map((c) => c.path).filter((p) => !existing.includes(p));
    if (toAdd.length > 0) {
      ctx.session.updateMeta({ sessionAllowedWritePaths: [...existing, ...toAdd] });
    }
  }

  await safeWriteAuditLog("pipeline_write_ask", {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    action: finalAction,
    count: String(candidates.length),
    categories: Array.from(new Set(candidates.map((c) => c.category))).join(","),
    paths: candidates.map((c) => encodeAuditValue(c.path)).join(","),
    elapsedMs: String(elapsed),
    hostRole: getHostRole(ctx),
    ...(noUi ? { noUi: "true" } : {}),
  });

  // config is intentionally unused here (no dismiss overflow — see the Q15-B
  // rule above); kept in the signature for call-site symmetry with the other
  // ask*Decision functions.
  void config;
  return { decision: finalDecision, action: finalAction };
}
