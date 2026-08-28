/**
 * @module agent-settled
 * Factory for the `agent_settled` hook.
 * Logs an audit entry when the agent reaches a stable/settled state,
 * and optionally runs auto-verification if the stage has a verify block.
 */

import type { PipelineConfig, Hook, SessionMeta } from "../types";
import { runVerification, precheckCompletionMarker } from "./auto-verifier";
import type { RunVerificationOptions } from "./auto-verifier";
import { writeAuditLog } from "../utils/auditLog";
import { applyVerifyFail, autoAdvanceAfterVerify } from "./verify-advance";
import { createPipelineUI } from "./pipeline-ui";
import { extractAssistantMessages, extractToolCallRecords } from "./session-state";
import { isFrozen } from "./flow-state";
import { DEFAULT_DECISION_SHORTCUT } from "../constants";
import type { RuntimeCtx } from "./runtime-ctx";
import {
  PLAN_CONFIRM_MARKER_RULE,
  shouldDeferPlanMarkerRule,
  autoWriteConfirmMarker,
  maybeHandleConfirmGate,
} from "./stage-advancer";

/**
 * Creates the `agent_settled` hook that logs when the agent stabilizes
 * and optionally runs automatic verification for the current stage.
 *
 * 1. Writes a JSON-lines audit entry (action: "agent_settled")
 * 2. If the current stage has verify.require enabled:
 *    a. Reads verify.md (YAML frontmatter rules + Markdown body prompt)
 *    b. Runs structured rule verification + optional LLM verification
 *    c. If rules pass → auto-advance; if fail → write verifyFailures, do NOT advance
 *    d. Stores verification result in SessionMeta for the next agent cycle
 *
 * @param config - The pipeline configuration
 * @param verifyOptions - Optional LLM verification options
 * @returns A Hook object for the "agent_settled" event
 */
export function createAgentSettled(
  config: PipelineConfig,
  verifyOptions?: RunVerificationOptions,
): Hook {
  const ui = createPipelineUI(config);
  return {
    event: "agent_settled",
    handler: async (ctx: any): Promise<void> => {
      const meta = ctx.session.getMeta() as SessionMeta;

      // 1. Write audit log
      await writeAuditLog("agent_settled", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
      });

      ui.notify(ctx, `Agent settled in "${meta.currentStage}" stage`);

      // 1b. Frozen short-circuit: skip verification when pipeline is frozen
      if (isFrozen(meta)) {
        await writeAuditLog("agent_settled_skipped_frozen", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
        });
        const shortcutKey = config.decisionShortcutKey ?? DEFAULT_DECISION_SHORTCUT;
        ui.notify(ctx, `Pipeline frozen. Press ${shortcutKey} to open the decision menu.`);
        return;
      }

      // C2: Idempotent guard — skip verification if stage_advance already ran this turn
      // This prevents duplicate verification noise after manual advance via tool.
      if (meta.advancedThisTurn === true) {
        await writeAuditLog("hook_skip_after_manual_advance", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          reason: "advancedThisTurn=true, stage_advance already verified this turn",
        });
        // Clear the flag to prevent residual state
        ctx.session.updateMeta({ advancedThisTurn: undefined });
        return;
      }

      // Phase 4 (162): confirm gate wiring.
      const ctxWithPi = { ...ctx, pi: (ctx as RuntimeCtx).pi };

      // 2. Auto-verification
      const stageConfig = config.stages[meta.currentStage];
      if (!stageConfig.verify?.require) {
        return;
      }

      // Tool mode: skip hook-based verification — agent calls pipeline_verify tool explicitly
      if (stageConfig.verify.mode === "tool") {
        await writeAuditLog("verify_mode_tool_skip", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          reason: "verify.mode=tool, verification deferred to pipeline_verify tool",
        });
        return;
      }

      // Phase 4 (162): Smart confirm short-circuit — defer to stage_advance tool.
      // Smart mode uses the stage_advance tool's needConfirm parameter to declare complexity,
      // so the hook should not run verification or auto-advance.
      if (stageConfig.confirm?.mode === "smart") {
        await writeAuditLog("confirm_smart_defer_to_tool", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          reason: "smart confirm defers verification+advance to stage_advance tool",
        });
        return;
      }

      // CompletionMarker precheck: if configured, verify the marker has been
      // written to the requirement doc before running verification.
      // When marker is not found: skip verification, do NOT advance, do NOT
      // increment verifyAttempts (prevents freeze loop on interactive stages).
      const marker = stageConfig.verify.completionMarker;
      if (marker && !await precheckCompletionMarker(meta, marker, config.projectRoot)) {
        await writeAuditLog("verify_completion_marker_pending", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          marker,
        });
        return;
      }

      // Phase 4 (162): auto-write confirm marker for plan stage (auto mode).
      // This writes the bilingual marker before verify runs, so the verify rule
      // passes naturally without needing deferral.
      await autoWriteConfirmMarker(config, ctxWithPi, meta, ui);

      // Extract assistant messages from session branch for verification
      const assistantMessages = extractAssistantMessages(ctx._ctx);
      // Extract tool call records for selfVerifySkip (model self-verified commands)
      const toolCallRecords = extractToolCallRecords(ctx._ctx);

      // Phase 4 (162): defer plan marker rule when confirm mode is manual (C2 fix).
      // Smart mode is already handled above (returns early).
      const deferPatterns = shouldDeferPlanMarkerRule(stageConfig) ? [PLAN_CONFIRM_MARKER_RULE] : [];

      const vr = await runVerification(
        config,
        meta,
        assistantMessages,
        { ...verifyOptions, toolCallRecords, deferContentPatterns: deferPatterns },
      );

      // Build the shared result shape consumed by applyVerifyPass/applyVerifyFail
      const sharedResult = {
        structuredResult: vr.structuredResult,
        ruleMissing: vr.ruleMissing,
        verifyResult: vr.verifyResult ?? null,
      };

      // 148 Phase 3: Config-error skip → treat as pass with notify/audit
      if (vr.skipped) {
        const errorSummary = vr.configErrors?.join("; ") ?? "unknown config error";
        ui.notify(ctx, `Verification config error: ${errorSummary}. Verification skipped. See guide.md for correct rule syntax.`);
        await writeAuditLog("verify_config_skip", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          errorCount: String(vr.configErrors?.length ?? 0),
          errors: errorSummary,
        }, "warn");
        // Treat as pass → auto-advance (reuse pass channel with ctxWithPi for wake)
        // M1 fix: skipPassAudit=true — skipped must NOT write auto_verify_pass audit
        const fromStage = meta.currentStage;
        const toStage = stageConfig.nextStage;
        await autoAdvanceAfterVerify(config, ctxWithPi, meta, fromStage, toStage, sharedResult, ui, { skipPassAudit: true });
        return;
      }

      if (vr.rulePassed) {
        // Phase 4 (162): manual confirm gate — intercept verify-pass to show TUI dialog.
        if (stageConfig.confirm?.mode === "manual") {
          const gate = await maybeHandleConfirmGate(config, ctxWithPi, meta, ui, { mode: "manual" });
          if (gate.result === "handled") {
            // advanced / routed / pending / aborted — all handled by confirm gate, skip autoAdvance
            return;
          }
          // no-gate (marker already present) — fall through to autoAdvanceAfterVerify
        }

        // Capture stage names BEFORE advance mutates meta.currentStage
        const fromStage = meta.currentStage;
        const toStage = stageConfig.nextStage;

        // Reuse ctxWithPi (declared above for gate) for autoAdvanceAfterVerify wake message
        await autoAdvanceAfterVerify(config, ctxWithPi, meta, fromStage, toStage, sharedResult, ui);
      } else {
        // 148 Phase 4: pass ctxWithPi so applyVerifyFail can send wake message via pi.sendUserMessage
        await applyVerifyFail(ctxWithPi, meta, meta.currentStage, sharedResult, "rule", ui, config);
      }
    },
  };
}
