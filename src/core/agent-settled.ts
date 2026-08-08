/**
 * @module agent-settled
 * Factory for the `agent_settled` hook.
 * Logs an audit entry when the agent reaches a stable/settled state,
 * and optionally runs auto-verification if the stage has a verify block.
 */

import type { PipelineConfig, Hook, SessionMeta } from "../types";
import { runVerification } from "./auto-verifier";
import { writeAuditLog } from "../utils/auditLog";

/**
 * Creates the `agent_settled` hook that logs when the agent stabilizes
 * and optionally runs automatic verification for the current stage.
 *
 * 1. Writes a JSON-lines audit entry (action: "agent_settled")
 * 2. If the current stage has verify.require enabled:
 *    a. Reads verify.md (YAML frontmatter rules + Markdown prompt)
 *    b. Runs rule-based verification against assistant messages
 *    c. If rules pass → auto-advance; if fail → schedule model verification
 *    d. Stores verification result in SessionMeta for the next agent cycle
 *
 * @param config - The pipeline configuration
 * @returns A Hook object for the "agent_settled" event
 */
export function createAgentSettled(config: PipelineConfig): Hook {
  return {
    event: "agent_settled",
    handler: async (ctx: any): Promise<void> => {
      const meta = ctx.session.getMetadata() as SessionMeta;

      // 1. Write audit log
      await writeAuditLog("agent_settled", {
        pipelineId: meta.pipelineId,
        stage: meta.currentStage,
      });

      if (ctx.ui?.notify) {
        ctx.ui.notify(`Agent settled in "${meta.currentStage}" stage`);
      }

      // 2. Auto-verification
      const stageConfig = config.stages[meta.currentStage];
      if (!stageConfig.verify?.require) {
        return;
      }

      const assistantMessages = meta.assistantMessages || [];
      const verifyResult = await runVerification(
        config,
        meta,
        assistantMessages,
      );

      if (verifyResult.rulePassed) {
        // Rule verification passed — auto-advance
        const nextStage = stageConfig.nextStage;
        if (nextStage) {
          ctx.session.updateMetadata({
            ...meta,
            previousStage: meta.currentStage,
            currentStage: nextStage,
            stageStartTime: Date.now(),
            loopCount: 0,
            currentStepIndex: 0,
          });

          await writeAuditLog("auto_verify_pass", {
            pipelineId: meta.pipelineId,
            fromStage: meta.currentStage,
            nextStage,
            method: "rule",
          });

          if (ctx.ui?.notify) {
            ctx.ui.notify(
              `Auto-verification passed for "${meta.currentStage}". ` +
                `Advanced to "${nextStage}".`,
            );
          }
        }
      } else if (verifyResult.needsModelVerify) {
        // Rule verification failed — store pending model verification in metadata
        ctx.session.updateMetadata({
          ...meta,
          verifyAttempts: (meta.verifyAttempts || 0) + 1,
          assistantMessages: [], // reset for next cycle
        });

        if (ctx.ui?.notify) {
          const missing =
            verifyResult.ruleMissing.length > 0
              ? ` Missing keywords: ${verifyResult.ruleMissing.join(", ")}.`
              : "";
          ctx.ui.notify(
            `Verification for "${meta.currentStage}" requires model review.${missing}`,
          );
        }
      }
    },
  };
}
