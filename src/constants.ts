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
