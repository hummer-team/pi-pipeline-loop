/**
 * @module agent-settled
 * Factory for the `agent_settled` hook.
 * Logs an audit entry when the agent reaches a stable/settled state,
 * and optionally runs auto-verification if the stage has a verify block.
 */

import type { PipelineConfig, Hook, SessionMeta, VerifyFailureItem } from "../types";
import { runVerification } from "./auto-verifier";
import type { RunVerificationOptions } from "./auto-verifier";
import { writeAuditLog } from "../utils/auditLog";

/**
 * Creates the `agent_settled` hook that logs when the agent stabilizes
 * and optionally runs automatic verification for the current stage.
 *
 * 1. Writes a JSON-lines audit entry (action: "agent_settled")
 * 2. If the current stage has verify.require enabled:
 *    a. Reads verify.md (YAML frontmatter rules + Markdown prompt)
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

      // Tool mode: skip hook-based verification — agent calls pipeline_verify tool explicitly
      if (stageConfig.verify.mode === "tool") {
        await writeAuditLog("verify_mode_tool_skip", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          reason: "verify.mode=tool, verification deferred to pipeline_verify tool",
        });
        return;
      }

      const assistantMessages = meta.assistantMessages || [];
      const verifyResult = await runVerification(
        config,
        meta,
        assistantMessages,
        verifyOptions,
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
            verifyFailures: [], // clear failures on pass
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
      } else {
        // Verification failed — do NOT auto-advance
        // Write verifyFailures to SessionMeta for prompt injection feedback
        const now = Date.now();
        const verifyFailures: VerifyFailureItem[] = [];

        // Convert structured failures to VerifyFailureItem format
        if (verifyResult.structuredResult) {
          for (const f of verifyResult.structuredResult.failures) {
            verifyFailures.push({
              ruleType: f.ruleType,
              detail: f.detail,
              timestamp: now,
            });
          }
        }

        // Convert keyword missing to failures if not already captured
        if (verifyResult.ruleMissing.length > 0 && !verifyFailures.some(f => f.ruleType === "keywords")) {
          verifyFailures.push({
            ruleType: "keywords",
            detail: `Missing keywords: ${verifyResult.ruleMissing.join(", ")}`,
            timestamp: now,
          });
        }

        ctx.session.updateMetadata({
          ...meta,
          verifyAttempts: (meta.verifyAttempts || 0) + 1,
          verifyFailures,
          assistantMessages: [], // reset for next cycle
        });

        await writeAuditLog("auto_verify_fail", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          failureCount: String(verifyFailures.length),
          failureTypes: verifyFailures.map(f => f.ruleType).join(","),
        });

        if (ctx.ui?.notify) {
          const failureSummary = verifyFailures
            .map(f => `[${f.ruleType}] ${f.detail}`)
            .join("; ");
          ctx.ui.notify(
            `Verification failed for "${meta.currentStage}": ${failureSummary}. ` +
            `Fix the issues and try again.`,
          );
        }
      }
    },
  };
}
