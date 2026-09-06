/**
 * @module loop-breaker
 * Factory for the `tool_result` hook.
 * Handles consecutive-fail loop counting (test commands in develop/fix),
 * circuit breaking on max failures, and file modification diff archiving
 * for audit trails.
 *
 * Loop counting semantics (Phase 3 / 172):
 * - Counts CONSECUTIVE test command failures, not cumulative failures.
 * - A successful test command resets the counter to 0 (normal fix→pass iteration).
 * - Only test failures in develop/fix stages contribute to the counter.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig, Hook, SessionMeta } from "../types";
import type { RuntimeCtx } from "./runtime-ctx";
import { getFileHash } from "../utils/hash";
import { writeAuditLog } from "../utils/auditLog";
import { createPipelineUI } from "./pipeline-ui";
import { freezeAndPrompt } from "./flow-state";
import { splitShellSegments } from "../utils/bash-parse";

/**
 * Ensures a directory exists, creating it recursively if needed.
 *
 * @param dirPath - Absolute path to the directory
 */
async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Known test runner executables that indicate a test command when invoked directly.
 */
const TEST_RUNNER_EXECUTABLES = new Set([
  "jest", "vitest", "pytest", "pytest3", "rspec", "mocha", "ava", "playwright",
]);

/**
 * Package manager commands that can run tests via "test" subcommand or --test flag.
 */
const PACKAGE_MANAGERS = new Set([
  "npm", "npx", "pnpm", "yarn", "bun",
]);

/**
 * Tests whether a bash command is a test command based on command structure.
 *
 * Uses segment-level parsing (splitShellSegments) to avoid false positives
 * from paths, messages, or grep patterns containing "test".
 *
 * Detection rules per segment (after stripping `rtk ` prefix):
 * 1. First token is a known test runner (jest, vitest, pytest, etc.) → test
 * 2. First token is a package manager (npm, pnpm, bun, etc.) AND
 *    remaining args contain "test" subcommand or "--test" flag → test
 * 3. First token is "node" with "--test" flag → test
 * 4. Otherwise → not a test command
 *
 * @param command - The bash command string to check
 * @returns true if the command appears to be a test command
 */
function isTestCommand(command: string): boolean {
  const segments = splitShellSegments(command);
  for (const segment of segments) {
    // Strip `rtk ` prefix (RTK rewriting observed in production)
    const stripped = segment.trim().replace(/^rtk\s+/, "");
    if (!stripped) continue;

    // Tokenize by whitespace (simple split — sufficient for first-token analysis)
    const tokens = stripped.split(/\s+/);
    const firstToken = tokens[0];

    // Rule 1: Direct test runner invocation
    if (TEST_RUNNER_EXECUTABLES.has(firstToken)) {
      return true;
    }

    // Rule 2: Package manager with "test" subcommand or "--test" flag
    if (PACKAGE_MANAGERS.has(firstToken)) {
      const rest = tokens.slice(1);
      // Check for "test" subcommand (e.g., "npm test", "bun run test", "pnpm test")
      if (rest.includes("test")) {
        return true;
      }
      // Check for "--test" flag (e.g., "node --test script.js")
      if (rest.some(t => t === "--test" || t.startsWith("--test="))) {
        return true;
      }
    }

    // Rule 3: "make test" style (first token is "make", second is "test")
    if (firstToken === "make" && tokens[1] === "test") {
      return true;
    }
  }
  return false;
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
      // Phase 3 (172): consecutive-fail semantics — success resets the counter.
      if (
        toolCall.name === "bash" &&
        typeof toolCall.arguments?.command === "string" &&
        isTestCommand(toolCall.arguments.command as string)
      ) {
        if (meta.currentStage === "develop" || meta.currentStage === "fix") {
          if (ctx.result?.exitCode !== 0) {
            // Test failure: increment consecutive-fail counter
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
          } else if (meta.loopCount > 0) {
            // Test success: reset consecutive-fail counter (normal fix→pass iteration)
            ctx.session.updateMeta({ loopCount: 0 });
            await writeAuditLog("loop_break_reset", {
              pipelineId: meta.pipelineId,
              stage: meta.currentStage,
              previousLoopCount: String(meta.loopCount),
            });
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
