/**
 * @module agent-settled
 * Factory for the `agent_settled` hook.
 * Logs an audit entry when the agent reaches a stable/settled state,
 * and optionally runs auto-verification if the stage has a verify block.
 */

import type { PipelineConfig, Hook, SessionMeta } from "../types";
import { runVerification } from "./auto-verifier";
import type { RunVerificationOptions } from "./auto-verifier";
import { writeAuditLog, writeStageAudit } from "../utils/auditLog";
import { applyVerifyPass, applyVerifyFail } from "./verify-advance";
import { createPipelineUI } from "./pipeline-ui";
import { extractAssistantMessages, extractToolCallRecords } from "./session-state";
import { isFrozen } from "./flow-state";
import { DEFAULT_DECISION_SHORTCUT } from "../constants";
import type { RuntimeCtx } from "./runtime-ctx";

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

      // Extract assistant messages from session branch for verification
      const assistantMessages = extractAssistantMessages(ctx._ctx);
      // Extract tool call records for selfVerifySkip (model self-verified commands)
      const toolCallRecords = extractToolCallRecords(ctx._ctx);
      const vr = await runVerification(
        config,
        meta,
        assistantMessages,
        { ...verifyOptions, toolCallRecords },
      );

      // Build the shared result shape consumed by applyVerifyPass/applyVerifyFail
      const sharedResult = {
        structuredResult: vr.structuredResult,
        ruleMissing: vr.ruleMissing,
        verifyResult: vr.verifyResult ?? null,
      };

      if (vr.rulePassed) {
        // Clear advancedThisTurn flag on successful verification (prevent residual state)
        const clearedMeta = { ...meta, advancedThisTurn: undefined };
        // Capture stage names BEFORE applyVerifyPass mutates meta.currentStage
        const fromStage = meta.currentStage;
        const toStage = stageConfig.nextStage;
        await applyVerifyPass(ctx, clearedMeta, fromStage, toStage, sharedResult, {
          method: "rule",
          handleTerminal: false,
          returnResult: false,
          ui,
        });

        // Phase 1 (139): Unified stage audit for hook auto-advance path.
        // Ensures hook path writes the same stage_advance/pipeline_completed events
        // as the tool path (stage-advancer), eliminating audit dual-track.
        if (toStage && toStage !== "completed") {
          await writeStageAudit(config, "stage_advance", clearedMeta, {
            fromStage,
            toStage,
            method: "hook_auto_advance",
          });
        } else {
          // Terminal stage: fix→completed or null nextStage
          await writeStageAudit(config, "pipeline_completed", clearedMeta, {
            fromStage,
            finalStage: fromStage,
            method: "hook_auto_advance",
          });
        }

        // 138: Wake next stage — trigger model to begin work in the new stage
        // Only for hook-mode stages with a non-terminal next stage (clarify/develop/fix).
        // Tool-mode stages (plan) and terminal stages (completed/null) are excluded here
        // and handled by their own paths (stage_advance tool or no-op).
        const pi = (ctx as RuntimeCtx).pi;
        if (
          pi
          && typeof pi.sendUserMessage === "function"
          && toStage
          && toStage !== "completed"
        ) {
          try {
            pi.sendUserMessage(
              `Pipeline advanced from ${fromStage} to ${toStage}. Begin the ${toStage} stage work now.`,
            );
            await writeAuditLog("auto_advance_wake", {
              pipelineId: meta.pipelineId,
              fromStage,
              toStage,
              method: "rule",
            });
          } catch (err) {
            // Defensive: sendUserMessage threw — log failure but do not reject the hook.
            // Stage has already been advanced; swallowing prevents audit loss + UX breakage.
            await writeAuditLog("auto_advance_wake_failed", {
              pipelineId: meta.pipelineId,
              fromStage,
              toStage,
              method: "rule",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else if (pi === undefined) {
          // Defensive: pi not forwarded — log skip for debug diagnostics
          await writeAuditLog("auto_advance_wake_skipped", {
            pipelineId: meta.pipelineId,
            fromStage,
            toStage: toStage ? String(toStage) : "none",
            reason: "pi not forwarded via RuntimeCtx",
          });
        }
      } else {
        await applyVerifyFail(ctx, meta, meta.currentStage, sharedResult, "rule", ui, config);
      }
    },
  };
}
