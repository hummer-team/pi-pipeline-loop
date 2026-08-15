/**
 * @module flow-state
 * Unified flow-state helpers for the pipeline blocking/freeze model.
 *
 * Provides a single source of truth for:
 * - Reading normalized flow state (getFlowState)
 * - Checking if the pipeline is frozen (isFrozen)
 * - Building the decision menu for the TUI (buildDecisionMenu)
 * - Executing a user decision (executeDecision)
 * - Freezing + prompting the user (freezeAndPrompt)
 *
 * All blocking entries (loop-breaker, verify-advance, loop-checker, handoff)
 * converge on freezeAndPrompt, ensuring consistent state transitions and audit.
 */

import type { PipelineConfig, SessionMeta, FlowState, PipelineStage } from "../types";
import { safeWriteAuditLog } from "../utils/auditLog";

// ─── Context Interface ──────────────────────────────────────────────────────

/**
 * Minimal context interface required by flow-state helpers.
 * Compatible with RuntimeCtx and test mock contexts.
 */
export interface FlowStateCtx {
  session: {
    getMeta: () => SessionMeta | undefined;
    updateMeta: (patch: Partial<SessionMeta>) => SessionMeta | undefined;
  };
  ui?: {
    select?: (message: string, options: string[]) => Promise<string | undefined>;
    notify?: (msg: string, level?: string) => void;
  };
}

// ─── Decision Types ─────────────────────────────────────────────────────────

/** User decision identifiers for the pipeline decision menu. */
export type PipelineDecision = "resume" | "skip" | "rollback" | "restart" | "abort";

/** Decision menu labels (Chinese, matching TUI display). */
const DECISION_LABELS: Record<PipelineDecision, string> = {
  resume: "继续尝试",
  skip: "跳过",
  rollback: "回退上一阶段",
  restart: "终止并重开",
  abort: "终止并退出",
};

// ─── getFlowState ───────────────────────────────────────────────────────────

/**
 * Returns the normalized FlowState for the given SessionMeta.
 *
 * Resolution order:
 * 1. If `meta.flowState` is explicitly set → use it.
 * 2. If `meta.terminated === true` (legacy) → map to "blocked".
 * 3. Otherwise → "running" (default).
 */
export function getFlowState(meta: SessionMeta): FlowState {
  if (meta.flowState) return meta.flowState;
  if (meta.terminated === true) return "blocked";
  return "running";
}

// ─── isFrozen ───────────────────────────────────────────────────────────────

/**
 * Returns true if the pipeline is in a frozen state where agent tools
 * should be blocked and verification should be short-circuited.
 *
 * Frozen conditions:
 * - flowState === "blocked"
 * - flowState === "aborted"
 * - currentStage === "awaiting_human" (legacy freeze point)
 */
export function isFrozen(meta: SessionMeta): boolean {
  const fs = getFlowState(meta);
  return fs === "blocked" || fs === "aborted" || meta.currentStage === "awaiting_human";
}

// ─── buildDecisionMenu ──────────────────────────────────────────────────────

/**
 * Builds the decision menu items for the TUI select dialog.
 *
 * - blocked / awaiting_human → 5 items (resume/skip/rollback/restart/abort)
 * - running → 2 items (restart/abort)
 * - aborted → null (do not show menu)
 */
export function buildDecisionMenu(meta: SessionMeta): string[] | null {
  const fs = getFlowState(meta);

  if (fs === "aborted") return null;

  if (fs === "blocked" || meta.currentStage === "awaiting_human") {
    return [
      DECISION_LABELS.resume,
      DECISION_LABELS.skip,
      DECISION_LABELS.rollback,
      DECISION_LABELS.restart,
      DECISION_LABELS.abort,
    ];
  }

  // running
  return [
    DECISION_LABELS.restart,
    DECISION_LABELS.abort,
  ];
}

/** Reverse lookup: label → decision key. */
function labelToDecision(label: string): PipelineDecision | undefined {
  for (const [key, val] of Object.entries(DECISION_LABELS)) {
    if (val === label) return key as PipelineDecision;
  }
  return undefined;
}

// ─── executeDecision ────────────────────────────────────────────────────────

/**
 * Executes a user decision against the pipeline state.
 *
 * Each decision mutates SessionMeta via ctx.session.updateMeta and writes
 * a `pipeline_decision` audit log entry.
 *
 * @param ctx - FlowStateCtx with session access
 * @param meta - Current SessionMeta snapshot
 * @param decision - The decision to execute
 * @param config - PipelineConfig for stage lookups
 * @returns Result object with success flag and message
 */
export async function executeDecision(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  decision: PipelineDecision,
  config: PipelineConfig,
): Promise<{ success: boolean; message: string }> {
  const fromStage = meta.currentStage;

  switch (decision) {
    case "resume": {
      const toStage = meta.currentStage === "awaiting_human"
        ? (meta.previousStage ?? "clarify")
        : meta.currentStage;

      ctx.session.updateMeta({
        flowState: "running",
        blockedReason: undefined,
        loopCount: 0,
        verifyAttempts: 0,
        verifyFailures: [],
        ...(meta.currentStage === "awaiting_human"
          ? { currentStage: meta.previousStage ?? "clarify", previousStage: undefined }
          : {}),
      });

      await safeWriteAuditLog("pipeline_decision", {
        pipelineId: meta.pipelineId,
        decision,
        fromStage,
        toStage,
        reason: meta.blockedReason ?? "",
      });

      return { success: true, message: `Pipeline resumed at stage "${toStage}".` };
    }

    case "skip": {
      if (!isFrozen(meta)) {
        return { success: false, message: "Cannot skip: pipeline is not frozen." };
      }

      const stageConfig = config.stages[meta.currentStage];
      const toStage: PipelineStage = stageConfig?.nextStage ?? "completed";
      const prevStage = meta.currentStage;

      const summariesPatch = meta.summaries[prevStage]
        ? {
            summaries: {
              ...meta.summaries,
              [prevStage]: { ...meta.summaries[prevStage], status: "invalid" as const },
            },
          }
        : {};

      ctx.session.updateMeta({
        previousStage: prevStage,
        currentStage: toStage,
        stageStartTime: Date.now(),
        flowState: "running",
        blockedReason: undefined,
        loopCount: 0,
        currentStepIndex: 0,
        verifyAttempts: 0,
        verifyFailures: [],
        ...summariesPatch,
      });

      await safeWriteAuditLog("pipeline_decision", {
        pipelineId: meta.pipelineId,
        decision,
        fromStage: prevStage,
        toStage,
        reason: meta.blockedReason ?? "",
      });

      return { success: true, message: `Skipped "${prevStage}", advanced to "${toStage}".` };
    }

    case "rollback": {
      if (!isFrozen(meta)) {
        return { success: false, message: "Cannot rollback: pipeline is not frozen." };
      }

      const toStage: PipelineStage = meta.previousStage ?? "clarify";
      const prevStage = meta.currentStage;

      const summariesPatch = meta.summaries[toStage]
        ? {
            summaries: {
              ...meta.summaries,
              [toStage]: { ...meta.summaries[toStage], status: "invalid" as const },
            },
          }
        : {};

      ctx.session.updateMeta({
        currentStage: toStage,
        previousStage: undefined,
        stageStartTime: Date.now(),
        flowState: "running",
        blockedReason: undefined,
        loopCount: 0,
        currentStepIndex: 0,
        verifyAttempts: 0,
        verifyFailures: [],
        ...summariesPatch,
      });

      await safeWriteAuditLog("pipeline_decision", {
        pipelineId: meta.pipelineId,
        decision,
        fromStage: prevStage,
        toStage,
        reason: meta.blockedReason ?? "",
      });

      return { success: true, message: `Rolled back from "${prevStage}" to "${toStage}".` };
    }

    case "restart": {
      const newPipelineId = `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      ctx.session.updateMeta({
        pipelineId: newPipelineId,
        currentStage: "clarify",
        previousStage: undefined,
        stageStartTime: Date.now(),
        flowState: "running",
        blockedReason: undefined,
        terminated: undefined,
        terminateReason: undefined,
        summaries: {},
        loopCount: 0,
        currentStepIndex: 0,
        verifyAttempts: 0,
        verifyFailures: [],
        // Preserve: requirementDoc, domain (spread from meta by updateMeta merge)
      });

      await safeWriteAuditLog("pipeline_decision", {
        pipelineId: meta.pipelineId,
        decision,
        fromStage: "restart",
        toStage: "clarify",
        newPipelineId,
        reason: meta.blockedReason ?? "",
      });

      return { success: true, message: `Pipeline restarted as "${newPipelineId}" at stage "clarify".` };
    }

    case "abort": {
      ctx.session.updateMeta({
        flowState: "aborted",
        terminateReason: "user_abort",
      });

      await safeWriteAuditLog("pipeline_decision", {
        pipelineId: meta.pipelineId,
        decision,
        fromStage,
        toStage: "aborted",
        reason: meta.blockedReason ?? "",
      });

      return { success: true, message: "Pipeline aborted. Use /pipeline-start to begin a new run." };
    }

    default:
      return { success: false, message: `Unknown decision: "${String(decision)}".` };
  }
}

// ─── freezeAndPrompt ────────────────────────────────────────────────────────

/**
 * Freezes the pipeline and prompts the user for a decision via TUI select.
 *
 * Idempotent: only transitions from "running" → "blocked" on the first call.
 * Subsequent calls (already blocked) skip the state mutation but still prompt.
 *
 * Behavior:
 * 1. If flowState is "running" → set flowState="blocked" + blockedReason=reason
 * 2. Write audit `pipeline_blocked` (warn)
 * 3. If UI is available → show decision menu via ctx.ui.select
 *    - User selects → executeDecision
 *    - User cancels (undefined) → write audit `pipeline_decision_cancelled` + notify shortcut hint
 * 4. If no UI → notify + keep blocked (user must use shortcut key)
 *
 * @param ctx - FlowStateCtx with session and optional UI
 * @param meta - Current SessionMeta snapshot
 * @param reason - Machine-readable freeze reason (e.g. "loop_overflow")
 * @param config - PipelineConfig for shortcut key and stage lookups
 * @param opts - Optional overrides (ui for external callers)
 */
export async function freezeAndPrompt(
  ctx: FlowStateCtx,
  meta: SessionMeta,
  reason: string,
  config: PipelineConfig,
  opts?: { ui?: FlowStateCtx["ui"] },
): Promise<void> {
  const ui = opts?.ui ?? ctx.ui;

  // Idempotent freeze: only transition running → blocked
  if (getFlowState(meta) === "running") {
    ctx.session.updateMeta({
      flowState: "blocked",
      blockedReason: reason,
    });
  }

  // Audit: pipeline blocked (warn level)
  await safeWriteAuditLog("pipeline_blocked", {
    pipelineId: meta.pipelineId,
    stage: meta.currentStage,
    reason,
  }, "warn");

  const shortcutKey = config.decisionShortcutKey ?? "ctrl+d";
  const menu = buildDecisionMenu({ ...meta, flowState: "blocked", blockedReason: reason });
  const tuiEnabled = config.output?.pipelineStage !== false;

  if (!menu) {
    // aborted → do not prompt
    return;
  }

  if (ui?.select) {
    try {
      const selection = await ui.select(
        `Pipeline blocked: ${reason}. Choose an action:`,
        menu,
      );

      if (selection === undefined) {
        // User pressed Esc — keep blocked, notify about shortcut
        await safeWriteAuditLog("pipeline_decision_cancelled", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
        });

        if (tuiEnabled) {
          ui.notify?.(
            `Pipeline frozen. Press ${shortcutKey} to open the decision menu.`,
          );
        }
        return;
      }

      const decision = labelToDecision(selection);
      if (decision) {
        // Re-read meta after potential UI delay
        const freshMeta = ctx.session.getMeta() ?? meta;
        await executeDecision(ctx, freshMeta, decision, config);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await safeWriteAuditLog("pipeline_decision_error", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
        error: errMsg,
      }, "error");
    }
  } else {
    // No UI available — notify via available channel (gated by pipelineStage)
    if (tuiEnabled) {
      ui?.notify?.(
        `Pipeline frozen: ${reason}. Press ${shortcutKey} to open the decision menu.`,
      );
    }
  }
}
