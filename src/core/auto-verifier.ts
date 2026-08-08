/**
 * @module auto-verifier
 * Rule-based + model-based auto-verification engine.
 * Reads verify.md (YAML frontmatter rules + Markdown body prompt) and
 * checks whether the agent's stage output meets verification criteria.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig, PipelineStage, SessionMeta } from "../types";

/**
 * Parsed verification rules from a verify.md frontmatter.
 */
export interface VerifyRules {
  keywords: string[];
  /** "and" = all keywords must match, "or" = any keyword match passes */
  mode: "and" | "or";
}

/**
 * Result of parsing a verify.md file.
 */
export interface ParsedVerifyFile {
  /** Verification rules (null if no YAML frontmatter with keywords) */
  rules: VerifyRules | null;
  /** Model verification prompt (Markdown body or default) */
  prompt: string;
}

const DEFAULT_VERIFY_PROMPT = "- Fully understand the requirement context (goals, scope, boundaries)\n" +
    "- Clear and unambiguous solution selection that covers all requirement boundaries\n";

/**
 * Parses a verify.md file into rules and a verification prompt.
 * Expects YAML frontmatter (between --- delimiters) for keyword rules,
 * and Markdown body as the model verification prompt.
 */
export async function parseVerifyFile(
  verifyPath: string,
): Promise<ParsedVerifyFile> {
  let raw: string;
  try {
    raw = await fs.readFile(verifyPath, "utf-8");
  } catch {
    return { rules: null, prompt: DEFAULT_VERIFY_PROMPT };
  }

  const parts = raw.split(/^---\s*$/m);
  if (parts.length < 2) {
    return { rules: null, prompt: raw.trim() || DEFAULT_VERIFY_PROMPT };
  }

  // parts[0] is before first --- (should be empty/whitespace)
  // parts[1] is the YAML frontmatter content
  // parts.slice(2).join("---") is the Markdown body
  const frontmatter = parts[1].trim();
  const body = parts.slice(2).join("---").trim();

  const rules = parseFrontmatter(frontmatter);
  const prompt = body || DEFAULT_VERIFY_PROMPT;

  return { rules, prompt };
}

/**
 * Parses YAML-like frontmatter content into VerifyRules.
 * Uses a simple key-value parser — no full YAML library dependency.
 */
function parseFrontmatter(yaml: string): VerifyRules | null {
  try {
    const lines = yaml.split("\n");
    let inRules = false;
    let inKeywords = false;
    const keywords: string[] = [];
    let mode: "and" | "or" = "or";

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith("rules:")) {
        inRules = true;
        continue;
      }

      if (inRules && trimmed.startsWith("keywords:")) {
        inKeywords = true;
        continue;
      }

      if (inRules && trimmed.startsWith("mode:")) {
        const value = trimmed.split(":")[1]?.trim().replace(/["']/g, "");
        if (value === "and" || value === "or") {
          mode = value;
        }
        continue;
      }

      if (inKeywords && trimmed.startsWith("- ")) {
        const kw = trimmed.slice(2).trim().replace(/["']/g, "");
        if (kw) {
          keywords.push(kw);
        }
        continue;
      }

      // Exit keywords section on non-list-item line
      if (inKeywords && trimmed && !trimmed.startsWith("- ")) {
        inKeywords = false;
      }
    }

    if (keywords.length === 0) {
      return null;
    }

    return { keywords, mode };
  } catch {
    return null;
  }
}

/**
 * Runs rule-based verification against the aggregated assistant messages.
 * Q5 方案 C: aggregates ALL assistant messages from the current stage,
 * then checks against keyword rules (AND or OR mode).
 */
export function ruleVerify(
  rules: VerifyRules,
  assistantMessages: string[],
): { passed: boolean; missing: string[] } {
  const aggregated = assistantMessages.join("\n");

  if (rules.mode === "and") {
    const missing = rules.keywords.filter(
      (kw) => !aggregated.includes(kw),
    );
    return { passed: missing.length === 0, missing };
  }

  // mode "or" — any keyword match passes
  const found = rules.keywords.some((kw) => aggregated.includes(kw));
  if (found) {
    return { passed: true, missing: [] };
  }
  return { passed: false, missing: rules.keywords };
}

/**
 * Runs the full verification pipeline for a stage:
 * 1. Parse verify.md
 * 2. Run rule verification
 * 3. If rules fail or absent, suggest model verification
 */
export async function runVerification(
  config: PipelineConfig,
  meta: SessionMeta,
  assistantMessages: string[],
): Promise<{
  rulePassed: boolean;
  ruleMissing: string[];
  needsModelVerify: boolean;
  modelPrompt: string;
}> {
  const stageConfig = config.stages[meta.currentStage];
  const verifyConfig = stageConfig.verify;

  if (!verifyConfig || !verifyConfig.require) {
    return {
      rulePassed: true,
      ruleMissing: [],
      needsModelVerify: false,
      modelPrompt: "",
    };
  }

  const verifyPath = path.isAbsolute(verifyConfig.verifyFile || "")
    ? verifyConfig.verifyFile!
    : path.join(config.projectRoot, verifyConfig.verifyFile || "");

  const { rules, prompt } = await parseVerifyFile(verifyPath);

  if (!rules) {
    // No rules defined — skip directly to model verification
    return {
      rulePassed: false,
      ruleMissing: [],
      needsModelVerify: true,
      modelPrompt: prompt,
    };
  }

  const ruleResult = ruleVerify(rules, assistantMessages);

  if (ruleResult.passed) {
    return {
      rulePassed: true,
      ruleMissing: [],
      needsModelVerify: false,
      modelPrompt: "",
    };
  }

  return {
    rulePassed: false,
    ruleMissing: ruleResult.missing,
    needsModelVerify: true,
    modelPrompt: prompt,
  };
}
