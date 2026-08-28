/**
 * @module verify-frontmatter
 * YAML frontmatter parsing for verify.md files.
 *
 * Extracted from auto-verifier.ts (Phase 5 / 161_Feat) to isolate
 * pure-function frontmatter parsing from orchestration logic.
 *
 * Exports:
 * - Types: VerifyRules, RequiredCommand, RequiredGitRules, FileContentRule
 * - KNOWN_FRONTMATTER_KEYS set (used by config diagnosis)
 * - parseFrontmatter: YAML-like parser for verify.md frontmatter
 * - stripYamlQuotes / unescapeYamlString: YAML scalar helpers
 */

import fs from "node:fs/promises";
import { safeWriteAuditLog } from "../utils/auditLog";

/**
 * Parsed verification rules from a verify.md frontmatter.
 * Supports both legacy keyword rules and new structured rule types.
 */
export interface VerifyRules {
  keywords: string[];
  /** "and" = all keywords must match, "or" = any keyword match passes */
  mode: "and" | "or";
  /** File paths that must exist (relative to projectRoot) */
  requiredFiles?: string[];
  /** Shell commands with expected exit codes and output patterns */
  requiredCommands?: RequiredCommand[];
  /** Git repository state checks */
  requiredGit?: RequiredGitRules;
  /** File content regex pattern checks */
  fileContentPattern?: FileContentRule[];
}

/**
 * A shell command verification rule.
 */
export interface RequiredCommand {
  /** The command to execute */
  cmd: string;
  /** Expected exit code (default: 0) */
  expectExit?: number;
  /** Expected substring in stdout */
  expectOutput?: string;
}

/**
 * Git repository state verification rules.
 */
export interface RequiredGitRules {
  /** Time window for last commit (e.g., "10min", "1h") */
  lastCommitWithin?: string;
  /** Expected current branch name */
  branch?: string;
  /** Whether the working tree must be clean */
  cleanWorkingTree?: boolean;
}

/**
 * A file content regex pattern verification rule.
 */
export interface FileContentRule {
  /** File path to check (relative to projectRoot) */
  path: string;
  /** Regex pattern to match against file content */
  pattern: string;
}

/** Known top-level keys in verify.md frontmatter (148 Phase 2 diagnosis) */
export const KNOWN_FRONTMATTER_KEYS = new Set([
  "rules",
  "keywords",
  "mode",
  "requiredFiles",
  "requiredCommands",
  "requiredGit",
  "fileContentPattern",
]);

/**
 * Strips surrounding YAML quotes and unescapes double-quoted content.
 * - Double-quoted: unescapes YAML escape sequences (\\, \", \n, \t, \r, \/, \b, \f, \uXXXX)
 * - Single-quoted: unescapes YAML single-quote doubling ('' → ')
 * - Unquoted: returned as-is
 */
export function stripYamlQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapeYamlString(trimmed.slice(1, -1));
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * Unescapes a YAML double-quoted string scalar (content between the outer quotes).
 * Handles: \\\\ → \\, \\" → ", \\n → newline, \\t → tab, \\r → CR,
 * \\/ → /, \\b → backspace, \\f → form-feed, \\uXXXX → unicode char.
 * Unknown escape sequences preserve both characters per YAML spec.
 */
export function unescapeYamlString(s: string): string {
  let result = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const next = s[i + 1];
      switch (next) {
        case "\\": result += "\\"; i += 2; break;
        case "\"": result += "\""; i += 2; break;
        case "n": result += "\n"; i += 2; break;
        case "t": result += "\t"; i += 2; break;
        case "r": result += "\r"; i += 2; break;
        case "/": result += "/"; i += 2; break;
        case "b": result += "\b"; i += 2; break;
        case "f": result += "\f"; i += 2; break;
        case "u": {
          if (i + 5 < s.length) {
            const hex = s.substring(i + 2, i + 6);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              result += String.fromCharCode(parseInt(hex, 16));
              i += 6;
              break;
            }
          }
          result += s[i]; i++; break;
        }
        default:
          result += s[i]; i++; break;
      }
    } else {
      result += s[i]; i++;
    }
  }
  return result;
}

/**
 * Parses YAML like frontmatter content into VerifyRules.
 * Uses a simple key-value parser — no full YAML library dependency.
 * Supports: keywords, mode, requiredFiles, requiredCommands, requiredGit, fileContentPattern.
 */
export async function parseFrontmatter(yaml: string): Promise<VerifyRules | null> {
  try {
    const lines = yaml.split("\n");
    const keywords: string[] = [];
    let mode: "and" | "or" = "or";
    const requiredFiles: string[] = [];
    const requiredCommands: RequiredCommand[] = [];
    const fileContentPattern: FileContentRule[] = [];
    let requiredGit: RequiredGitRules | undefined;

    // Section tracking state (indent-aware: P2 fix)
    type Section = "none" | "keywords" | "requiredFiles" | "requiredCommands" | "requiredGit" | "fileContentPattern" | "cmdItem" | "fcItem";
    let currentSection: Section = "none";
    let sectionIndent = 0;
    let currentCmd: RequiredCommand | null = null;
    let currentFc: FileContentRule | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      const indent = line.length - line.trimStart().length;

      // Skip empty lines
      if (!trimmed) continue;

      // Top-level rules: key
      if (trimmed.startsWith("rules:") && indent === 0) {
        continue;
      }

      // Detect section starts by key prefix (P2 fix: indent-aware, no absolute indent check)
      // Flush any pending cmdItem/fcItem before switching section to prevent
      // silent data loss when a section key immediately follows the last item
      // (e.g., requiredCommands → keywords in generator output).
      if (
        trimmed.startsWith("keywords:") ||
        trimmed.startsWith("mode:") ||
        trimmed.startsWith("requiredFiles:") ||
        trimmed.startsWith("requiredCommands:") ||
        trimmed.startsWith("requiredGit:") ||
        trimmed.startsWith("fileContentPattern:")
      ) {
        if (currentSection === "cmdItem" && currentCmd) {
          requiredCommands.push({ ...currentCmd });
          currentCmd = null;
        }
        if (currentSection === "fcItem" && currentFc) {
          fileContentPattern.push({ ...currentFc });
          currentFc = null;
        }
      }

      if (trimmed.startsWith("keywords:")) {
        currentSection = "keywords";
        sectionIndent = indent;
        continue;
      }
      if (trimmed.startsWith("mode:")) {
        const value = trimmed.split(":")[1]?.trim();
        const modeVal = stripYamlQuotes(value);
        if (modeVal === "and" || modeVal === "or") mode = modeVal;
        currentSection = "none";
        continue;
      }
      if (trimmed.startsWith("requiredFiles:")) {
        currentSection = "requiredFiles";
        sectionIndent = indent;
        continue;
      }
      if (trimmed.startsWith("requiredCommands:")) {
        currentSection = "requiredCommands";
        sectionIndent = indent;
        continue;
      }
      if (trimmed.startsWith("requiredGit:")) {
        currentSection = "requiredGit";
        sectionIndent = indent;
        requiredGit = {};
        continue;
      }
      if (trimmed.startsWith("fileContentPattern:")) {
        currentSection = "fileContentPattern";
        sectionIndent = indent;
        continue;
      }

      // List items for simple string arrays
      if (trimmed.startsWith("- ")) {
        // Flush previous object items when starting a new list entry
        if (currentSection === "cmdItem" && currentCmd) {
          requiredCommands.push({ ...currentCmd });
          currentCmd = null;
        }
        if (currentSection === "fcItem" && currentFc) {
          fileContentPattern.push({ ...currentFc });
          currentFc = null;
        }

        if (currentSection === "keywords" || currentSection === "cmdItem") {
          if (currentSection === "keywords") {
            const kw = stripYamlQuotes(trimmed.slice(2));
            if (kw) keywords.push(kw);
            continue; // P1 fix: prevent trailing reset from clearing currentSection
          } else {
            // We were in cmdItem and got flushed above — switch to requiredCommands
            currentSection = "requiredCommands";
          }
        }
        if (currentSection === "requiredFiles") {
          const fp = stripYamlQuotes(trimmed.slice(2));
          if (fp) requiredFiles.push(fp);
          continue;
        }
        if (currentSection === "requiredCommands") {
          // Start a new command object — "- cmd: ..." or "- \"command\""
          currentCmd = { cmd: "" };
          currentSection = "cmdItem";
          const afterDash = trimmed.slice(2).trim();
          if (afterDash.startsWith("cmd:")) {
            currentCmd.cmd = stripYamlQuotes(afterDash.slice(4));
          } else if (afterDash) {
            currentCmd.cmd = stripYamlQuotes(afterDash);
          }
          continue;
        }
        if (currentSection === "fileContentPattern" || currentSection === "fcItem") {
          if (currentSection === "fcItem") {
            // Already flushed above — switch to fileContentPattern
            currentSection = "fileContentPattern";
          }
          // Start a new fileContentRule object — "- path: ..."
          currentFc = { path: "", pattern: "" };
          currentSection = "fcItem";
          const afterDash = trimmed.slice(2).trim();
          if (afterDash.startsWith("path:")) {
            currentFc.path = stripYamlQuotes(afterDash.slice(5));
          }
          continue;
        }
      }

      // Properties within a command item (4+ indent)
      if (currentSection === "cmdItem" && currentCmd) {
        if (trimmed.startsWith("cmd:")) {
          currentCmd.cmd = stripYamlQuotes(trimmed.slice(4));
        } else if (trimmed.startsWith("expectExit:")) {
          const val = trimmed.split(":")[1]?.trim();
          const num = parseInt(val, 10);
          if (!isNaN(num)) currentCmd.expectExit = num;
        } else if (trimmed.startsWith("expectOutput:")) {
          currentCmd.expectOutput = stripYamlQuotes(trimmed.slice(13));
        } else if (indent <= 2) {
          // New top-level section — save and exit
          requiredCommands.push({ ...currentCmd });
          currentCmd = null;
          currentSection = "none";
        }
        continue;
      }

      // Properties within a fileContentPattern item (4+ indent)
      if (currentSection === "fcItem" && currentFc) {
        if (trimmed.startsWith("path:")) {
          currentFc.path = stripYamlQuotes(trimmed.slice(5));
        } else if (trimmed.startsWith("pattern:")) {
          currentFc.pattern = stripYamlQuotes(trimmed.slice(8));
        } else if (indent <= 2) {
          fileContentPattern.push({ ...currentFc });
          currentFc = null;
          currentSection = "none";
        }
        continue;
      }

      // Properties within requiredGit (2+ indent)
      if (currentSection === "requiredGit" && requiredGit) {
        if (trimmed.startsWith("lastCommitWithin:")) {
          requiredGit.lastCommitWithin = stripYamlQuotes(trimmed.slice(18));
        } else if (trimmed.startsWith("branch:")) {
          requiredGit.branch = stripYamlQuotes(trimmed.slice(7));
        } else if (trimmed.startsWith("cleanWorkingTree:")) {
          const val = trimmed.split(":")[1]?.trim().toLowerCase();
          requiredGit.cleanWorkingTree = val === "true";
        } else if (indent === 0) {
          currentSection = "none";
        }
        continue;
      }

      // Non-matching line at low indent resets section (P2: relative to sectionIndent)
      if (indent <= sectionIndent) {
        // Flush pending items
        if (currentSection === "cmdItem" && currentCmd) {
          requiredCommands.push({ ...currentCmd });
          currentCmd = null;
        }
        if (currentSection === "fcItem" && currentFc) {
          fileContentPattern.push({ ...currentFc });
          currentFc = null;
        }
        currentSection = "none";
      }
    }

    // Flush any pending items at end of file
    if (currentSection === "cmdItem" && currentCmd) {
      requiredCommands.push({ ...currentCmd });
    }
    if (currentSection === "fcItem" && currentFc) {
      fileContentPattern.push({ ...currentFc });
    }

    // Empty-item validation: discard entries with blank path/pattern/keyword
    const emptyItems: string[] = [];
    const filteredKeywords = keywords.filter(kw => {
      const valid = kw.trim() !== "";
      if (!valid) emptyItems.push(`keywords: "${kw}"`);
      return valid;
    });
    const filteredRequiredFiles = requiredFiles.filter(fp => {
      const valid = fp.trim() !== "";
      if (!valid) emptyItems.push(`requiredFiles: "${fp}"`);
      return valid;
    });
    const filteredFileContentPattern = fileContentPattern.filter(rule => {
      const pathValid = rule.path.trim() !== "";
      const patternValid = rule.pattern.trim() !== "";
      if (!pathValid) emptyItems.push(`fileContentPattern missing path`);
      if (!patternValid) emptyItems.push(`fileContentPattern missing pattern (path="${rule.path}")`);
      return pathValid && patternValid;
    });
    if (emptyItems.length > 0) {
      await safeWriteAuditLog("verify_frontmatter_parse_error", {
        error: "Empty entries discarded",
        emptyItems: emptyItems.join("; "),
      });
    }

    // Determine if any rules exist at all
    const hasAnyRules =
      filteredKeywords.length > 0 ||
      filteredRequiredFiles.length > 0 ||
      requiredCommands.length > 0 ||
      !!requiredGit ||
      filteredFileContentPattern.length > 0;

    if (!hasAnyRules) {
      return null;
    }

    return {
      keywords: filteredKeywords,
      mode,
      ...(filteredRequiredFiles.length > 0 ? { requiredFiles: filteredRequiredFiles } : {}),
      ...(requiredCommands.length > 0 ? { requiredCommands } : {}),
      ...(requiredGit ? { requiredGit } : {}),
      ...(filteredFileContentPattern.length > 0 ? { fileContentPattern: filteredFileContentPattern } : {}),
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await safeWriteAuditLog("verify_frontmatter_parse_error", { error: errMsg }, "error");
    return null;
  }
}
