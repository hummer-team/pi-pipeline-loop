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
  /**
   * File-level default path for group rule nodes (Phase 0 / 176, R4Q4A).
   * Rule nodes inherit this path when their own `path` is absent.
   */
  path?: string;
  /**
   * Verification groups (Phase 0 / 176). Groups are evaluated with AND across
   * groups; each group combines its rule nodes via `ruleMode`.
   */
  groups?: VerifyGroup[];
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
 * Rule node type enumeration for groups-based verify.md
 * (Phase 0 / 176, decisions R1Q2A / R2Q1A / R4Q1A).
 */
export type VerifyRuleNodeType =
  | "requiredFile"
  | "fileContentPattern"
  | "requiredCommand"
  | "requiredGit"
  | "modelRuntimeResult";

/**
 * A single rule node inside a verification group.
 * Three-in-one node: `{ type, mode?, patterns[], path?, runtime?, ... }`.
 * A single `pattern:` line is normalized to a one-element `patterns` list.
 */
export interface VerifyGroupRuleNode {
  /** The rule kind this node evaluates. */
  type: VerifyRuleNodeType;
  /** Node-level combination mode across `patterns[]` (default "and"). */
  mode?: "and" | "or";
  /** Regex patterns (file content / model runtime result). */
  patterns?: string[];
  /** Node-level path override; inherits `rules.path` when absent. */
  path?: string;
  /**
   * Runtime anchor semantic name (Phase 0 / 176, R6Q1A single key).
   * Marks this node's `patterns` as the runtime source for the named anchor.
   */
  runtime?: string;
  /** requiredCommand: command to execute. */
  cmd?: string;
  /** requiredCommand: expected exit code (default 0). */
  expectExit?: number;
  /** requiredCommand: expected stdout substring. */
  expectOutput?: string;
  /** requiredGit: time window for last commit. */
  lastCommitWithin?: string;
  /** requiredGit: expected branch name. */
  branch?: string;
  /** requiredGit: whether the working tree must be clean. */
  cleanWorkingTree?: boolean;
}

/**
 * A verification group (Phase 0 / 176, single-level; nested groups excluded).
 */
export interface VerifyGroup {
  /** Group name, surfaced in failure details as `[group:name]`. */
  name: string;
  /**
   * Optional gate trigger pattern (Phase 0 / 176, R2Q2A).
   * When absent, or when it matches nothing, the group always passes.
   */
  when?: string;
  /**
   * Evaluation granularity (R5Q1A): "section" = split by round headings and
   * evaluate each section; absent = whole-document evaluation.
   */
  scope?: "section";
  /** Combination mode across rule nodes (default "and"). */
  ruleMode?: "and" | "or";
  /** Runtime anchor for the group-level `when` pattern (R6Q1A). */
  runtime?: string;
  /** Rule nodes evaluated within this group. */
  rules: VerifyGroupRuleNode[];
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

// ─── Groups / rule-node schema parsing (Phase 0 / 176) ───────────────────────

/** Valid rule node types for groups-based verify.md. */
const VALID_RULE_NODE_TYPES = new Set<VerifyRuleNodeType>([
  "requiredFile",
  "fileContentPattern",
  "requiredCommand",
  "requiredGit",
  "modelRuntimeResult",
]);

/** Collects non-fatal parsing findings for audit logging. */
interface GroupsParseIssues {
  /** Rule nodes / groups dropped during validation. */
  discards: string[];
  /** Tolerated schema problems (e.g. invalid mode values). */
  warnings: string[];
}

/** Raw intermediate shape accumulated while scanning a rule node block. */
interface RawRuleNode {
  type?: string;
  mode?: "and" | "or";
  patterns: string[];
  path?: string;
  runtime?: string;
  cmd?: string;
  expectExit?: number;
  expectOutput?: string;
  lastCommitWithin?: string;
  branch?: string;
  cleanWorkingTree?: boolean;
}

/** Returns the leading-space count of a line. */
function lineIndent(line: string): number {
  return line.length - line.trimStart().length;
}

/** Blank lines and full-line comments are ignored (inline comments unsupported). */
function isSkippableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/**
 * Normalizes a group/node mode value. Invalid or missing values fall back to
 * "and" (the documented default for groups) and are recorded as warnings.
 */
function normalizeGroupMode(
  value: string | undefined,
  label: string,
  issues: GroupsParseIssues,
): "and" | "or" {
  const normalized = stripYamlQuotes(value ?? "");
  if (normalized === "and" || normalized === "or") return normalized;
  if (normalized) {
    issues.warnings.push(`${label} invalid value "${normalized}" (expected "and"/"or"), defaulted to "and"`);
  }
  return "and";
}

/**
 * Parses an inline flow array `[ "a", "b" ]` with a quote-aware comma split,
 * so commas inside quoted regex patterns (e.g. `{1,2}`) are preserved.
 */
function parseInlinePatternArray(raw: string): string[] {
  let inner = raw.trim();
  if (inner.startsWith("[")) inner = inner.slice(1);
  if (inner.endsWith("]")) inner = inner.slice(0, -1);

  const parts: string[] = [];
  let current = "";
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (const ch of inner) {
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === "\\" && inDouble) { current += ch; escaped = true; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === "," && !inDouble && !inSingle) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  parts.push(current);

  return parts.map((p) => stripYamlQuotes(p)).filter((p) => p !== "");
}

/**
 * Consumes block-form `patterns:` list items (lines deeper than the key).
 * Returns the index of the last consumed line so the caller can resume scanning.
 */
function collectBlockPatterns(
  lines: string[],
  patternsKeyIdx: number,
  propsIndent: number,
  out: string[],
): number {
  let k = patternsKeyIdx + 1;
  for (; k < lines.length; k++) {
    const line = lines[k];
    if (isSkippableLine(line)) continue;
    if (lineIndent(line) <= propsIndent) break;
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) out.push(stripYamlQuotes(trimmed.slice(2)));
  }
  return k - 1;
}

/**
 * Scans a single `- type: ...` rule node block (properties at `itemIndent + 2`).
 * Returns the raw node plus the index where the block ended.
 */
function parseRuleNodeItem(
  lines: string[],
  startIdx: number,
  itemIndent: number,
  issues: GroupsParseIssues,
): { raw: RawRuleNode; endIdx: number } {
  const firstTrimmed = lines[startIdx].trim();
  const afterDash = firstTrimmed.slice(2).trim();
  const raw: RawRuleNode = { patterns: [] };

  if (afterDash.startsWith("type:")) {
    raw.type = stripYamlQuotes(afterDash.slice(5));
  } else if (afterDash && !afterDash.includes(":")) {
    raw.type = stripYamlQuotes(afterDash);
  }

  const propsIndent = itemIndent + 2;
  let i = startIdx + 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (isSkippableLine(line)) continue;
    const indent = lineIndent(line);
    if (indent <= itemIndent) break;
    if (indent !== propsIndent) continue;
    const trimmed = line.trim();

    if (trimmed.startsWith("type:")) { raw.type = stripYamlQuotes(trimmed.slice(5)); continue; }
    if (trimmed.startsWith("mode:")) { raw.mode = normalizeGroupMode(trimmed.slice(5), "Rule node mode", issues); continue; }
    if (trimmed.startsWith("path:")) { raw.path = stripYamlQuotes(trimmed.slice(5)); continue; }
    if (trimmed.startsWith("runtime:")) { raw.runtime = stripYamlQuotes(trimmed.slice(8)); continue; }
    if (trimmed.startsWith("pattern:")) {
      const value = stripYamlQuotes(trimmed.slice(8));
      if (value) raw.patterns.push(value);
      continue;
    }
    if (trimmed.startsWith("patterns:")) {
      const rawValue = trimmed.slice(9).trim();
      if (rawValue.startsWith("[")) {
        raw.patterns.push(...parseInlinePatternArray(rawValue));
      } else {
        i = collectBlockPatterns(lines, i, propsIndent, raw.patterns);
      }
      continue;
    }
    if (trimmed.startsWith("cmd:")) { raw.cmd = stripYamlQuotes(trimmed.slice(4)); continue; }
    if (trimmed.startsWith("expectExit:")) {
      const parsed = parseInt(trimmed.slice(11).trim(), 10);
      if (!Number.isNaN(parsed)) raw.expectExit = parsed;
      continue;
    }
    if (trimmed.startsWith("expectOutput:")) { raw.expectOutput = stripYamlQuotes(trimmed.slice(13)); continue; }
    if (trimmed.startsWith("lastCommitWithin:")) { raw.lastCommitWithin = stripYamlQuotes(trimmed.slice(18)); continue; }
    if (trimmed.startsWith("branch:")) { raw.branch = stripYamlQuotes(trimmed.slice(7)); continue; }
    if (trimmed.startsWith("cleanWorkingTree:")) {
      raw.cleanWorkingTree = trimmed.split(":")[1]?.trim().toLowerCase() === "true";
      continue;
    }
  }

  return { raw, endIdx: i };
}

/**
 * Validates a raw rule node and normalizes it into a `VerifyGroupRuleNode`.
 * Discards invalid nodes and records the reason in `issues.discards`.
 */
function finalizeRuleNode(
  raw: RawRuleNode,
  fileLevelPath: string | undefined,
  issues: GroupsParseIssues,
): VerifyGroupRuleNode | null {
  if (!raw.type || !VALID_RULE_NODE_TYPES.has(raw.type as VerifyRuleNodeType)) {
    issues.discards.push(`rule node discarded: invalid or missing type "${raw.type ?? ""}"`);
    return null;
  }
  const type = raw.type as VerifyRuleNodeType;
  const effectivePath = raw.path ?? fileLevelPath;

  if ((type === "requiredFile" || type === "fileContentPattern") && !effectivePath) {
    issues.discards.push(`rule node discarded: ${type} has no path (node-level and file-level both absent)`);
    return null;
  }
  if ((type === "fileContentPattern" || type === "modelRuntimeResult") && raw.patterns.length === 0) {
    issues.discards.push(`rule node discarded: ${type} has no patterns`);
    return null;
  }
  if (type === "requiredCommand" && (!raw.cmd || raw.cmd.trim() === "")) {
    issues.discards.push("rule node discarded: requiredCommand has no cmd");
    return null;
  }
  if (type === "requiredGit" && !raw.lastCommitWithin && !raw.branch && raw.cleanWorkingTree !== true) {
    issues.discards.push("rule node discarded: requiredGit has no git fields");
    return null;
  }

  const node: VerifyGroupRuleNode = { type };
  if (raw.mode) node.mode = raw.mode;
  if (raw.patterns.length > 0) node.patterns = raw.patterns;
  if (raw.path) node.path = raw.path;
  if (raw.runtime) node.runtime = raw.runtime;
  if (raw.cmd !== undefined) node.cmd = raw.cmd;
  if (raw.expectExit !== undefined) node.expectExit = raw.expectExit;
  if (raw.expectOutput !== undefined) node.expectOutput = raw.expectOutput;
  if (raw.lastCommitWithin !== undefined) node.lastCommitWithin = raw.lastCommitWithin;
  if (raw.branch !== undefined) node.branch = raw.branch;
  if (raw.cleanWorkingTree !== undefined) node.cleanWorkingTree = raw.cleanWorkingTree;
  return node;
}

/**
 * Parses the `rules:` list inside a group (nodes at `rulesIndent + 2`).
 */
function parseRuleNodes(
  lines: string[],
  rulesKeyIdx: number,
  rulesIndent: number,
  fileLevelPath: string | undefined,
  issues: GroupsParseIssues,
): { nodes: VerifyGroupRuleNode[]; endIdx: number } {
  const nodes: VerifyGroupRuleNode[] = [];
  const itemIndent = rulesIndent + 2;
  let i = rulesKeyIdx + 1;

  while (i < lines.length) {
    const line = lines[i];
    if (isSkippableLine(line)) { i++; continue; }
    const indent = lineIndent(line);
    if (indent <= rulesIndent) break;

    if (indent === itemIndent && line.trim().startsWith("- ")) {
      const { raw, endIdx } = parseRuleNodeItem(lines, i, itemIndent, issues);
      const node = finalizeRuleNode(raw, fileLevelPath, issues);
      if (node) nodes.push(node);
      i = endIdx;
      continue;
    }
    i++;
  }

  return { nodes, endIdx: i };
}

/**
 * Parses a single group item block (`- name: ...` with properties at `itemIndent + 2`).
 * Empty groups (all nodes discarded) are preserved — they pass by definition.
 */
function parseGroupItem(
  lines: string[],
  startIdx: number,
  itemIndent: number,
  fileLevelPath: string | undefined,
  issues: GroupsParseIssues,
): { group: VerifyGroup; endIdx: number } {
  const firstTrimmed = lines[startIdx].trim();
  const afterDash = firstTrimmed.slice(2).trim();
  let name = "";
  if (afterDash.startsWith("name:")) name = stripYamlQuotes(afterDash.slice(5));
  else if (afterDash && !afterDash.includes(":")) name = stripYamlQuotes(afterDash);

  const propsIndent = itemIndent + 2;
  let when: string | undefined;
  let scope: "section" | undefined;
  let ruleMode: "and" | "or" | undefined;
  let runtime: string | undefined;
  let rules: VerifyGroupRuleNode[] = [];

  let i = startIdx + 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (isSkippableLine(line)) continue;
    const indent = lineIndent(line);
    if (indent <= itemIndent) break;
    if (indent !== propsIndent) continue;
    const trimmed = line.trim();

    if (trimmed.startsWith("name:")) { name = stripYamlQuotes(trimmed.slice(5)); continue; }
    if (trimmed.startsWith("when:")) { when = stripYamlQuotes(trimmed.slice(5)); continue; }
    if (trimmed.startsWith("scope:")) {
      const value = stripYamlQuotes(trimmed.slice(6));
      if (value === "section") scope = "section";
      else if (value) issues.warnings.push(`group "${name}" invalid scope "${value}" (only "section" or omitted)`);
      continue;
    }
    if (trimmed.startsWith("ruleMode:")) {
      ruleMode = normalizeGroupMode(trimmed.slice(9), `Group "${name}" ruleMode`, issues);
      continue;
    }
    if (trimmed.startsWith("runtime:")) { runtime = stripYamlQuotes(trimmed.slice(8)); continue; }
    if (trimmed.startsWith("rules:")) {
      const parsed = parseRuleNodes(lines, i, propsIndent, fileLevelPath, issues);
      rules = parsed.nodes;
      i = parsed.endIdx - 1;
      continue;
    }
  }

  const group: VerifyGroup = { name, rules };
  if (when !== undefined) group.when = when;
  if (scope !== undefined) group.scope = scope;
  if (ruleMode !== undefined) group.ruleMode = ruleMode;
  if (runtime !== undefined) group.runtime = runtime;
  return { group, endIdx: i };
}

/**
 * Parses the `groups:` block (items at `groupsIndent + 2`).
 */
function parseGroupsBlock(
  lines: string[],
  groupsIdx: number,
  fileLevelPath: string | undefined,
  issues: GroupsParseIssues,
): { groups: VerifyGroup[]; endIdx: number } {
  const groupsIndent = lineIndent(lines[groupsIdx]);
  const itemIndent = groupsIndent + 2;
  const groups: VerifyGroup[] = [];
  let i = groupsIdx + 1;

  while (i < lines.length) {
    const line = lines[i];
    if (isSkippableLine(line)) { i++; continue; }
    const indent = lineIndent(line);
    if (indent <= groupsIndent) break;

    if (indent === itemIndent && line.trim().startsWith("- ")) {
      const { group, endIdx } = parseGroupItem(lines, i, itemIndent, fileLevelPath, issues);
      groups.push(group);
      i = endIdx;
      continue;
    }
    i++;
  }

  return { groups, endIdx: i };
}

/**
 * Parses YAML like frontmatter content into VerifyRules.
 * Uses a simple key-value parser — no full YAML library dependency.
 * Supports: keywords, mode, requiredFiles, requiredCommands, requiredGit, fileContentPattern.
 * Phase 0 / 176 adds file-level `path:` and `groups:` (rule-node schema).
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

    // ── Phase 0 / 176: file-level `path:` + `groups:` block under `rules:` ──
    // Parsed separately (dedicated indent-aware scanner) and excluded from the
    // legacy flat parser below, so legacy flat-key behavior stays unchanged.
    const parseIssues: GroupsParseIssues = { discards: [], warnings: [] };
    let fileLevelPath: string | undefined;
    let groupsIdx = -1;
    for (let gi = 0; gi < lines.length; gi++) {
      const candidate = lines[gi];
      if (isSkippableLine(candidate)) continue;
      if (lineIndent(candidate) !== 2) continue;
      const candidateTrimmed = candidate.trim();
      if (candidateTrimmed.startsWith("path:")) {
        fileLevelPath = stripYamlQuotes(candidateTrimmed.slice(5));
      } else if (candidateTrimmed.startsWith("groups:")) {
        groupsIdx = gi;
        break;
      }
    }

    let groups: VerifyGroup[] = [];
    let groupsEnd = -1;
    if (groupsIdx >= 0) {
      const parsedGroups = parseGroupsBlock(lines, groupsIdx, fileLevelPath, parseIssues);
      groups = parsedGroups.groups;
      groupsEnd = parsedGroups.endIdx;
    }

    // Pre-filter: exclude the groups block (already parsed above, prevents node
    // `mode:` etc. from being misread by the legacy flat state machine) and
    // full-line comments (inline comments are intentionally unsupported).
    const legacyLines = lines.filter((raw, idx) => {
      if (groupsIdx >= 0 && idx >= groupsIdx && idx < groupsEnd) return false;
      return !raw.trim().startsWith("#");
    });

    for (const line of legacyLines) {
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
        // Widen for control-flow analysis: `currentSection` may hold any Section
        // value at this point (it is assigned across many branches below).
        const sectionAtTop: Section = currentSection;
        if (sectionAtTop === "cmdItem" && currentCmd) {
          requiredCommands.push({ ...currentCmd });
          currentCmd = null;
        }
        if (sectionAtTop === "fcItem" && currentFc) {
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

    // Phase 0 / 176: record groups schema findings (discarded nodes / invalid modes).
    if (parseIssues.discards.length > 0) {
      await safeWriteAuditLog("verify_frontmatter_parse_error", {
        error: "Groups rule nodes discarded",
        details: parseIssues.discards.join("; "),
      });
    }
    if (parseIssues.warnings.length > 0) {
      await safeWriteAuditLog("verify_frontmatter_parse_error", {
        error: "Groups schema warnings",
        details: parseIssues.warnings.join("; "),
      }, "warn");
    }

    // Determine if any rules exist at all (Phase 0 / 176: groups-only counts)
    const hasAnyRules =
      filteredKeywords.length > 0 ||
      filteredRequiredFiles.length > 0 ||
      requiredCommands.length > 0 ||
      !!requiredGit ||
      filteredFileContentPattern.length > 0 ||
      groups.length > 0;

    if (!hasAnyRules) {
      return null;
    }

    return {
      keywords: filteredKeywords,
      mode,
      ...(fileLevelPath ? { path: fileLevelPath } : {}),
      ...(groups.length > 0 ? { groups } : {}),
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
