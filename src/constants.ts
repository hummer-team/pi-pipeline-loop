/**
 * @module constants
 * Shared constants used across pipeline modules.
 */

/** Paths that agents in loop stages (develop/fix) must not modify */
export const PROTECTED_PATHS = [".pi/", "AGENTS.md", ".git/"] as const;

/** Default path templates for stage resources (use {stage} placeholder) */
export const DEFAULT_AGENT_FILE = ".pi/agents/{stage}/{stage}.md";
export const DEFAULT_SKILL_PATH = ".pi/skills/{stage}/SKILL.md";
export const DEFAULT_VERIFY_FILE = ".pi/references/{stage}_spec/verify.md";

/** Default tool permissions by stage type */
export const STAGE_TYPE_TOOL_DEFAULTS: Record<
  string,
  { tools: string[]; bash: string[] }
> = {
  clarify: {
    tools: ["read", "bash"],
    bash: ["ls", "cat", "find", "git log"],
  },
  design: {
    tools: ["read", "bash"],
    bash: ["ls", "cat", "find", "git log"],
  },
  plan: {
    tools: ["read", "bash"],
    bash: ["ls", "cat", "find", "git log"],
  },
  develop: {
    tools: ["read", "bash", "write", "edit"],
    bash: ["npm test", "npm run", "git", "tsc", "bun test"],
  },
  review: {
    tools: ["read", "bash"],
    bash: ["ls", "cat", "find", "git log"],
  },
  fix: {
    tools: ["read", "bash", "write", "edit"],
    bash: ["npm test", "npm run", "git", "tsc", "bun test"],
  },
};

/** Resolve a path template by replacing {stage} with the actual stage name */
export function resolveStagePath(template: string, stage: string): string {
  return template.replace(/\{stage\}/g, stage);
}

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
 * System prompt for the LLM extraction stage in pipeline_init_verify —
 * instructs the LLM to extract delivery items from skill file content.
 */
export const DEFAULT_VERIFY_EXTRACT_PROMPT = `You are a delivery item extractor. Given a skill file content, extract the deliverables that must be produced for the stage to be considered complete.

Look for items marked with **必须**, **Must**, **Required**, **MUST** or similar strong obligation markers.

For each deliverable, classify it as one of:
- "file": a file that must be created/modified
- "command": a command that must succeed
- "git": a git state that must be true
- "keyword": a keyword that must appear in the output

Respond with JSON array:
[
  {"type": "file", "target": "docs/design/commit.md"},
  {"type": "command", "target": "bun run build"},
  {"type": "keyword", "target": "答"}
]

Respond ONLY with the JSON array.`;
