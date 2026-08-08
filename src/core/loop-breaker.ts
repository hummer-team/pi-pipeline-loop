/**
 * @module loop-breaker
 * Factory for the `tool_result` hook.
 * Handles loop iteration counting, circuit breaking on max failures,
 * and file modification diff archiving for audit trails.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig, Hook, SessionMeta } from "../types";
import { getFileHash } from "../utils/hash";
import { writeAuditLog } from "../utils/auditLog";

/**
 * Ensures a directory exists, creating it recursively if needed.
 *
 * @param dirPath - Absolute path to the directory
 */
async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Tests whether a bash command is likely running tests.
 *
 * Matches common test command patterns using word boundaries and
 * known test runner names, avoiding false positives from words
 * like "testing", "testament", or URLs containing "test".
 *
 * @param command - The bash command string to check
 * @returns true if the command appears to be a test command
 */
function isTestCommand(command: string): boolean {
  // Pattern matches:
  // - "test" as a standalone word (npm test, bun test, node --test, make test, etc.)
  // - Common test runner names invoked directly (jest, vitest, pytest, rspec, mocha, ava)
  const TEST_PATTERN = /\b(?:test|jest|vitest|pytest|rspec|mocha|ava)\b/i;
  return TEST_PATTERN.test(command);
}

/**
 * Creates the `tool_result` hook that intercepts tool results for:
 *
 * 1. **Loop circuit breaker** — When bash test commands fail in develop/fix stages,
 *    increments loopCount. After maxLoops failures, freezes the pipeline
 *    (switches to "awaiting_human") and writes an audit log entry.
 *
 * 2. **Diff archiving** — When write/edit tools succeed, computes old/new hashes
 *    and archives a diff file to `.pi/loops/{pipelineId}/step-{n}/loop-{n}/`.
 *    Also writes a file_modified audit log entry.
 *
 * 3. **Plan step counting** — When `plan_run_script` succeeds in the plan stage,
 *    increments currentStepIndex to track plan execution progress.
 *
 * @param config - The pipeline configuration
 * @returns A Hook object for the "tool_result" event
 */
export function createLoopBreaker(config: PipelineConfig): Hook {
  return {
    event: "tool_result",
    handler: async (ctx: any): Promise<void> => {
      const meta = ctx.session.getMetadata() as SessionMeta;
      const projectRoot = config.projectRoot;
      const auditDir = config.auditDir || ".pi/audit";

      // ── 0. Collect assistant messages for auto-verification ──────────
      // Populates SessionMeta.assistantMessages so the auto-verifier
      // has material to run keyword-based rule checks against.
      if (ctx.assistantMessage && typeof ctx.assistantMessage === "string") {
        const msgs = [...(meta.assistantMessages || []), ctx.assistantMessage];
        ctx.session.updateMetadata({ ...meta, assistantMessages: msgs });
      }

      // ── 1. Test failure counting and circuit breaker ─────────────────
      if (
        ctx.toolCall.name === "bash" &&
        typeof ctx.toolCall.arguments?.command === "string" &&
        isTestCommand(ctx.toolCall.arguments.command as string)
      ) {
        if (
          ctx.result?.exitCode !== 0 &&
          (meta.currentStage === "develop" || meta.currentStage === "fix")
        ) {
          const newLoopCount = meta.loopCount + 1;
          ctx.session.updateMetadata({ ...meta, loopCount: newLoopCount });

          if (newLoopCount >= meta.maxLoops) {
            // Circuit break: terminate pipeline
            ctx.session.updateMetadata({
              ...meta,
              loopCount: newLoopCount,
              terminated: true,
              terminateReason: "loop_overflow",
            });

            if (ctx.ui?.notify) {
              ctx.ui.notify(
                `[pi-pipeline] Pipeline ${meta.pipelineId} terminated: max loop iterations (${meta.maxLoops}) reached in "${meta.currentStage}" stage`,
              );
            }

            await writeAuditLog("loop_break_fatal", {
              pipelineId: meta.pipelineId,
              stage: meta.currentStage,
              loopCount: String(newLoopCount),
            });
          }
        }
      }

      // ── 1b. Verification failure loop counting ───────────────────────
      // When verifyFailures exist and the agent is making tool calls without
      // resolving them, increment loopCount to track the retry attempts.
      if (
        meta.verifyFailures &&
        meta.verifyFailures.length > 0 &&
        (meta.currentStage === "develop" || meta.currentStage === "fix") &&
        (ctx.toolCall.name === "write" || ctx.toolCall.name === "edit" || ctx.toolCall.name === "bash")
      ) {
        // Only increment on meaningful tool calls, not every tool result
        if (ctx.toolCall.name === "bash" && ctx.result?.exitCode !== 0) {
          const newLoopCount = meta.loopCount + 1;
          ctx.session.updateMetadata({ ...meta, loopCount: newLoopCount });

          if (newLoopCount >= meta.maxLoops) {
            ctx.session.updateMetadata({
              ...meta,
              loopCount: newLoopCount,
              terminated: true,
              terminateReason: "verify_failure_loop_overflow",
            });

            if (ctx.ui?.notify) {
              ctx.ui.notify(
                `[pi-pipeline] Pipeline ${meta.pipelineId} terminated: max loop iterations (${meta.maxLoops}) reached with unresolved verification failures in "${meta.currentStage}" stage`,
              );
            }

            await writeAuditLog("loop_break_fatal", {
              pipelineId: meta.pipelineId,
              stage: meta.currentStage,
              loopCount: String(newLoopCount),
              reason: "verify_failure_loop_overflow",
            });
          }
        }
      }

      // ── 2. File modification diff archiving ──────────────────────────
      if (
        (ctx.toolCall.name === "write" || ctx.toolCall.name === "edit") &&
        ctx.result?.success
      ) {
        const filePath = (ctx.toolCall.arguments.file_path ||
          ctx.toolCall.arguments.path) as string;
        const oldHash = (ctx.toolCall as any).oldHash as string | undefined;
        const newHash = await getFileHash(filePath);

        if (oldHash && oldHash !== newHash) {
          const diffDir = path.join(
            projectRoot,
            auditDir,
            meta.pipelineId,
            `step-${meta.currentStepIndex}`,
            `loop-${meta.loopCount}`,
          );
          await ensureDir(diffDir);
          const diffPath = path.join(
            diffDir,
            `${path.basename(filePath)}.diff.md`,
          );

          const newContent = await fs.readFile(filePath, "utf-8");
          const diff = `--- Old (hash: ${oldHash})\n+++ New (hash: ${newHash})\n${newContent}`;
          await fs.writeFile(diffPath, diff);

          await writeAuditLog("file_modified", {
            pipelineId: meta.pipelineId,
            stage: meta.currentStage,
            step: String(meta.currentStepIndex),
            loop: String(meta.loopCount),
            file: filePath,
            diff: diffPath,
          });
        }
      }

      // ── 3. Plan step counting (plan_run_script) ───────────────────────
      if (
        ctx.toolCall.name === "plan_run_script" &&
        meta.currentStage === "plan" &&
        ctx.result?.success
      ) {
        const nextStepIndex = (meta.currentStepIndex ?? 0) + 1;
        ctx.session.updateMetadata({
          ...meta,
          currentStepIndex: nextStepIndex,
        });
      }
    },
  };
}
