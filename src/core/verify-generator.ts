/**
 * @module verify-generator
 * Shared module for generating verify.md files from skill definitions.
 * Extracted from pipeline-init-verify.ts to be reusable by pipeline-init command.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { PipelineConfig, PipelineStage } from "../types";
import { DEFAULT_VERIFY_FILE, resolveStagePath, CONFIG_DIR_NAME } from "../constants";
import { safeWriteAuditLog } from "../utils/auditLog";
import { getVerifyExtractPrompt } from "./prompt-config";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A delivery item extracted from a skill file.
 */
export interface DeliveryItem {
  /** Type of deliverable */
  type: "file" | "command" | "git" | "keyword";
  /** Target (file path, command string, keyword, etc.) */
  target: string;
}

/**
 * Result of verify file generation for a single stage.
 */
export type VerifyGenerateResult = {
  stage: string;
  status: string;
  filePath?: string;
  error?: string;
  /** Discriminated skip reason — present only when status === "skipped" */
  reason?: "skill_not_found" | "no_items" | "exists";
  /** Number of items extracted via hardcoded marker matching */
  hardcodedCount?: number;
  /** Number of items extracted via LLM */
  llmCount?: number;
  /** LLM extraction status: "ok" = success, "fail" = error/degraded, "off" = not enabled */
  llmStatus?: "ok" | "fail" | "off";
};

// ─── Exported Functions ───────────────────────────────────────────────────────

/**
 * Resolves the extraction prompt for LLM-based delivery item extraction.
 * Delegates to the prompt-config module which reads from
 * `.pi/references/prompt-injector.yml` (verify_extract key).
 * Falls back to DEFAULT_VERIFY_EXTRACT_PROMPT when the yml value is empty or missing.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns The extraction prompt string (custom from yml or default)
 */
export async function resolveExtractPrompt(projectRoot: string): Promise<string> {
  return getVerifyExtractPrompt(projectRoot);
}

/**
 * Resolves which stages need verify.md generation.
 *
 * @param stage - Optional stage filter (undefined = all stages)
 * @param config - Pipeline configuration
 * @returns List of stage names to process
 */
export function resolveTargetStages(
  stage: string | undefined,
  config: PipelineConfig,
): PipelineStage[] {
  const allStages: PipelineStage[] = [
    "clarify", "plan", "develop", "review", "fix",
  ];

  if (stage) {
    if (allStages.includes(stage as PipelineStage)) {
      return [stage as PipelineStage];
    }
    return [];
  }

  // Filter to stages that exist in config and are not terminal
  return allStages.filter(s => config.stages[s]);
}

/**
 * Reads a skill file and strips the YAML frontmatter header.
 *
 * @param skillPath - Path to the skill file (relative to projectRoot)
 * @param projectRoot - Absolute project root path
 * @returns The skill file body content (without frontmatter), or null if file doesn't exist
 */
export async function readSkillBody(
  skillPath: string,
  projectRoot: string,
): Promise<string | null> {
  const absPath = path.isAbsolute(skillPath)
    ? skillPath
    : path.join(projectRoot, skillPath);

  try {
    const content = await fs.readFile(absPath, "utf-8");
    // Strip YAML frontmatter header (--- ... ---)
    return content.replace(/^---[\s\S]*?---\s*/m, "").trim();
  } catch {
    return null;
  }
}

/**
 * Hardcoded extraction: finds lines marked with bold Must, Required, or MUST keywords
 * and extracts the delivery item description following the marker.
 *
 * Two match types (Phase 1 — Plan D):
 * - **独立标记** (explicit): `**必须**` / `**Must**` etc. — text after marker is extracted,
 *   all item types kept (including keyword). Author explicitly declared delivery intent.
 * - **短语粗体** (phrase-bold): `**必须完成**` / `**Must run build**` etc. — bold phrase
 *   itself is extracted, only file/command/git types kept; keyword items discarded to
 *   prevent procedural sentences from being mis-matched.
 *
 * If both patterns match on the same line, the independent marker takes priority.
 *
 * @param skillBody - The skill file content (without frontmatter)
 * @returns Array of delivery items extracted via keyword matching
 */
export function extractHardcodedItems(skillBody: string): DeliveryItem[] {
  const items: DeliveryItem[] = [];

  // Pattern A: Independent marker — standalone bold keyword
  const INDEPENDENT_MARKER = /\*\*(必须|Must|MUST|Required|REQUIRED)\*\*/gi;
  // Pattern B: Phrase-bold — bold phrase containing keyword
  const PHRASE_BOLD = /\*\*[^*]*(?:必须|Must|MUST|Required|REQUIRED)[^*]*\*\*/gi;

  const lines = skillBody.split("\n");
  for (const line of lines) {
    // Reset lastIndex (global regexes are stateful)
    INDEPENDENT_MARKER.lastIndex = 0;
    PHRASE_BOLD.lastIndex = 0;

    if (INDEPENDENT_MARKER.test(line)) {
      // ── Type A: Independent marker ──
      // Extract text after the marker, stripping list markers and extra whitespace
      INDEPENDENT_MARKER.lastIndex = 0;
      const afterMarker = line
        .replace(INDEPENDENT_MARKER, "")
        .replace(/^[\s]*[-*+][\s]*/, "")  // strip list markers (-, *, +)
        .trim();
      if (!afterMarker) continue;

      // Classify and keep ALL types (including keyword) — explicit declaration
      items.push(classifyDeliveryItem(afterMarker));
    } else if (PHRASE_BOLD.test(line)) {
      // ── Type B: Phrase-bold ──
      // Extract bold phrase content + text after it.
      // Classification uses the after-bold text (actual deliverable) when present,
      // falling back to the phrase content alone.
      // E.g. "- **必须创建** docs/design/commit.md" → classify "docs/design/commit.md" → file
      PHRASE_BOLD.lastIndex = 0;
      const match = line.match(PHRASE_BOLD);
      if (!match) continue;

      const phraseContent = match[0].replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
      if (!phraseContent) continue;

      // Get text after the bold phrase (colon, space, etc. stripped)
      const afterBold = line.slice(line.indexOf(match[0]) + match[0].length)
        .replace(/^[\s:：]*/, "").trim();

      // Classification target: after-bold text (the actual deliverable) or phrase itself
      const classifyTarget = afterBold || phraseContent;

      // Classify and keep only file/command/git — discard keyword
      const item = classifyDeliveryItem(classifyTarget);
      if (item.type !== "keyword") {
        items.push({ type: item.type, target: classifyTarget });
      }
    }
  }

  return items;
}

/**
 * Classifies a delivery item description into a type.
 */
export function classifyDeliveryItem(description: string): DeliveryItem {
  const lower = description.toLowerCase();

  // File path patterns (contains extension or path separators)
  if (/\.\w{1,5}$/.test(description) || description.includes("/") || description.includes("\\")) {
    return { type: "file", target: description.replace(/["`]/g, "").trim() };
  }

  // Command patterns (starts with common command prefixes)
  if (/^(bun |npm |node |git |cargo |make |python |echo |mkdir |cat |ls )/i.test(description)) {
    return { type: "command", target: description.replace(/["`]/g, "").trim() };
  }

  // Git state patterns
  if (lower.includes("commit") || lower.includes("branch") || lower.includes("git")) {
    return { type: "git", target: description };
  }

  // Default: keyword
  return { type: "keyword", target: description };
}

/**
 * LLM-based extraction: sends skill content to the LLM and parses structured delivery items.
 *
 * Uses LLM to extract structured delivery items from skill content.
 * Throws if callLLM itself fails (caller handles audit/degradation).
 * Returns [] only for JSON parse failures or empty/invalid responses.
 *
 * @param skillBody - The skill file content (without frontmatter)
 * @param callLLM - Function to call the LLM
 * @param extractPrompt - System prompt for the extraction
 * @param onParseError - Optional callback invoked when JSON.parse fails, for audit/logging
 * @returns Array of delivery items extracted by LLM
 */
export async function extractLLMItems(
  skillBody: string,
  callLLM: (prompt: string) => Promise<string>,
  extractPrompt: string,
  onParseError?: (err: unknown) => void,
): Promise<DeliveryItem[]> {
  // callLLM errors propagate to caller for audit/degradation handling
  const response = await callLLM(`${extractPrompt}\n\n---\n\nSkill content:\n\n${skillBody}`);

  // Parse JSON from response — catch parse errors only
  let cleaned = response.trim();
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item: Record<string, unknown>) =>
        typeof item.type === "string" &&
        typeof item.target === "string" &&
        ["file", "command", "git", "keyword"].includes(item.type as string),
      )
      .map((item: Record<string, unknown>) => ({
        type: item.type as DeliveryItem["type"],
        target: item.target as string,
      }));
  } catch (err) {
    onParseError?.(err);
    return [];
  }
}

/**
 * Merges and deduplicates delivery items from multiple sources.
 */
export function mergeDeliveryItems(hardcoded: DeliveryItem[], llm: DeliveryItem[]): DeliveryItem[] {
  const seen = new Set<string>();
  const merged: DeliveryItem[] = [];

  for (const item of [...hardcoded, ...llm]) {
    const key = `${item.type}:${item.target}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }

  return merged;
}

/**
 * Generates verify.md content from delivery items.
 *
 * **Generation path**: verify.md is NOT LLM-generated. It uses a deterministic
 * template: YAML frontmatter rules are built from the structured `items` array
 * (file → requiredFiles, command → requiredCommands, git → requiredGit,
 * keyword → keywords), and the body is a fixed template string.
 *
 * The `items` array comes from two extraction sources merged via `mergeDeliveryItems`:
 * 1. **Hardcoded** — regex extraction of `**Must**`/`**必须**` markers from skill files
 * 2. **LLM** — when `llmExtract=true`, the LLM extracts additional items from skill
 *    content via `extractLLMItems` (JSON array of `{type, target}` objects)
 *
 * @param items - Merged delivery items (hardcoded + LLM)
 * @param stage - The pipeline stage name
 * @returns String content for the verify.md file (YAML frontmatter + fixed body)
 */
export function generateVerifyMdContent(items: DeliveryItem[], stage: string): string {
  const requiredFiles = items.filter(i => i.type === "file").map(i => i.target);
  const requiredCommands = items.filter(i => i.type === "command").map(i => i.target);
  const requiredKeywords = items.filter(i => i.type === "keyword").map(i => i.target);
  const gitItems = items.filter(i => i.type === "git");

  let yaml = "rules:\n";

  if (requiredFiles.length > 0) {
    yaml += "  requiredFiles:\n";
    for (const f of requiredFiles) {
      yaml += `    - "${f}"\n`;
    }
  }

  if (requiredCommands.length > 0) {
    yaml += "  requiredCommands:\n";
    for (const c of requiredCommands) {
      yaml += `    - cmd: "${c}"\n`;
      yaml += `      expectExit: 0\n`;
    }
  }

  if (gitItems.length > 0) {
    yaml += "  requiredGit:\n";
    yaml += `    lastCommitWithin: "10min"\n`;
  }

  if (requiredKeywords.length > 0) {
    yaml += "  keywords:\n";
    for (const kw of requiredKeywords) {
      yaml += `    - "${kw}"\n`;
    }
    yaml += `  mode: and\n`;
  }

  const body = `Verify the delivery items for ${stage} stage. Check that all required files exist, commands succeed, and delivery criteria are met.`;

  return `---\n${yaml}---\n${body}\n`;
}

/**
 * Top-level function that encapsulates the full verify generation flow.
 * Iterates over target stages, reads skill files, extracts delivery items,
 * and generates verify.md files.
 *
 * @param config - Pipeline configuration
 * @param options - Optional configuration
 * @param options.stage - Filter to a specific stage
 * @param options.callLLM - Optional LLM function for enhanced extraction (only used when config.llmExtract is true)
 * @returns Array of results per stage
 */
export async function generateVerifyFiles(
  config: PipelineConfig,
  options?: {
    stage?: string;
    callLLM?: (prompt: string) => Promise<string>;
    /** Called before each stage's LLM extraction starts (for TUI working indicator) */
    onLLMStageStart?: (stage: string) => void;
  },
): Promise<VerifyGenerateResult[]> {
  const { stage, callLLM, onLLMStageStart } = options ?? {};
  const stages = resolveTargetStages(stage, config);
  const results: VerifyGenerateResult[] = [];

  if (stages.length === 0) {
    return results;
  }

  const llmEnabled = config.llmExtract === true && typeof callLLM === "function";

  for (const s of stages) {
    const stageConfig = config.stages[s];
    const verifyPath = resolveStagePath(DEFAULT_VERIFY_FILE, s);
    const absVerifyPath = path.join(config.projectRoot, verifyPath);

    // Skip if verify.md already exists (template is authoritative)
    if (fsSync.existsSync(absVerifyPath)) {
      await safeWriteAuditLog("verify_md_generate", {
        stage: s,
        status: "skipped",
        filePath: verifyPath,
        reason: "exists",
      });
      results.push({
        stage: s,
        status: "skipped",
        filePath: verifyPath,
        reason: "exists",
        hardcodedCount: 0,
        llmCount: 0,
        llmStatus: "off",
      });
      continue;
    }

    // skillPath in config is relative to .pi/skills/ (consistent with prompt-injector)
    const resolvedSkillPath = path.join(CONFIG_DIR_NAME, "skills", stageConfig.skillPath || `${s}/SKILL.md`);

    const skillBody = await readSkillBody(resolvedSkillPath, config.projectRoot);
    if (!skillBody) {
      await safeWriteAuditLog("verify_md_generate", {
        stage: s,
        status: "skipped",
        skillPath: resolvedSkillPath,
        hardcodedCount: "0",
        llmCount: "0",
        llmStatus: "off",
        reason: "skill_not_found",
      });
      results.push({
        stage: s,
        status: "skipped",
        error: `Skill file not found: ${resolvedSkillPath}`,
        reason: "skill_not_found",
        hardcodedCount: 0,
        llmCount: 0,
        llmStatus: "off",
      });
      continue;
    }

    // Step 1: Hardcoded extraction
    const hardcodedItems = extractHardcodedItems(skillBody);

    // Step 2: LLM extraction (if enabled)
    let llmItems: DeliveryItem[] = [];
    let llmStatus: "ok" | "fail" | "off" = "off";
    let llmMs = 0;

    if (llmEnabled) {
      onLLMStageStart?.(s);
      const llmStart = Date.now();
      try {
        const extractPrompt = await resolveExtractPrompt(config.projectRoot);
        llmItems = await extractLLMItems(skillBody, callLLM!, extractPrompt, (e) => {
          safeWriteAuditLog("verify_llm_extract_error", {
            stage: s,
            error: "invalid JSON from LLM: " + String(e),
          }, "warn");
        });
        llmStatus = "ok";
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        llmMs = Date.now() - llmStart;
        llmStatus = "fail";
        await safeWriteAuditLog("verify_llm_extract_error", {
          stage: s,
          error: errMsg,
          llmMs: String(llmMs),
        }, "error");
        llmItems = [];
      }
      if (llmStatus === "ok") {
        llmMs = Date.now() - llmStart;
      }
    }

    // Step 3: Merge and deduplicate
    const allItems = mergeDeliveryItems(hardcodedItems, llmItems);

    // Drop command-type items for develop/fix (project tech stack is irrelevant)
    const filteredItems = (s === "develop" || s === "fix")
      ? allItems.filter(i => i.type !== "command")
      : allItems;

    if (filteredItems.length === 0) {
      await safeWriteAuditLog("verify_md_generate", {
        stage: s,
        status: "skipped",
        skillPath: resolvedSkillPath,
        hardcodedCount: String(hardcodedItems.length),
        llmCount: String(llmItems.length),
        llmStatus,
        llmMs: String(llmMs),
        reason: "no_items",
      });
      results.push({
        stage: s,
        status: "skipped",
        error: "No delivery items found in skill file",
        reason: "no_items",
        hardcodedCount: hardcodedItems.length,
        llmCount: llmItems.length,
        llmStatus,
      });
      continue;
    }

    // Step 4: Generate verify.md
    const verifyContent = generateVerifyMdContent(filteredItems, s);

    try {
      await fs.mkdir(path.dirname(absVerifyPath), { recursive: true });
      await fs.writeFile(absVerifyPath, verifyContent, "utf-8");

      await safeWriteAuditLog("verify_md_generate", {
        stage: s,
        status: "generated",
        skillPath: resolvedSkillPath,
        hardcodedCount: String(hardcodedItems.length),
        llmCount: String(llmItems.length),
        llmStatus,
        llmMs: String(llmMs),
      });

      results.push({
        stage: s,
        status: "generated",
        filePath: verifyPath,
        hardcodedCount: hardcodedItems.length,
        llmCount: llmItems.length,
        llmStatus,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await safeWriteAuditLog("verify_md_generate_error", { stage: s, file: verifyPath, error: errMsg }, "error");
      results.push({
        stage: s,
        status: "error",
        error: errMsg,
        hardcodedCount: hardcodedItems.length,
        llmCount: llmItems.length,
        llmStatus,
      });
    }
  }

  return results;
}
