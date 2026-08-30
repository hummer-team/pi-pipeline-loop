/**
 * @module loop-breaker
 * Factory for the `tool_result` hook.
 * Handles loop iteration counting, circuit breaking on max failures,
 * and file modification diff archiving for audit trails.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig, Hook, SessionMeta } from "../types";
import type { RuntimeCtx } from "./runtime-ctx";
import { getFileHash } from "../utils/hash";
import { writeAuditLog } from "../utils/auditLog";
import { createPipelineUI } from "./pipeline-ui";
import { freezeAndPrompt } from "./flow-state";

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
export function createLoopBreaker(config: PipelineConfig): Hook<"tool_result"> {
  const ui = createPipelineUI(config);
  // Tracks the verifyAttempts value at which loopCount was last incremented
  // via write/edit throttling. Prevents multiple increments within the same
  // verification cycle (between consecutive agent_settled failures).
  let lastLoopIncrementAttempt = -1;

  return {
    event: "tool_result",
    handler: async (ctx: RuntimeCtx): Promise<void> => {
      const meta = ctx.session.getMeta() as SessionMeta;
      const projectRoot = config.projectRoot;
      const auditDir = config.auditDir || ".pi/audit";
      // tool_result events always populate toolCall (buildRuntimeCtx guarantees it)
      const toolCall = ctx.toolCall!;

      // ── 0. Assistant message collection removed (Q4-A) ──────────
      // Phase 3 will use extractAssistantMessages(ctx) for real-time extraction.

      // ── 1. Test failure counting and circuit breaker ─────────────────
      if (
        toolCall.name === "bash" &&
        typeof toolCall.arguments?.command === "string" &&
        isTestCommand(toolCall.arguments.command as string)
      ) {
        if (
          ctx.result?.exitCode !== 0 &&
          (meta.currentStage === "develop" || meta.currentStage === "fix")
        ) {
          const newLoopCount = meta.loopCount + 1;
          ctx.session.updateMeta({ loopCount: newLoopCount });

          if (newLoopCount >= meta.maxLoops) {
            // Circuit break: freeze pipeline and prompt for user decision
            ui.fail(ctx, meta.currentStage, "pipeline frozen");

            await writeAuditLog("loop_break_fatal", {
              pipelineId: meta.pipelineId,
              stage: meta.currentStage,
              loopCount: String(newLoopCount),
            }, "warn");

            await freezeAndPrompt(ctx, meta, "loop_overflow", config);
          }
        }
      }

      // ── 1b. Verification failure loop counting ───────────────────────
      // When verifyFailures exist and the agent is making tool calls without
      // resolving them, increment loopCount to track the retry attempts.
      // - bash + exitCode !== 0: unconditional increment (original behavior)
      // - write/edit + success: throttled increment — only once per verifyAttempts value
      if (
        meta.verifyFailures &&
        meta.verifyFailures.length > 0 &&
        (meta.currentStage === "develop" || meta.currentStage === "fix") &&
        (toolCall.name === "write" || toolCall.name === "edit" || toolCall.name === "bash")
      ) {
        const isBashFailure = toolCall.name === "bash" && ctx.result?.exitCode !== 0;
        const isWriteEditSuccess =
          (toolCall.name === "write" || toolCall.name === "edit") &&
          ctx.result?.success;

        // Throttle write/edit increments: only increment once per verifyAttempts cycle
        const shouldThrottleIncrement = isWriteEditSuccess &&
          meta.verifyAttempts !== lastLoopIncrementAttempt;

        if (isBashFailure || shouldThrottleIncrement) {
          if (shouldThrottleIncrement) {
            lastLoopIncrementAttempt = meta.verifyAttempts ?? 0;
          }

          const newLoopCount = meta.loopCount + 1;
          ctx.session.updateMeta({ loopCount: newLoopCount });

          if (newLoopCount >= meta.maxLoops) {
            // Circuit break: freeze pipeline and prompt for user decision
            ui.fail(ctx, meta.currentStage, "pipeline frozen");

            await writeAuditLog("loop_break_fatal", {
              pipelineId: meta.pipelineId,
              stage: meta.currentStage,
              loopCount: String(newLoopCount),
              reason: "verify_failure_loop_overflow",
            }, "warn");

            await freezeAndPrompt(ctx, meta, "verify_failure_loop_overflow", config);
          }
        }
      }

      // ── 2. File modification diff archiving ──────────────────────────
      if (
        (toolCall.name === "write" || toolCall.name === "edit") &&
        ctx.result?.success
      ) {
        const filePath = (toolCall.arguments.file_path ||
          toolCall.arguments.path) as string;
        const oldHash = (toolCall as any).oldHash as string | undefined;
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
        toolCall.name === "plan_run_script" &&
        meta.currentStage === "plan" &&
        ctx.result?.success
      ) {
        const nextStepIndex = (meta.currentStepIndex ?? 0) + 1;
        ctx.session.updateMeta({
          currentStepIndex: nextStepIndex,
        });
      }
    },
  };
}
