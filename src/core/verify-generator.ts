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
import { detectTechStack } from "./tech-stack";
import { parseFrontmatter, type VerifyRules } from "./auto-verifier";

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
  reason?: "skill_not_found" | "no_items" | "exists" | "exists_custom" | "user_declined";
  /** Number of items extracted via hardcoded marker matching */
  hardcodedCount?: number;
  /** Number of items extracted via LLM */
  llmCount?: number;
  /** LLM extraction status: "ok" = success, "fail" = error/degraded, "off" = not enabled */
  llmStatus?: "ok" | "fail" | "off";
  /** For merged results: list of command/file targets that were added */
  addedItems?: string[];
};

// ─── Exported Functions ───────────────────────────────────────────────────────

/**
 * Resolves the extraction prompt for LLM-based delivery item extraction.
 * Delegates to the prompt-config module which reads from
 * `.pi/references/pipeline-stage-prompt.yml` (verify_extract key or verify_extract_{stage}).
 * Falls back to DEFAULT_VERIFY_EXTRACT_PROMPT when the yml value is empty or missing.
 *
 * Fallback chain when stage is provided:
 *   verify_extract_{stage} → global verify_extract → DEFAULT_VERIFY_EXTRACT_PROMPT
 *
 * @param projectRoot - Absolute path to the project root
 * @param stage - Optional pipeline stage name for per-stage lookup
 * @returns The extraction prompt string (custom from yml or default)
 */
export async function resolveExtractPrompt(projectRoot: string, stage?: string): Promise<string> {
  return getVerifyExtractPrompt(projectRoot, stage);
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
 * - **Independent marker** (explicit): `**必须**` / `**Must**` etc. — text after marker is extracted,
 *   all item types kept (including keyword). Author explicitly declared delivery intent.
 * - **Phrase-bold**: `**必须完成**` / `**Must run build**` etc. — bold phrase
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
 *
 * Classification priority: command > file > git > keyword.
 * Command patterns are checked first to avoid JVM/Node commands with path-like
 * tokens (e.g. `./mvnw clean test`, `./gradlew build`) being mis-classified as files.
 */
export function classifyDeliveryItem(description: string): DeliveryItem {
  const trimmed = description.replace(/["`]/g, "").trim();
  const lower = trimmed.toLowerCase();

  // Command patterns first — covers Node/Bun, JVM (Maven/Gradle), Rust, Python, and common shell tools.
  // Also matches executable script wrappers like `./mvnw`, `./gradlew`, `./<script>`.
  const COMMAND_PREFIX =
    /^(?:\.\/)?(?:bunx?|npm|npx|node|yarn|pnpm|git|cargo|make|python3?|mvn|mvnw|gradle|gradlew|java|echo|mkdir|cat|ls|sh|bash)(?:\s|$)|^\.\/(?:mvnw|gradlew|[a-zA-Z0-9_-]+)$/i;
  if (COMMAND_PREFIX.test(trimmed)) {
    return { type: "command", target: trimmed };
  }

  // File path patterns (contains extension or path separators)
  if (/\.\w{1,5}$/.test(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
    return { type: "file", target: trimmed };
  }

  // Git state patterns
  if (lower.includes("commit") || lower.includes("branch") || lower.includes("git")) {
    return { type: "git", target: trimmed };
  }

  // Default: keyword
  return { type: "keyword", target: trimmed };
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
 * Parses a verify.md content string and returns its structured rules.
 * Reuses `parseFrontmatter` from auto-verifier for consistent YAML parsing.
 *
 * @param content - The full verify.md content (including frontmatter delimiters)
 * @returns Parsed rules, or null if no parseable frontmatter
 */
export async function parseVerifyRulesFromContent(content: string): Promise<VerifyRules | null> {
  const parts = content.split(/^---\s*$/m);
  if (parts.length < 2) return null;
  const frontmatter = parts[1].trim();
  if (!frontmatter) return null;
  return parseFrontmatter(frontmatter);
}

/**
 * Repairs a malformed verify.md frontmatter where the closing `---` delimiter
 * is glued to the last YAML line (e.g. `  mode: and---` instead of `  mode: and\n---`).
 *
 * Detection criteria:
 * - Splitting by `/^---\s*$/m` yields fewer than 3 parts (no standalone closing delimiter), AND
 * - The content contains a top-level `rules:` key (i.e., looks like YAML frontmatter).
 *
 * The repair inserts a newline before the inline `---` so the closing delimiter
 * stands on its own line. **No rule text is modified.**
 *
 * @param content - The raw verify.md content
 * @returns `{ repaired: true, content }` if repaired, or `{ repaired: false, content }` if unchanged
 */
export function repairVerifyFrontmatter(content: string): { repaired: boolean; content: string } {
  const parts = content.split(/^---\s*$/m);
  // Well-formed: at least 3 parts — before first `---`, between `---`s, after closing `---`.
  if (parts.length >= 3) return { repaired: false, content };

  // Must look like YAML frontmatter (contains `rules:`) to be a candidate for repair.
  if (!/^rules:/m.test(content)) return { repaired: false, content };

  // Repair: find a line where `---` is appended to YAML content (not on its own line)
  // and move it to its own line. The pattern requires at least one non-space character
  // before `---` on the line, so a standalone `---` line won't match.
  const repaired = content.replace(/^([ \t]*\S[^\n]*?)---([ \t]*)$/m, "$1\n---$2");
  if (repaired === content) return { repaired: false, content };
  return { repaired: true, content: repaired };
}

/**
 * Normalizes a command string for comparison (lowercase, collapse whitespace, strip leading ./).
 */
function normalizeCmd(cmd: string): string {
  return cmd.toLowerCase().replace(/^\.\//, "").replace(/\s+/g, " ").trim();
}

/**
 * Computes the diff between expected delivery items and existing verify.md rules.
 *
 * - expectedItems → expected rules (file → requiredFiles, command → requiredCommands,
 *   git → requiredGit, keyword → keywords)
 * - For each expected command/file: if not present in existing rules → mark for addition
 * - If existing rules contain extras (e.g., fileContentPattern, custom expected params)
 *   not in the expected set → hasCustom=true (protect user-authored rules, skip merge)
 *
 * @param existing - Parsed rules from the existing verify.md (null treated as empty)
 * @param expectedItems - Newly extracted delivery items from skill/LLM
 * @returns merged items to add + hasCustom flag; or { merged: [], hasCustom: false } if nothing to add
 */
export function diffAndMergeRules(
  existing: VerifyRules | null,
  expectedItems: DeliveryItem[],
): { merged: DeliveryItem[]; hasCustom: boolean } {
  if (!existing) {
    // No existing rules — everything is "to add"
    return { merged: expectedItems, hasCustom: false };
  }

  const existingFiles = new Set((existing.requiredFiles ?? []).map(f => f.trim()));
  const existingCmds = new Set(
    (existing.requiredCommands ?? []).map(c => normalizeCmd(c.cmd)),
  );
  const existingKeywords = new Set((existing.keywords ?? []).map(k => k.trim()));
  const hasGit = !!existing.requiredGit && Object.keys(existing.requiredGit).length > 0;

  // Detect user-authored extras that the expected set cannot reproduce.
  // fileContentPattern, custom requiredCommand fields (expectOutput), etc.
  const hasCustom =
    (existing.fileContentPattern !== undefined && existing.fileContentPattern.length > 0) ||
    (existing.requiredCommands ?? []).some(c => c.expectOutput !== undefined) ||
    // keywords with mode="and" when expected set has no keyword rules
    (existing.mode === "and" && expectedItems.filter(i => i.type === "keyword").length === 0);

  if (hasCustom) {
    return { merged: [], hasCustom: true };
  }

  const toAdd: DeliveryItem[] = [];
  for (const item of expectedItems) {
    if (item.type === "file" && !existingFiles.has(item.target.trim())) {
      toAdd.push(item);
    } else if (item.type === "command" && !existingCmds.has(normalizeCmd(item.target))) {
      toAdd.push(item);
    } else if (item.type === "keyword" && !existingKeywords.has(item.target.trim())) {
      toAdd.push(item);
    } else if (item.type === "git" && !hasGit) {
      toAdd.push(item);
    }
    // else: already present in existing rules — no need to add
  }

  return { merged: toAdd, hasCustom: false };
}

/**
 * Builds a merged verify.md content from existing rules + additional delivery items.
 * The body is preserved from the existing content (or uses default if absent).
 */
function buildMergedVerifyContent(
  existingRules: VerifyRules,
  existingBody: string,
  additionalItems: DeliveryItem[],
  stage: string,
): string {
  // Build the merged item set: existing rules + additional items
  const mergedFiles = [
    ...(existingRules.requiredFiles ?? []),
    ...additionalItems.filter(i => i.type === "file").map(i => i.target),
  ];
  const mergedCommands = [
    ...(existingRules.requiredCommands ?? []),
    ...additionalItems.filter(i => i.type === "command").map(i => ({ cmd: i.target, expectExit: 0 })),
  ];
  const mergedKeywords = [
    ...(existingRules.keywords ?? []),
    ...additionalItems.filter(i => i.type === "keyword").map(i => i.target),
  ];
  const hasGit =
    (existingRules.requiredGit && Object.keys(existingRules.requiredGit).length > 0) ||
    additionalItems.some(i => i.type === "git");

  const allItems: DeliveryItem[] = [
    ...mergedFiles.map(f => ({ type: "file" as const, target: f })),
    ...mergedCommands.map(c => ({ type: "command" as const, target: c.cmd })),
    ...mergedKeywords.map(k => ({ type: "keyword" as const, target: k })),
    ...(hasGit ? [{ type: "git" as const, target: "git" }] : []),
  ];

  const yamlPart = generateVerifyMdContent(allItems, stage);
  // Extract the YAML body portion (strip the leading ---\n and trailing ---\n)
  const yamlInner = yamlPart.replace(/^---\n/, "").replace(/\n---\n[\s\S]*$/, "");
  const body = existingBody || `Verify the delivery items for ${stage} stage. Check that all required files exist, commands succeed, and delivery criteria are met.`;
  // Ensure the closing frontmatter delimiter `---` starts on its own line.
  // Without trimEnd()+prepending \n, yamlInner ending without \n (e.g. "mode: and")
  // would produce "mode: and---" which silently downgrades `and` → `or` on parse.
  return `---\n${yamlInner.trimEnd()}\n---\n${body}\n`;
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
    /**
     * Phase 3 (Bug 2): called before overwriting an existing verify.md via the
     * merge path. Returns "allow" to proceed or "block" to skip this stage.
     * When omitted, merge writes proceed without asking (backward compatible).
     */
    onMergeAsk?: (stage: string, filePath: string) => Promise<"allow" | "block">;
  },
): Promise<VerifyGenerateResult[]> {
  const { stage, callLLM, onLLMStageStart, onMergeAsk } = options ?? {};
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

    // ── Exists branch: rule-level diff-merge instead of blanket skip ──
    // When verify.md already exists, parse its rules and compare with the
    // expected items. Missing command/file rules are merged in; user-authored
    // custom rules (fileContentPattern, expectOutput, etc.) are protected.
    if (fsSync.existsSync(absVerifyPath)) {
      let existingContent: string;
      try {
        existingContent = await fs.readFile(absVerifyPath, "utf-8");
      } catch {
        existingContent = "";
      }

      // Phase 1 (Bug 3-C): auto-repair malformed frontmatter (e.g. `mode: and---`)
      // from prior generator bug. Repaired content is written back + audit-logged,
      // then parsed as normal. Rule text is never modified by the repair.
      const repairResult = repairVerifyFrontmatter(existingContent);
      if (repairResult.repaired) {
        existingContent = repairResult.content;
        try {
          await fs.writeFile(absVerifyPath, existingContent, "utf-8");
        } catch {
          // best-effort: if write fails, continue with in-memory repaired content
        }
        await safeWriteAuditLog("verify_md_repair", {
          stage: s,
          filePath: verifyPath,
          detail: "auto-repaired malformed frontmatter closing delimiter",
        });
      }

      const existingRules = await parseVerifyRulesFromContent(existingContent);

      // Extract body from existing content (between last --- and EOF)
      const bodyParts = existingContent.split(/^---\s*$/m);
      const existingBody = bodyParts.length >= 3 ? bodyParts.slice(2).join("---").trim() : "";

      // Build expected items via hardcoded + (optionally) LLM extraction
      // skillPath in config is relative to .pi/skills/ (consistent with prompt-injector)
      const resolvedSkillPath = path.join(CONFIG_DIR_NAME, "skills", stageConfig.skillPath || `${s}/SKILL.md`);
      const skillBody = await readSkillBody(resolvedSkillPath, config.projectRoot);

      let expectedItems: DeliveryItem[] = [];
      let hardcodedItems: DeliveryItem[] = [];
      let llmItems: DeliveryItem[] = [];
      let llmStatusLocal: "ok" | "fail" | "off" = "off";
      if (skillBody) {
        hardcodedItems = extractHardcodedItems(skillBody);

        if (llmEnabled) {
          onLLMStageStart?.(s);
          try {
            let extractPrompt = await resolveExtractPrompt(config.projectRoot, s);
            try {
              const ts = await detectTechStack(config.projectRoot);
              if (ts) {
                extractPrompt +=
                  `\n\nProject tech stack: ${ts.toolchain}\n` +
                  `Recommended build/test commands: ${ts.hints}\n` +
                  `Extract commands based on this project, not generic examples.`;
              }
            } catch { /* best-effort */ }
            llmItems = await extractLLMItems(skillBody, callLLM!, extractPrompt, (e) => {
              safeWriteAuditLog("verify_llm_extract_error", {
                stage: s,
                error: "invalid JSON from LLM: " + String(e),
              }, "warn");
            });
            llmStatusLocal = "ok";
          } catch {
            llmStatusLocal = "fail";
          }
        }
        expectedItems = mergeDeliveryItems(hardcodedItems, llmItems);
      }

      const { merged: toAdd, hasCustom } = diffAndMergeRules(existingRules, expectedItems);

      if (hasCustom) {
        await safeWriteAuditLog("verify_md_generate", {
          stage: s,
          status: "skipped",
          filePath: verifyPath,
          reason: "exists_custom",
          detail: "user-authored custom rules protected",
        });
        results.push({
          stage: s,
          status: "skipped",
          filePath: verifyPath,
          reason: "exists_custom",
          hardcodedCount: 0,
          llmCount: 0,
          llmStatus: "off",
        });
        continue;
      }

      if (toAdd.length === 0) {
        // Nothing to merge — existing rules already cover all expected items
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

      // Phase 3 (Bug 2): before overwriting an existing verify.md via the merge
      // path, consult onMergeAsk callback (if provided). A "block" decision skips
      // this stage with reason="user_declined" without touching the file.
      if (onMergeAsk) {
        try {
          const decision = await onMergeAsk(s, verifyPath);
          if (decision === "block") {
            await safeWriteAuditLog("verify_md_generate", {
              stage: s,
              status: "skipped",
              filePath: verifyPath,
              reason: "user_declined",
              detail: "user declined overwrite",
            });
            results.push({
              stage: s,
              status: "skipped",
              filePath: verifyPath,
              reason: "user_declined",
              error: "user declined overwrite",
              hardcodedCount: 0,
              llmCount: 0,
              llmStatus: "off",
            });
            continue;
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // Fail-safe: treat callback errors as "block" to prevent unwanted overwrite
          await safeWriteAuditLog("verify_md_generate_error", {
            stage: s,
            file: verifyPath,
            error: `onMergeAsk callback failed: ${errMsg}`,
          }, "error");
          results.push({
            stage: s,
            status: "skipped",
            filePath: verifyPath,
            reason: "user_declined",
            error: `onMergeAsk error: ${errMsg}`,
            hardcodedCount: 0,
            llmCount: 0,
            llmStatus: "off",
          });
          continue;
        }
      }

      // Merge: write new content combining existing rules + additional items
      try {
        const mergedContent = buildMergedVerifyContent(
          existingRules ?? { keywords: [], mode: "or" },
          existingBody,
          toAdd,
          s,
        );
        await fs.writeFile(absVerifyPath, mergedContent, "utf-8");
        const addedDescs = toAdd.map(i => i.target);
        await safeWriteAuditLog("verify_md_generate", {
          stage: s,
          status: "merged",
          filePath: verifyPath,
          addedCommands: addedDescs.filter((_, idx) => toAdd[idx].type === "command").join(","),
          addedFiles: addedDescs.filter((_, idx) => toAdd[idx].type === "file").join(","),
        });
        results.push({
          stage: s,
          status: "merged",
          filePath: verifyPath,
          hardcodedCount: hardcodedItems.length,
          llmCount: llmItems.length,
          llmStatus: llmStatusLocal,
          addedItems: addedDescs,
        });
        continue;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await safeWriteAuditLog("verify_md_generate_error", { stage: s, file: verifyPath, error: errMsg }, "error");
        results.push({
          stage: s,
          status: "error",
          filePath: verifyPath,
          error: errMsg,
          hardcodedCount: 0,
          llmCount: 0,
          llmStatus: "off",
        });
        continue;
      }
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
        let extractPrompt = await resolveExtractPrompt(config.projectRoot, s);
        // Inject project tech stack context so LLM emits project-appropriate commands
        // (e.g. "./mvnw clean test" for Maven projects instead of "bun run build")
        try {
          const ts = await detectTechStack(config.projectRoot);
          if (ts) {
            extractPrompt +=
              `\n\nProject tech stack: ${ts.toolchain}\n` +
              `Recommended build/test commands: ${ts.hints}\n` +
              `Extract commands based on this project, not generic examples.`;
          }
        } catch {
          // Tech stack detection is best-effort; ignore errors
        }
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

    // NOTE: previous defensive drop of command-type items for develop/fix has been
    // removed. Project tech stack detection (see detectTechStack in tech-stack.ts)
    // now ensures LLM extraction emits the correct build/test commands for the
    // project, so dropping commands was counter-productive (root cause ③ of #129).

    if (allItems.length === 0) {
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
    const verifyContent = generateVerifyMdContent(allItems, s);

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
