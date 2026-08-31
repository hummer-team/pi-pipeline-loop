/**
 * @module constants
 * Shared constants used across pipeline modules.
 */

import type { PipelineStage } from "./types";

/**
 * Configuration directory name — consistent with pi SDK CONFIG_DIR_NAME.
 * Used by pipeline-init to create the .pi/ directory structure.
 */
export const CONFIG_DIR_NAME = ".pi";

/**
 * Stages eligible for pipeline resume on aborted restart.
 * Excludes "awaiting_human" (frozen, requires decision menu) and
 * "completed" (terminal, requires fresh start).
 */
export const RESUMABLE_STAGES: PipelineStage[] = [
  "clarify", "plan", "develop", "review", "fix",
];

/** Paths that agents in loop stages (develop/fix) must not modify.
 * Project rule files (e.g. AGENTS.md) are NOT protected by default;
 * users may add them via `config.protect.paths` if needed.
 */
export const PROTECTED_PATHS = [".pi/", ".git/"] as const;

/** Hard cap for stage-chain walking (prevents runaway loops on misconfigured chains) */
export const MAX_STAGE_CHAIN_LENGTH = 16;

/**
 * Sentinel value for allowedWritePaths meaning "all paths allowed".
 * When present in allowedWritePaths, stage write whitelist is fully open
 * and global protection chain applies unchanged.
 */
export const ALLOWED_WRITE_ALL = "**";

/**
 * Default TUI shortcut KeyId for opening the pipeline decision menu.
 * Changed from the legacy default (ctrl+d) to "ctrl+enter" to avoid conflict with pi agent
 * built-in bindings (app.exit, app.session.delete, app.tree.filter.default).
 */
export const DEFAULT_DECISION_SHORTCUT = "ctrl+enter";

/**
 * Default maximum number of violations before the violation overflow breaker fires.
 * When violations.length >= this value, freezeAndPrompt("violation_overflow") is triggered.
 */
export const DEFAULT_MAX_VIOLATIONS = 3;

/**
 * Default cap on confirm rejections per stage (post-verify confirm gate).
 * Stage-level `confirm.maxRejections` overrides this value.
 * When exceeded, behavior is controlled by `confirmOverflow` ("ask" | "terminate").
 */
export const DEFAULT_CONFIRM_MAX_REJECTIONS = 5;

/**
 * Default overflow behavior when confirm rejections exceed the cap.
 * - "ask": Prompt the user with Continue/Terminate TUI select.
 * - "terminate": Immediately abort the pipeline with flowState="aborted".
 */
export const DEFAULT_CONFIRM_OVERFLOW = "ask" as const;

// ─── Terminal Context Compaction Defaults (Phase 4 / 169) ────────────────────

/**
 * Whether terminal context compaction is enabled by default.
 * When true, ctx.compact is invoked once after the pipeline reaches completed.
 */
export const DEFAULT_COMPACT_ENABLED = true;

/**
 * Minimum token count to trigger compaction.
 * Below this threshold, compaction is skipped (audit-only, no token waste).
 * Matches the official trigger-compact.ts example value.
 */
export const DEFAULT_COMPACT_TOKEN_THRESHOLD = 100_000;

/**
 * Default custom instructions for terminal context compaction.
 * Anchors critical context pointers that must survive the lossy compression.
 */
export const DEFAULT_COMPACT_INSTRUCTIONS = `Pipeline completed. Preserve the following context pointers verbatim:

1. Terminal state: pipeline reached "completed" stage
2. stageVisitOrder: the full ordered list of stages visited (including re-visits)
3. Deliverable paths: all stage summary artifact paths (meta.summaries[].path) and completed.md
4. Requirement doc: the requirement document pointer (meta.requirementDoc) with all clarification conclusions
5. Commit pointers: any git commit ids referenced during the pipeline
6. Keep all the above pointers verbatim — do not summarize or paraphrase file paths, commit ids, or stage names`;

/**
 * Default write whitelist for read-only stages (clarify/plan/review).
 * These stages may only write to documentation directories.
 */
export const DEFAULT_READONLY_WRITE_PATHS = ["docs/", "doc/", "documentation/"];

/** Default path templates for stage resources (use {stage} placeholder) */
export const DEFAULT_SKILL_PATH = "{stage}/SKILL.md";
export const DEFAULT_VERIFY_FILE = ".pi/references/{stage}_spec/verify.md";

/** Default write scope by stage type (tools and bash prefixes no longer restricted) */
export const STAGE_TYPE_TOOL_DEFAULTS: Record<
  string,
  { allowedWritePaths: string[] }
> = {
  clarify: {
    allowedWritePaths: DEFAULT_READONLY_WRITE_PATHS,
  },
  plan: {
    allowedWritePaths: DEFAULT_READONLY_WRITE_PATHS,
  },
  develop: {
    allowedWritePaths: [ALLOWED_WRITE_ALL],
  },
  review: {
    allowedWritePaths: DEFAULT_READONLY_WRITE_PATHS,
  },
  fix: {
    allowedWritePaths: [ALLOWED_WRITE_ALL],
  },
};

/** Resolve a path template by replacing {stage} with the actual stage name */
export function resolveStagePath(template: string, stage: string): string {
  return template.replace(/\{stage\}/g, stage);
}

/** Default verification prompt used when no verify.md body is available */
export const DEFAULT_VERIFY_PROMPT = "- Fully understand the requirement context (goals, scope, boundaries)\n" +
    "- Clear and unambiguous solution selection that covers all requirement boundaries\n";

/**
 * System prompt for the LLM parse stage — instructs the LLM to extract
 * structured VerificationInstruction[] from Markdown verification descriptions.
 */
export const DEFAULT_VERIFY_PARSE_PROMPT = `You are a verification instruction parser. Given a Markdown description of what to verify, extract structured verification instructions as a JSON array.

Each instruction must have:
- "checkType": one of "fileExists", "fileContent", "command", "gitStatus"
- "target": the file path, command, or git check target
- "expected": (optional) expected content pattern or value

Respond ONLY with a JSON array. No explanation, no markdown.

Example output:
[
  {"checkType": "fileExists", "target": "docs/design/commit.md"},
  {"checkType": "fileContent", "target": "docs/design/commit.md", "expected": "^phase_name:"},
  {"checkType": "command", "target": "bun run build"},
  {"checkType": "gitStatus", "target": "cleanWorkingTree"}
]`;

/**
 * System prompt for the LLM judge stage — instructs the LLM to evaluate
 * verification execution results and render an overall pass/fail judgment.
 */
export const DEFAULT_VERIFY_JUDGE_PROMPT = `You are a verification result judge. Given the execution results of verification instructions, determine whether the overall verification has passed.

Consider:
- All file existence checks must pass
- All content pattern checks must match
- All commands must succeed with expected exit codes
- Git status checks must be satisfied

Respond with JSON: {"passed": true/false, "reasoning": "brief explanation"}
Respond ONLY with JSON. No explanation outside the JSON object.`;

/**
 * System prompt for the LLM extraction stage in pipeline-init 1 / verify-generator shared module —
 * instructs the LLM to extract delivery items from skill file content.
 *
 * The example uses a placeholder <build command from project> instead of a
 * tech-stack-specific command to avoid biasing the LLM toward any particular
 * ecosystem. The actual project tech stack context is injected by
 * verify-generator before the prompt is sent (see detectTechStack in tech-stack.ts).
 */
export const DEFAULT_VERIFY_EXTRACT_PROMPT = `You are a delivery item extractor. Given a skill file content, extract the deliverables that must be produced for the stage to be considered complete.

Look for items marked with **必须**, **Must**, **Required**, **MUST** or similar strong obligation markers.

For each deliverable, classify it as one of:
- "file": a file that must be created/modified
- "command": a command that must succeed — MUST be based on the project's actual tech stack (e.g. Maven/Gradle for Java, npm/bun for Node, cargo for Rust), not generic examples
- "git": a git state that must be true
- "keyword": a keyword that must appear in the output

Respond with JSON array:
[
  {"type": "file", "target": "docs/design/commit.md"},
  {"type": "command", "target": "<build command from project>"},
  {"type": "command", "target": "<test command from project>"},
  {"type": "keyword", "target": "答"}
]

Respond ONLY with the JSON array.`;

/**
 * Default system prompt for model-based conflict/overlap detection between
 * business SKILL content and plugin-injected prompt segments.
 * Used by runConflictCheck in pipeline-init when yml conflict_check_prompt
 * key is missing or empty.
 *
 * Phase 6 (146): mirrors the structure of DEFAULT_VERIFY_EXTRACT_PROMPT.
 */
export const DEFAULT_CONFLICT_CHECK_PROMPT = `You are a prompt conflict analyzer. Given the business skill content and the plugin-injected prompt segments for the same pipeline stage, detect CONFLICTS and OVERLAPS between them.

Definitions:
- "conflict": the two sources give contradictory instructions (e.g., one says "call stage_advance" and the other says "must NOT call stage_advance").
- "overlap": the two sources cover the same requirement redundantly with different wording (e.g., both describe the nextStage handoff protocol) — not contradictory but duplicated; recommend which source should own it.

For each issue, respond with a JSON object:
{
  "stage": "<stage>",
  "items": [
    {
      "kind": "conflict" | "overlap",
      "skillSnippet": "<verbatim quote from the skill content>",
      "pluginSnippet": "<verbatim quote from the plugin segment>",
      "reason": "<why this is a conflict or overlap>",
      "suggestion": "<recommended fix: which source to change and how>"
    }
  ]
}

Rules:
- Only report real issues; do not invent problems.
- Quote snippets verbatim.
- If no issues found, respond with {"stage": "<stage>", "items": []}.

Respond ONLY with the JSON object.`;
