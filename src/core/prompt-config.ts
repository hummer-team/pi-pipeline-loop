/**
 * @module prompt-config
 * Shared module for loading, caching, and rendering prompt templates from YAML.
 * Provides yml-based prompt configuration for prompt-injector and verify-generator.
 *
 * Configuration file: `.pi/references/pipeline-stage-prompt.yml`
 * Key structure:
 *   - 5 stage prompts: clarify, plan, develop, review, fix
 *   - 5 per-stage verify prompts: verify_clarify, verify_plan, verify_develop, verify_review, verify_fix
 *   - 5 per-stage extract prompts: verify_extract_clarify, verify_extract_plan, verify_extract_develop, verify_extract_review, verify_extract_fix
 *   - 1 global extract fallback: verify_extract
 *
 * Verify prompt protocol:
 *   - verify_{stage}: Used as modelPrompt during stage verification (execution phase).
 *     Empty/missing → caller falls back to DEFAULT_VERIFY_PROMPT.
 *   - verify_extract_{stage}: Used for LLM-based delivery item extraction (generation phase).
 *     Fallback chain: verify_extract_{stage} → global verify_extract → DEFAULT_VERIFY_EXTRACT_PROMPT.
 *
 * Cache strategy: module-level singleton, keyed by projectRoot.
 * loadPromptConfig reads `.pi/references/pipeline-stage-prompt.yml` once per project root;
 * subsequent calls with the same root return the cached result.
 * resetPromptConfigCache() clears the cache (for test isolation).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parse as yamlParse } from "yaml";
import { CONFIG_DIR_NAME, DEFAULT_VERIFY_EXTRACT_PROMPT } from "../constants";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Parsed prompt configuration from pipeline-stage-prompt.yml.
 * Keys include stage names (clarify, plan, develop, review, fix),
 * per-stage verify prompts (verify_{stage}), per-stage extract prompts
 * (verify_extract_{stage}), and global verify_extract fallback.
 * Values are the prompt template strings for each key.
 */
export type PromptConfig = Record<string, string>;

/**
 * Result of rendering a stage template with dynamic values.
 * - "ok": Template rendered successfully with all critical placeholders resolved.
 * - "missing_critical": One or more critical placeholders missing from the template;
 *   caller should fall back to the default prompt and write an audit log.
 */
export type RenderResult =
  | { status: "ok"; prompt: string }
  | { status: "missing_critical"; missing: string[] };

// ─── Module-level cache ──────────────────────────────────────────────────────

let cache: PromptConfig | null = null;
let cacheRoot: string | null = null;

// ─── Prompt configuration file name ──────────────────────────────────────────

const PROMPT_CONFIG_FILE = "pipeline-stage-prompt.yml";

// ─── Known placeholder keys (without {{ }} wrapping) ─────────────────────────

const KNOWN_PLACEHOLDER_KEYS = [
  "context_reference",
  "domain_skill",
  "stage_skill",
  "loop_status",
  "pipeline_status",
  "verify_failures",
  "verify_tool_guidance",
  "stage_write_scope",
];

// ─── Exported Functions ───────────────────────────────────────────────────────

/**
 * Loads the prompt configuration from `.pi/references/pipeline-stage-prompt.yml`.
 * Results are cached at module level, keyed by projectRoot.
 *
 * Error handling:
 * - File not found → returns {} (empty config, callers use defaults)
 * - Read failure → returns {}
 * - YAML parse failure → returns {}
 * - Non-string values in parsed YAML are discarded
 *
 * @param projectRoot - Absolute path to the project root
 * @returns Parsed prompt configuration (never throws)
 */
export async function loadPromptConfig(projectRoot: string): Promise<PromptConfig> {
  if (cache !== null && cacheRoot === projectRoot) {
    return cache;
  }

  const ymlPath = path.join(
    projectRoot,
    CONFIG_DIR_NAME,
    "references",
    PROMPT_CONFIG_FILE,
  );

  try {
    const content = await fs.readFile(ymlPath, "utf-8");
    const parsed = yamlParse(content);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      cache = {};
      cacheRoot = projectRoot;
      return cache;
    }

    // Keep only string values — discard non-string entries
    const config: PromptConfig = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        config[key] = value;
      }
    }

    cache = config;
    cacheRoot = projectRoot;
    return cache;
  } catch {
    // File not found, read error, or parse error → empty config
    cache = {};
    cacheRoot = projectRoot;
    return cache;
  }
}

/**
 * Returns the stage prompt template from the yml config.
 * Returns null if the key is missing, undefined, or the value is empty/whitespace.
 *
 * @param projectRoot - Absolute path to the project root
 * @param stage - Pipeline stage name (e.g. "clarify", "develop")
 * @returns The template string, or null if unavailable
 */
export async function getStagePrompt(
  projectRoot: string,
  stage: string,
): Promise<string | null> {
  const config = await loadPromptConfig(projectRoot);
  const value = config[stage];
  if (value === undefined || value.trim() === "") {
    return null;
  }
  return value;
}

/**
 * Returns the per-stage verification execution prompt from the yml config.
 * Reads the key `verify_{stage}` (e.g. `verify_clarify`).
 * Returns null if the key is missing, undefined, or the value is empty/whitespace.
 * Caller should fall back to DEFAULT_VERIFY_PROMPT when null is returned.
 *
 * @param projectRoot - Absolute path to the project root
 * @param stage - Pipeline stage name (e.g. "clarify", "develop")
 * @returns The verify prompt string, or null if unavailable
 */
export async function getVerifyPrompt(
  projectRoot: string,
  stage: string,
): Promise<string | null> {
  const config = await loadPromptConfig(projectRoot);
  const key = `verify_${stage}`;
  const value = config[key];
  if (value === undefined || value.trim() === "") {
    return null;
  }
  return value;
}

/**
 * Returns the verify_extract prompt from the yml config with per-stage fallback chain.
 *
 * Fallback chain when stage is provided:
 *   verify_extract_{stage} → global verify_extract → DEFAULT_VERIFY_EXTRACT_PROMPT
 *
 * When stage is not provided (backward-compatible):
 *   global verify_extract → DEFAULT_VERIFY_EXTRACT_PROMPT
 *
 * @param projectRoot - Absolute path to the project root
 * @param stage - Optional pipeline stage name for per-stage lookup
 * @returns The extraction prompt string (custom or default)
 */
export async function getVerifyExtractPrompt(
  projectRoot: string,
  stage?: string,
): Promise<string> {
  const config = await loadPromptConfig(projectRoot);

  // Per-stage lookup when stage is provided
  if (stage) {
    const perStageKey = `verify_extract_${stage}`;
    const perStageValue = config[perStageKey];
    if (perStageValue !== undefined && perStageValue.trim() !== "") {
      return perStageValue;
    }
  }

  // Global fallback
  const globalValue = config["verify_extract"];
  if (globalValue === undefined || globalValue.trim() === "") {
    return DEFAULT_VERIFY_EXTRACT_PROMPT;
  }
  return globalValue;
}

/**
 * Clears the module-level prompt config cache.
 * FOR TESTING ONLY — call between test cases to prevent cache leakage.
 */
export function resetPromptConfigCache(): void {
  cache = null;
  cacheRoot = null;
}

/**
 * Returns the list of critical placeholder keys (with {{}} wrapping) for a stage.
 *
 * Adaptive rules (D7):
 * - All stages: `{{pipeline_status}}`
 * - Loop stages (develop/fix): + `{{loop_status}}`
 * - Other stages (clarify/plan/review): + `{{stage_write_scope}}`
 *
 * @param stage - Pipeline stage name
 * @returns Array of critical placeholder strings including {{}} delimiters
 */
export const CRITICAL_PLACEHOLDERS = (stage: string): string[] => {
  const critical = ["{{pipeline_status}}"];
  if (stage === "develop" || stage === "fix") {
    critical.push("{{loop_status}}");
  } else {
    critical.push("{{stage_write_scope}}");
  }
  return critical;
};

/**
 * Renders a stage template by replacing known placeholders with dynamic values
 * and removing paragraphs whose placeholders resolve to null/empty.
 *
 * Pure function — no I/O, no cache access.
 *
 * Behavior:
 * 1. Critical placeholder check: if any critical placeholder for the stage is
 *    absent from the template, returns missing_critical immediately.
 * 2. Paragraph-level removal: template is split on `---` separators. If a
 *    paragraph contains a placeholder whose value is null or "", the entire
 *    paragraph is discarded.
 * 3. Placeholder replacement: known placeholders (8 total) are replaced with
 *    their values. Unknown placeholders ({{xxx}}) are preserved as-is.
 * 4. Segments are joined with `\n\n---\n\n`, empty segments filtered, result trimmed.
 *
 * @param template - The raw template string from the yml
 * @param stage - Pipeline stage name (for critical placeholder detection)
 * @param values - Map of placeholder keys (without {{}}) to their dynamic values
 * @returns RenderResult: "ok" with rendered prompt, or "missing_critical" with missing list
 */
export function renderStageTemplate(
  template: string,
  stage: string,
  values: Record<string, string | null>,
): RenderResult {
  // Step 1: Check for missing critical placeholders in the raw template
  const criticalPlaceholders = CRITICAL_PLACEHOLDERS(stage);
  const missingCritical: string[] = [];
  for (const cp of criticalPlaceholders) {
    if (!template.includes(cp)) {
      missingCritical.push(cp);
    }
  }
  if (missingCritical.length > 0) {
    return { status: "missing_critical", missing: missingCritical };
  }

  // Step 2: Split template into paragraphs by `---` separator lines
  // Allow trailing whitespace on separator lines for robustness
  const segments = template.split(/^---\s*$/m);

  // Step 3: Separate segments into kept and removed (null/empty placeholder)
  const keptSegments: string[] = [];
  for (const segment of segments) {
    let skipSegment = false;

    for (const key of KNOWN_PLACEHOLDER_KEYS) {
      const placeholder = `{{${key}}}`;
      if (segment.includes(placeholder)) {
        const value = values[key];
        if (value === null || value === "") {
          skipSegment = true;
          break;
        }
      }
    }

    if (!skipSegment) {
      keptSegments.push(segment);
    }
  }

  // Step 3b: Re-check critical placeholders after paragraph removal
  // A critical placeholder may have been in a removed paragraph, silently lost
  const keptText = keptSegments.join("\n");
  const missingAfterRemoval: string[] = [];
  for (const cp of criticalPlaceholders) {
    if (!keptText.includes(cp)) {
      missingAfterRemoval.push(cp);
    }
  }
  if (missingAfterRemoval.length > 0) {
    return { status: "missing_critical", missing: missingAfterRemoval };
  }

  // Step 4: Replace known placeholders with their values in kept segments
  const renderedSegments: string[] = [];
  for (const segment of keptSegments) {
    let rendered = segment;
    for (const key of KNOWN_PLACEHOLDER_KEYS) {
      const placeholder = `{{${key}}}`;
      const value = values[key];
      if (value !== null && value !== undefined) {
        rendered = rendered.replaceAll(placeholder, value);
      }
    }

    const trimmed = rendered.trim();
    if (trimmed) {
      renderedSegments.push(trimmed);
    }
  }

  return {
    status: "ok",
    prompt: renderedSegments.join("\n\n---\n\n"),
  };
}
