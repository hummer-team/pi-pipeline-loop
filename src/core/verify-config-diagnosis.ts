/**
 * @module verify-config-diagnosis
 * Static configuration diagnosis for verify.md files.
 *
 * Extracted from auto-verifier.ts (Phase 5 / 161_Feat) to isolate
 * config validation from orchestration logic.
 *
 * Exports:
 * - Types: VerifyConfigErrorCode, VerifyConfigError, VerifyConfigDiagnosis
 * - diagnoseVerifyConfig: static analysis of verify.md configuration
 */

import fs from "node:fs/promises";
import {
  parseFrontmatter,
  stripYamlQuotes,
  KNOWN_FRONTMATTER_KEYS,
  type VerifyRules,
} from "./verify-frontmatter";

/**
 * Error codes for verify.md static configuration diagnosis (148 Phase 2).
 * Each code maps to a specific configuration issue that prevents rule execution.
 */
export type VerifyConfigErrorCode =
  | "file_missing"
  | "frontmatter_missing"
  | "yaml_parse_error"
  | "unknown_top_level_key"
  | "invalid_mode"
  | "empty_rule_item"
  | "no_rules";

/**
 * A single configuration error with code and human-readable detail.
 */
export interface VerifyConfigError {
  code: VerifyConfigErrorCode;
  detail: string;
}

/**
 * Result of static verify.md configuration diagnosis (148 Phase 2).
 * When ok is false, errors contains the list of configuration issues.
 */
export interface VerifyConfigDiagnosis {
  ok: boolean;
  errors: VerifyConfigError[];
}

/**
 * Static configuration diagnosis for a verify.md file (148 Phase 2).
 * Checks for common configuration errors that would prevent rule execution.
 * Returns a diagnosis with ok=false and error list when issues are found.
 *
 * Error codes:
 * - file_missing: verify.md does not exist or cannot be read
 * - frontmatter_missing: no YAML frontmatter (missing --- delimiters)
 * - yaml_parse_error: YAML content between --- could not be parsed
 * - unknown_top_level_key: unrecognized key at indent level 0
 * - invalid_mode: mode value is not "and" or "or"
 * - empty_rule_item: rule entry has empty path/pattern/keyword
 * - no_rules: no verification rules found after parsing
 *
 * @param verifyPath - Absolute path to the verify.md file
 * @returns Diagnosis with ok flag and error list
 */
export async function diagnoseVerifyConfig(
  verifyPath: string,
): Promise<VerifyConfigDiagnosis> {
  const errors: VerifyConfigError[] = [];
  const guideHint = "See guide.md for correct rule syntax.";

  // 1. Check file exists and is readable
  let raw: string;
  try {
    raw = await fs.readFile(verifyPath, "utf-8");
  } catch {
    return {
      ok: false,
      errors: [{ code: "file_missing", detail: `verify.md not found at "${verifyPath}". ${guideHint}` }],
    };
  }

  // 2. Check for --- frontmatter delimiters
  const parts = raw.split(/^---\s*$/m);
  if (parts.length < 2) {
    return {
      ok: false,
      errors: [{ code: "frontmatter_missing", detail: `No YAML frontmatter found (missing --- delimiters). ${guideHint}` }],
    };
  }

  const frontmatter = parts[1].trim();

  // 3. Parse with parseFrontmatter
  const rules = await parseFrontmatter(frontmatter);

  // 4. Raw frontmatter checks (run before null check so empty items are caught)
  const fmLines = frontmatter.split("\n");

  // 4a. Check for unknown top-level keys (at indent 0)
  for (const line of fmLines) {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0 && /^[\w]+:/.test(trimmed)) {
      const key = trimmed.split(":")[0];
      if (!KNOWN_FRONTMATTER_KEYS.has(key)) {
        errors.push({
          code: "unknown_top_level_key",
          detail: `Unknown top-level key "${key}". Valid keys: ${[...KNOWN_FRONTMATTER_KEYS].join(", ")}. ${guideHint}`,
        });
      }
    }
  }

  // 4b. Check for invalid mode value
  for (const line of fmLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("mode:")) {
      const rawValue = trimmed.slice(5).trim();
      const value = stripYamlQuotes(rawValue);
      if (value && value !== "and" && value !== "or") {
        errors.push({
          code: "invalid_mode",
          detail: `Invalid mode value "${value}". Only "and" and "or" are supported. ${guideHint}`,
        });
      }
    }
  }

  // 4c. Check for empty rule items in raw frontmatter
  for (const line of fmLines) {
    const trimmed = line.trim();
    // Empty path or pattern in fileContentPattern: both continuation form (`pattern: ""`)
    // and inline list form (`- path: ""`) (M3 fix)
    if (/^(-\s+)?(path|pattern)\s*:\s*(""|''|\s*)$/.test(trimmed)) {
      const fieldName = trimmed.replace(/^-\s+/, "").split(":")[0];
      errors.push({
        code: "empty_rule_item",
        detail: `Empty value for "${fieldName}" in fileContentPattern rule. ${guideHint}`,
      });
    }
    // Empty keyword in keywords list: `- ""` or `- ''` (M3 fix)
    if (/^-\s+(""|'')\s*$/.test(trimmed)) {
      errors.push({
        code: "empty_rule_item",
        detail: `Empty keyword in keywords list. ${guideHint}`,
      });
    }
  }

  // 5. If parseFrontmatter returned null, determine cause
  if (!rules) {
    // Check if frontmatter has any content that looks like rules
    const hasRuleStructure =
      /^rules\s*:/m.test(frontmatter) ||
      /^(keywords|mode|requiredFiles|requiredCommands|requiredGit|fileContentPattern)\s*:/m.test(frontmatter);

    if (!frontmatter || !hasRuleStructure) {
      // Empty or no rule-like content → YAML parse error or empty frontmatter
      errors.push({
        code: "yaml_parse_error",
        detail: `YAML frontmatter could not be parsed or is empty. Check syntax. ${guideHint}`,
      });
    } else {
      // Has rule-like structure but parseFrontmatter returned null → no valid rules
      // (may be due to all items being empty — already reported as empty_rule_item above)
      if (!errors.some(e => e.code === "empty_rule_item")) {
        errors.push({
          code: "no_rules",
          detail: `No valid verification rules found after parsing. All rules may be empty or malformed. ${guideHint}`,
        });
      }
    }
    return { ok: false, errors };
  }

  return { ok: errors.length === 0, errors };
}
