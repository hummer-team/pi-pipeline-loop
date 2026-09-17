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
import { writeAuditLog, encodeAuditValue } from "../utils/auditLog";
import { createPipelineUI } from "./pipeline-ui";
import { isDormant } from "./dormancy";
import { freezeAndPrompt } from "./flow-state";
// Phase 0 (182): dispatch stage executor after choose_stage from frozen menu
import { buildOnStageChangedCallback } from "../commands/pipeline-start";
import { splitShellSegments, tokenize, READ_ONLY_BASH_COMMANDS } from "../utils/bash-parse";

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
 * These tools are ALWAYS test commands regardless of arguments.
 * NOTE: mvn is intentionally NOT here — `mvn compile`/`mvn clean` are not tests.
 * mvn is handled by Rule 5 (structural: first token + "test" subcommand).
 */
const TEST_RUNNER_EXECUTABLES = new Set([
  "jest", "vitest", "pytest", "pytest3", "rspec", "mocha", "ava", "playwright",
  // 178 Phase 0 (Q8-A): additional "unconditional runner" executables.
  "phpunit", "ctest",
]);

/**
 * Package manager commands that can run tests via "test" subcommand or --test flag.
 */
const PACKAGE_MANAGERS = new Set([
  "npm", "npx", "pnpm", "yarn", "bun",
  // 178 Phase 0 (Q8-A): bunx is bun's npx equivalent (covers `bunx vitest`).
  "bunx",
]);

/**
 * 178 Phase 1 (Q7-A): Commands whose first token is deterministically NOT a
 * test command. Extends the read-only bash command set with version control,
 * text/echo utilities and container tooling. Used as the R4 guard so the R5
 * argument-position relaxation cannot reintroduce the false-positive matrix
 * (`git show test`, `echo test`, `rm test`, `tail test.md`, …).
 */
const NEVER_TEST_COMMANDS: ReadonlySet<string> = new Set([
  ...READ_ONLY_BASH_COMMANDS,
  "git", "echo", "printf", "cat", "rm", "mv", "cp", "sed", "awk", "docker", "kubectl",
]);

/**
 * 178 Phase 1 (Q7-B): Subcommand-passthrough keywords. The token AFTER one of
 * these may be a test runner (`bundle exec rspec`, `python -m pytest`) or a
 * `test`-ish subcommand (`npm run test:unit`).
 */
const TEST_SUBCOMMAND_PASSTHROUGH: ReadonlySet<string> = new Set([
  "run", "exec", "dlx", "task", "script", "-m",
]);

/**
 * 178 Phase 1 (Q9-1): True for a "bare" test token — `test` itself or a
 * `test`-prefixed lifecycle/variant token such as `test:unit`, `test_e2e`,
 * `test.spec` or `test-compile` (kept a test command per Q9-1).
 *
 * Path-like (`test/`, `test/foo`) and flag/assignment (`-Dtest=…`,
 * `--test=…`) tokens are rejected; flags are handled by `matchesTestFlag`.
 *
 * @param tok - A single shell token (quotes preserved)
 * @returns true when the token denotes a test subcommand/variant
 */
function isBareTestToken(tok: string): boolean {
  if (!tok) return false;
  if (tok.includes("/")) return false; // path-like → not a subcommand
  if (tok.startsWith("-")) return false; // flag → handled by matchesTestFlag
  if (tok.includes("=")) return false; // key=value assignment
  return tok === "test" || /^test[:._-].+$/.test(tok);
}

/**
 * 178 Phase 1 (Q7-B): Index of the first non-flag argument (the subcommand
 * slot), skipping global flags such as `--verbose`. Returns -1 when every
 * token is a flag.
 *
 * @param tokens - Tokenized command segment
 * @returns Index of the first non-flag token, or -1
 */
function findSubcommandIndex(tokens: string[]): number {
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].startsWith("-")) return i;
  }
  return -1;
}

/**
 * 178 Phase 1 (Q2-B): Detects explicit test flags anywhere in a segment:
 * `--test`, `--test=<value>`, `--tests` (Gradle filter), and `-Dtest` /
 * `-Dtest=<value>` (Maven). `-DskipTests` is deliberately NOT matched — its
 * prefix is `-Ds`, not `-Dt`.
 *
 * @param tokens - Tokenized command segment
 * @returns true when a test flag is present
 */
function matchesTestFlag(tokens: string[]): boolean {
  return tokens.some((t) =>
    t === "--test" || t.startsWith("--test=") || t === "--tests" ||
    t === "-Dtest" || t.startsWith("-Dtest="),
  );
}

/**
 * Tests whether a bash command is a test command based on command structure.
 *
 * **Why this function exists (Goal 2):**
 * It is the gate for the 172-P3 consecutive-failure counter in the develop/fix
 * stages. Without it, any failing bash command (build, git, ls, …) would pollute
 * `loopCount` and trigger a premature circuit break, while a non-test success
 * would wrongly reset the counter and corrupt the audit semantics of the
 * fix→pass iteration.
 *
 * **Return value:**
 * Pure predicate — no side effects; the return value is the only output. Its
 * sole caller is the §1 gate `if` below, which consumes it as a predicate
 * (correcting the Goal-2 reading that the value was "never received").
 *
 * **Fail-open semantics (Q6-A):**
 * On a missed detection the whole §1 block is skipped — a failure does not
 * increment, a success does not reset, and the pipeline is not frozen; the flow
 * continues normally. Three safety nets absorb this: (1) §1b counts any bash
 * failure while `verifyFailures` is non-empty; (2) `agent_settled`
 * auto-verification freezes with `verify_attempt_overflow`; (3) `maxCycles`
 * caps the overall loop. Missed detections are additionally made observable via
 * the `test_detect_miss_candidate` audit signal (§2).
 *
 * Uses segment-level parsing (splitShellSegments) to avoid false positives
 * from paths, messages, or grep patterns containing "test".
 *
 * Detection rules per segment (after stripping `rtk ` prefix):
 * R1. First token is a known test runner (jest, vitest, pytest, phpunit, ctest, …) → test
 * R2. First token is a package manager (npm, pnpm, bun, bunx, …) AND the next
 *     token is a known test runner (`npx jest`, `bunx vitest`) → test
 * R3. A passthrough keyword (`run`/`exec`/`dlx`/`task`/`script`/`-m`) is
 *     followed by a known test runner (`bundle exec rspec`, `python -m pytest`) → test
 * R4. First token is in `NEVER_TEST_COMMANDS` → skip R5 for this segment
 * R5. An explicit test flag (`--test`, `-Dtest=…`) is present, OR a bare
 *     test-ish token appears at an argument slot (`mvn test`, `make test`,
 *     `npm run test:unit`, `php artisan test`) → test
 * R6. Otherwise → not a test command
 *
 * Note: `node --test` (Node.js built-in runner) is covered by R5's flag rule.
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

    // Quote-aware tokenization (shared bash-parse helper) so quoted arguments
    // such as `grep "test>bar"` keep a correct token boundary.
    const tokens = tokenize(stripped);
    const firstToken = tokens[0];

    // R1: direct test-runner invocation (`jest`, `pytest`, `phpunit`, …).
    if (TEST_RUNNER_EXECUTABLES.has(firstToken)) return true;

    // R2: package manager + test runner (`npx jest`, `bunx vitest`).
    if (PACKAGE_MANAGERS.has(firstToken) && TEST_RUNNER_EXECUTABLES.has(tokens[1])) {
      return true;
    }

    // R3: passthrough keyword + test runner (`bundle exec rspec`, `python -m pytest`).
    for (let i = 0; i + 1 < tokens.length; i++) {
      if (TEST_SUBCOMMAND_PASSTHROUGH.has(tokens[i]) && TEST_RUNNER_EXECUTABLES.has(tokens[i + 1])) {
        return true;
      }
    }

    // R4: deterministic non-test first token — guard the R5 relaxation so
    // `git show test`, `echo test`, `rm test`, `tail test.md` stay non-tests.
    if (NEVER_TEST_COMMANDS.has(firstToken)) continue;

    // R5: explicit test flag anywhere.
    if (matchesTestFlag(tokens)) return true;

    // R5: bare test-ish token at an argument slot. `findSubcommandIndex` anchors
    // the canonical subcommand slot (skipping global flags such as `--verbose`);
    // the scan intentionally continues past it because the Q8-A list requires
    // `php artisan test`, where `test` is the second non-flag argument.
    const scanStart = Math.max(1, findSubcommandIndex(tokens));
    for (let i = scanStart; i < tokens.length; i++) {
      if (isBareTestToken(tokens[i])) return true;
    }
  }
  return false;
}

/**
 * 178 Phase 2 (Q6-B): Weak, observation-only heuristic for a *possibly* missed
 * test command. Matches a standalone `test`/`tests` word (bounded by
 * non-letters) anywhere in the command — e.g. `./scripts/test.sh`, `make test`
 * variants — while ignoring commands that merely embed letters around it.
 *
 * This value NEVER participates in the gate: it only decides whether to write
 * the `test_detect_miss_candidate` audit signal so a miss becomes visible.
 *
 * @param command - The raw bash command string
 * @returns true when the command loosely contains a test word
 */
function looksLikeMissedTest(command: string): boolean {
  return /(^|[^a-z])tests?([^a-z]|$)/i.test(command);
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
      const rawMeta = ctx.session.getMeta() as SessionMeta | undefined;
      // Phase 2b (173) C3: dormant guard — zero counting
      if (!rawMeta || isDormant(rawMeta)) return;
      const meta: SessionMeta = rawMeta;
      const projectRoot = config.projectRoot;
      const auditDir = config.auditDir || ".pi/audit";
      // tool_result events always populate toolCall (buildRuntimeCtx guarantees it)
      const toolCall = ctx.toolCall!;

      // ── 0. Assistant message collection removed (Q4-A) ──────────
      // Phase 3 will use extractAssistantMessages(ctx) for real-time extraction.

      // ── 1. Test failure counting and circuit breaker ─────────────────
      // Phase 3 (172): consecutive-fail semantics — success resets the counter.
      // The command is resolved once so §1 and the §1a miss signal share the
      // same `isTestCommand` verdict without re-evaluating it.
      const bashCommand =
        toolCall.name === "bash" && typeof toolCall.arguments?.command === "string"
          ? (toolCall.arguments.command as string)
          : undefined;
      const isTestBash = bashCommand !== undefined && isTestCommand(bashCommand);

      if (isTestBash) {
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

              await freezeAndPrompt(ctx, meta, "loop_overflow", config, {
                onStageChanged: buildOnStageChangedCallback(ctx, config),
              });
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

      // ── 1a. Missed-test detection signal (observability only) ────────
      // A failed bash command that was NOT classified as a test but loosely
      // looks like one (e.g. `./scripts/test.sh`, `make check` variants) is
      // recorded for post-hoc analysis (Q6-B). This branch MUST NOT update
      // meta, count, or freeze — it is a pure audit signal. On a real miss the
      // flow is fail-open: §1 is skipped and the three safety nets (§1b,
      // agent_settled auto-verify, maxCycles) absorb the retries (Q6-A).
      if (
        bashCommand !== undefined &&
        !isTestBash &&
        ctx.result?.exitCode !== 0 &&
        (meta.currentStage === "develop" || meta.currentStage === "fix") &&
        looksLikeMissedTest(bashCommand)
      ) {
        await writeAuditLog("test_detect_miss_candidate", {
          pipelineId: meta.pipelineId,
          stage: meta.currentStage,
          command: encodeAuditValue(bashCommand),
        }, "info");
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

            await freezeAndPrompt(ctx, meta, "verify_failure_loop_overflow", config, {
              onStageChanged: buildOnStageChangedCallback(ctx, config),
            });
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
