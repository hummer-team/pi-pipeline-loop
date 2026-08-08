/**
 * @module pipeline-init-verify
 * /pipeline_init_verify [stage] — generates verify.md files from skill definitions.
 * Extracts delivery items marked with bold Must or Required keywords
 * and optionally uses LLM to extract additional structured verification items.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig, PipelineStage, Command } from "../types";
import { DEFAULT_VERIFY_FILE, resolveStagePath } from "../constants";
import { DEFAULT_VERIFY_EXTRACT_PROMPT } from "../constants";

/**
 * Resolves the extraction prompt for LLM-based delivery item extraction.
 * If `.pi/references/verify_prompt.md` exists in the project, its content is
 * used as the custom extraction prompt; otherwise the built-in default is returned.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns The extraction prompt string (custom or default)
 */
async function resolveExtractPrompt(projectRoot: string): Promise<string> {
  const customPromptPath = path.join(projectRoot, ".pi", "references", "verify_prompt.md");
  try {
    const content = await fs.readFile(customPromptPath, "utf-8");
    // If file exists but is empty, fall back to default
    if (content.trim().length === 0) {
      return DEFAULT_VERIFY_EXTRACT_PROMPT;
    }
    return content;
  } catch {
    return DEFAULT_VERIFY_EXTRACT_PROMPT;
  }
}

/**
 * A delivery item extracted from a skill file.
 */
interface DeliveryItem {
  /** Type of deliverable */
  type: "file" | "command" | "git" | "keyword";
  /** Target (file path, command string, keyword, etc.) */
  target: string;
}

/**
 * Resolves which stages need verify.md generation.
 *
 * @param stage - Optional stage filter (undefined = all stages)
 * @param config - Pipeline configuration
 * @returns List of stage names to process
 */
function resolveTargetStages(
  stage: string | undefined,
  config: PipelineConfig,
): PipelineStage[] {
  const allStages: PipelineStage[] = [
    "clarify", "design", "plan", "develop", "review", "fix",
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
async function readSkillBody(
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
 * @param skillBody - The skill file content (without frontmatter)
 * @returns Array of delivery items extracted via keyword matching
 */
function extractHardcodedItems(skillBody: string): DeliveryItem[] {
  const items: DeliveryItem[] = [];
  const MARKER_PATTERN = /\*\*(必须|Must|MUST|Required|REQUIRED)\*\*/gi;

  const lines = skillBody.split("\n");
  for (const line of lines) {
    if (MARKER_PATTERN.test(line)) {
      // Reset regex lastIndex
      MARKER_PATTERN.lastIndex = 0;

      // Extract the text after the marker, stripping list markers and extra whitespace
      const afterMarker = line
        .replace(MARKER_PATTERN, "")
        .replace(/^[\s]*[-*+][\s]*/, "")  // strip list markers (-, *, +)
        .trim();
      if (!afterMarker) continue;

      // Try to classify the item
      const item = classifyDeliveryItem(afterMarker);
      items.push(item);
    }
  }

  return items;
}

/**
 * Classifies a delivery item description into a type.
 */
function classifyDeliveryItem(description: string): DeliveryItem {
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
 * Uses LLM to extract structured delivery items from skill content.
 *
 * @param skillBody - The skill file content (without frontmatter)
 * @param callLLM - Function to call the LLM
 * @param extractPrompt - System prompt for the extraction
 * @returns Array of delivery items extracted by LLM
 */
async function extractLLMItems(
  skillBody: string,
  callLLM: (prompt: string) => Promise<string>,
  extractPrompt: string,
): Promise<DeliveryItem[]> {
  try {
    const response = await callLLM(`${extractPrompt}\n\n---\n\nSkill content:\n\n${skillBody}`);

    // Parse JSON from response
    let cleaned = response.trim();
    const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      cleaned = codeBlockMatch[1].trim();
    }

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
  } catch {
    return [];
  }
}

/**
 * Merges and deduplicates delivery items from hardcoded and LLM extraction.
 */
function mergeDeliveryItems(hardcoded: DeliveryItem[], llm: DeliveryItem[]): DeliveryItem[] {
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
 * @param items - Merged delivery items
 * @param stage - The pipeline stage name
 * @returns String content for the verify.md file
 */
function generateVerifyMdContent(items: DeliveryItem[], stage: string): string {
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
 * Creates the `/pipeline_init_verify` command.
 *
 * @param config - Pipeline configuration
 * @param callLLM - Optional LLM call function for enhanced extraction
 * @returns Command object
 */
export function createPipelineInitVerifyCommand(
  config: PipelineConfig,
  callLLM?: (prompt: string) => Promise<string>,
): Command {
  return {
    name: "pipeline_init_verify",
    description:
      "Generate verify.md files from skill definitions. " +
      "Extracts delivery items marked with **必须**/**Must**/**Required** keywords " +
      "and generates structured verification rules.",
    execute: async (args: Record<string, unknown>, _ctx?: any): Promise<unknown> => {
      const stageArg = args.stage as string | undefined;
      const stages = resolveTargetStages(stageArg, config);

      if (stages.length === 0) {
        return {
          success: false,
          error: stageArg
            ? `Unknown stage: "${stageArg}"`
            : "No stages configured for verification",
        };
      }

      const results: { stage: string; status: string; filePath?: string; error?: string }[] = [];

      for (const stage of stages) {
        const stageConfig = config.stages[stage];
        // skillPath in config is relative to .pi/skills/ (consistent with prompt-injector)
        const resolvedSkillPath = path.join(".pi", "skills", stageConfig.skillPath || `${stage}/SKILL.md`);

        const skillBody = await readSkillBody(resolvedSkillPath, config.projectRoot);
        if (!skillBody) {
          results.push({
            stage,
            status: "skipped",
            error: `Skill file not found: ${resolvedSkillPath}`,
          });
          continue;
        }

        // Step 1: Hardcoded extraction
        const hardcodedItems = extractHardcodedItems(skillBody);

        // Step 2: LLM extraction (if available)
        let llmItems: DeliveryItem[] = [];
        if (callLLM) {
          const extractPrompt = await resolveExtractPrompt(config.projectRoot);
          llmItems = await extractLLMItems(skillBody, callLLM, extractPrompt);
        }

        // Step 3: Merge and deduplicate
        const allItems = mergeDeliveryItems(hardcodedItems, llmItems);

        if (allItems.length === 0) {
          results.push({
            stage,
            status: "skipped",
            error: "No delivery items found in skill file",
          });
          continue;
        }

        // Step 4: Generate verify.md
        const verifyContent = generateVerifyMdContent(allItems, stage);
        const verifyPath = resolveStagePath(DEFAULT_VERIFY_FILE, stage);
        const absVerifyPath = path.join(config.projectRoot, verifyPath);

        try {
          await fs.mkdir(path.dirname(absVerifyPath), { recursive: true });
          await fs.writeFile(absVerifyPath, verifyContent, "utf-8");

          results.push({
            stage,
            status: "generated",
            filePath: verifyPath,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          results.push({
            stage,
            status: "error",
            error: errMsg,
          });
        }
      }

      const generated = results.filter(r => r.status === "generated");
      const skipped = results.filter(r => r.status === "skipped");
      const errored = results.filter(r => r.status === "error");

      return {
        success: true,
        summary: `Generated ${generated.length} verify.md file(s), skipped ${skipped.length}, errors ${errored.length}`,
        results,
      };
    },
  };
}
