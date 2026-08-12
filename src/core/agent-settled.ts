/**
 * @module agent-settled
 * Factory for the `agent_settled` hook.
 * Logs an audit entry when the agent reaches a stable/settled state,
 * and optionally runs auto-verification if the stage has a verify block.
 */

import type { PipelineConfig, Hook, SessionMeta } from "../types";
import { runVerification } from "./auto-verifier";
import type { RunVerificationOptions } from "./auto-verifier";
import { writeAuditLog } from "../utils/auditLog";
import { applyVerifyPass, applyVerifyFail } from "./verify-advance";
import { createPipelineUI } from "./pipeline-ui";
import { extractAssistantMessages } from "./session-state";

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
      const vr = await runVerification(
        config,
        meta,
        assistantMessages,
        verifyOptions,
      );

      // Build the shared result shape consumed by applyVerifyPass/applyVerifyFail
      const sharedResult = {
        structuredResult: vr.structuredResult,
        ruleMissing: vr.ruleMissing,
        verifyResult: vr.verifyResult ?? null,
      };

      if (vr.rulePassed) {
        await applyVerifyPass(ctx, meta, meta.currentStage, stageConfig.nextStage, sharedResult, {
          method: "rule",
          handleTerminal: false,
          returnResult: false,
          ui,
        });
      } else {
        await applyVerifyFail(ctx, meta, meta.currentStage, sharedResult, "rule", ui);
      }
    },
  };
}
