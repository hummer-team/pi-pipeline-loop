/**
 * @module verifiers/design-review-verifier
 * 192 Phase 3 (K07/F02): trusted semantic verifier for design-review REPORTS.
 *
 * Pure over a caller-provided content SNAPSHOT (single read upstream): this
 * module never reads files, globs directories, writes meta or dispatches.
 * It decides the domain verdict from the SAME content that produced
 * reportHash, bound to the CURRENT run identity:
 *
 * - identity fields (canonical full-field comparison, never basename/includes):
 *     **pipeline**: {pipelineId}
 *     **plan**: {absolute planDoc}
 *     **round**: {round}
 *     **operation**: {review operationId}
 *     **input hash**: {review inputHash == authorized plan content hash}
 *   Attribution/contract unverifiable ⇒ invalid.
 * - verdict: taken ONLY from verdict-pattern matches on content lines outside
 *   fenced code / blockquotes / HTML comments. A "PASS" word in a Summary
 *   body is NOT a verdict line (patterns are anchored). Unknown capture
 *   tokens never default to pass.
 * - issues: extracted from the `## Issues` heading section over the SAME
 *   cleaned content. The sentinel for "no issues" is an EXACT whole-item
 *   "None"/"无"; "无法恢复…" is still a real issue.
 * - decision order:
 *     1. attribution/version unverifiable → invalid
 *     2. valid non-empty issues → fail (even when a PASS line also exists)
 *     3. no issues + mutually exclusive PASS & FAIL → invalid
 *     4. canonical single PASS → pass; single FAIL → fail
 *     5. empty issues heading / unknown token / no conclusion → invalid
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import type { ReviewIssue } from "../../types";

/** Expected identity binding for the CURRENT review operation. */
export interface DesignReviewReportExpectation {
  pipelineId: string;
  /** Canonical absolute plan path */
  planDoc: string;
  round: number;
  /** Review operation id; when provided the report MUST carry it */
  operationId?: string;
  /** Review inputHash (authorized plan content hash); must appear when known */
  inputHash?: string;
}

export type DesignReviewReportVerdict =
  | {
      verdict: "pass" | "fail";
      reportHash: string;
      issues: ReviewIssue[];
      reason: string;
    }
  | { verdict: "invalid"; failures: string[]; reportHash?: string };

/**
 * Default anchored verdict patterns (capture group 1). Business verify.md
 * `runtime: verdict` anchor patterns REPLACE these when the contract is
 * usable; the default set mirrors the shipped template. Anchoring (full-line
 * patterns) is what keeps prose "PASS" from acting as a verdict.
 */
export const DEFAULT_DESIGN_REVIEW_VERDICT_PATTERNS: readonly string[] = [
  "结论\\s*[:：]\\s*[*_]{0,2}(不通过|通过)[*_]{0,2}",
  "Verdict\\s*[:：]\\s*[*_]{0,2}(PASS|FAIL)[*_]{0,2}",
  "Conclusion\\s*[:：]\\s*[*_]{0,2}(?!(?:PASS|FAIL)\\b)(pass|fail)[*_]{0,2}",
  "\\*\\*Design Review[:：]\\s*(PASS|FAIL)\\*\\*",
  "\\*\\*设计评审[:：]\\s*(通过|不通过)\\*\\*",
];

/** Default issue heading anchor (matches `## Issues` / `## 问题`). */
export const DEFAULT_ISSUE_HEADING_PATTERN = "^#{1,4}\\s*(Issues|问题列表|问题)\\s*$";

/** Exact whole-item sentinels meaning "no issues". */
const NO_ISSUE_SENTINELS = new Set(["none", "无", "n/a", "not applicable"]);

export function computeReportHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Clean report content for semantic scanning: remove fenced code blocks
 * (both ``` and ~~~), block-quote lines and HTML comments. Returns lines
 * with original indices preserved for heading scans.
 */
export function stripInertLines(content: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  let inHtmlComment = false;
  for (const raw of content.split("\n")) {
    const line = raw;
    const fenceMatch = line.match(/^\s*(```|~~~)/);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) {
        fence = marker;
        continue; // fence open line is inert too
      }
      if (marker === fence) {
        fence = null;
        continue;
      }
      continue; // different marker inside a fence
    }
    if (fence) continue;
    if (inHtmlComment) {
      if (line.includes("-->")) inHtmlComment = false;
      continue;
    }
    if (/^\s*<!--/.test(line) && !/-->\s*$/.test(line)) {
      inHtmlComment = true;
      continue;
    }
    if (/^\s*<!--.*-->\s*$/.test(line)) continue; // single-line comment
    if (/^\s*>/.test(line)) continue; // blockquotes
    out.push(line);
  }
  return out;
}

/** Extract the section under a heading matching headingRe until the next
 *  heading of same-or-higher level. Returns null when the heading is absent. */
function extractSection(lines: readonly string[], headingRe: RegExp): { lines: string[]; empty: boolean } | null {
  const idx = lines.findIndex((l) => headingRe.test(l));
  if (idx === -1) return null;
  const levelMatch = lines[idx]!.match(/^(#+)/);
  const level = levelMatch ? levelMatch[1]!.length : 2;
  const section: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const h = line.match(/^(#+)\s/);
    if (h && h[1]!.length <= level) break;
    section.push(line);
  }
  const bodyLines = section.filter((l) => l.trim() !== "");
  return { lines: section, empty: bodyLines.length === 0 };
}

/** Extract list/table issue items from the Issues section body. */
function parseIssueItems(sectionLines: readonly string[]): string[] {
  const items: string[] = [];
  for (const line of sectionLines) {
    const bullet = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (bullet) {
      items.push(bullet[1]!.trim());
      continue;
    }
    const tableRow = line.match(/^\s*\|(.+)\|\s*$/);
    if (tableRow && !/^\s*\|[\s:|-]+\|\s*$/.test(line)) {
      const cells = tableRow[1]!.split("|").map((c) => c.trim());
      const first = cells[0]?.toLowerCase() ?? "";
      if (first === "#" || first === "issue" || first === "问题" || first === "") continue;
      // Prefer the "Issue" column when a 3+ column table is used
      const text = cells.length >= 2 ? (cells[1] ?? cells[0]!) : cells[0]!;
      if (text && text.toLowerCase() !== "issue") items.push(text);
      continue;
    }
    // Bare (non-list, non-heading, non-table) non-empty lines in the Issues
    // section count as items — the canonical no-issues sentinel ("None"/"无")
    // is written this way and MUST be visible to the sentinel check.
    const trimmed = line.trim();
    if (trimmed !== "" && !/^#/.test(trimmed)) {
      items.push(trimmed);
    }
  }
  return items;
}

/** Locate an identity field row (case-insensitive label, full-line match). */
function findField(lines: readonly string[], label: string): string | undefined {
  const re = new RegExp(`^\\s*\\*{0,2}${label}\\*{0,2}\\s*[:：]\\s*(.+?)\\s*\\*{0,2}\\s*$`, "i");
  for (const line of lines) {
    const m = line.match(re);
    if (m) return m[1]!.replace(/\*+$/, "").trim();
  }
  return undefined;
}

function sameCanonicalPath(a: string, b: string): boolean {
  try {
    return path.resolve(a) === path.resolve(b);
  } catch {
    return false;
  }
}

/** Map a captured verdict token to pass/fail (不通过/FAIL/fail → fail). */
function tokenToVerdict(token: string): "pass" | "fail" {
  if (token === "不通过") return "fail";
  if (/^fail$/i.test(token)) return "fail";
  if (/^通过$/.test(token) || /^pass$/i.test(token)) return "pass";
  return "fail"; // unreachable: patterns capture only known tokens
}

/** True when the token is recognized by the verdict vocabulary. */
function isKnownVerdictToken(token: string): boolean {
  return /^(PASS|FAIL|通过|不通过|pass|fail)$/i.test(token);
}

/**
 * Verify a design-review report SNAPSHOT against the current review identity.
 * verdictPatterns/issueHeadingPattern let the loaded verify.md contract drive
 * the shapes (declaration is behavior); when omitted the built-in defaults
 * (mirroring the shipped template) apply.
 */
export function verifyDesignReviewReportSnapshot(
  content: string,
  expectation: DesignReviewReportExpectation,
  patterns?: { verdictPatterns?: readonly string[]; issueHeadingPattern?: string },
): DesignReviewReportVerdict {
  const reportHash = computeReportHash(content);
  const failures: string[] = [];
  const lines = stripInertLines(content);

  // ── 1. Identity/attribution (full canonical field comparison) ─────────────
  const pipelineField = findField(lines, "pipeline");
  if (pipelineField === undefined) {
    failures.push("missing **pipeline** identity field");
  } else if (pipelineField !== expectation.pipelineId) {
    failures.push(`pipeline identity mismatch: report="${pipelineField}" current="${expectation.pipelineId}"`);
  }

  const planField = findField(lines, "plan");
  if (planField === undefined) {
    failures.push("missing **plan** identity field");
  } else if (!sameCanonicalPath(planField, expectation.planDoc)) {
    failures.push("plan identity mismatch: report references a different plan document");
  }

  const roundField = findField(lines, "round");
  if (roundField === undefined) {
    failures.push("missing **round** identity field");
  } else if (roundField !== String(expectation.round)) {
    failures.push(`round identity mismatch: report="${roundField}" current="${expectation.round}"`);
  }

  if (expectation.operationId !== undefined) {
    const opField = findField(lines, "operation");
    if (opField === undefined) {
      failures.push("missing **operation** identity field");
    } else if (opField !== expectation.operationId) {
      failures.push("operation identity mismatch: report belongs to a different review operation");
    }
  }

  if (expectation.inputHash !== undefined) {
    const hashField = findField(lines, "input hash") ?? findField(lines, "input\\s*hash") ?? findField(lines, "输入版本") ?? findField(lines, "计划\\s*hash");
    if (hashField === undefined) {
      failures.push("missing **input hash** identity field");
    } else if (hashField !== expectation.inputHash) {
      failures.push("input hash mismatch: report was produced against a different plan version");
    }
  }

  if (failures.length > 0) {
    return { verdict: "invalid", failures, reportHash };
  }

  // ── 2. Verdict candidates (anchored patterns only) ────────────────────────
  const verdictPatterns = patterns?.verdictPatterns && patterns.verdictPatterns.length > 0
    ? patterns.verdictPatterns
    : DEFAULT_DESIGN_REVIEW_VERDICT_PATTERNS;

  const seen: Array<{ value: "pass" | "fail"; token: string; line: string }> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    for (const p of verdictPatterns) {
      let re: RegExp;
      try {
        re = new RegExp(p, "i");
      } catch {
        // Invalid regex in the contract → fail-closed for the domain verdict
        return { verdict: "invalid", failures: [`invalid verdict pattern in contract: ${p}`], reportHash };
      }
      const m = re.exec(trimmed);
      if (m && m[1] !== undefined) {
        if (!isKnownVerdictToken(m[1])) {
          // Unknown capture token NEVER defaults to pass
          return {
            verdict: "invalid",
            failures: [`unknown verdict token "${m[1]}" (no default pass) at: ${trimmed}`],
            reportHash,
          };
        }
        seen.push({ value: tokenToVerdict(m[1]), token: m[1], line: trimmed });
        break;
      }
    }
  }

  // ── 3. Issues section over the SAME cleaned content ───────────────────────
  const issueHeadingRe = (() => {
    try {
      return new RegExp(patterns?.issueHeadingPattern ?? DEFAULT_ISSUE_HEADING_PATTERN, "i");
    } catch {
      return new RegExp(DEFAULT_ISSUE_HEADING_PATTERN, "i");
    }
  })();
  const issuesSection = extractSection(lines, issueHeadingRe);
  if (!issuesSection) {
    return { verdict: "invalid", failures: ["missing Issues section heading"], reportHash };
  }

  const rawItems = parseIssueItems(issuesSection.lines);
  const validIssues: ReviewIssue[] = [];
  for (const item of rawItems) {
    const normalized = item.replace(/\*\*|__/g, "").trim().toLowerCase();
    // Exact whole-item sentinel only; "无法恢复…" / "nonequivalent" still count
    if (NO_ISSUE_SENTINELS.has(normalized)) continue;
    validIssues.push({ issueId: String(validIssues.length + 1), text: item });
  }

  const sentinelPresent = rawItems.some((i) =>
    NO_ISSUE_SENTINELS.has(i.replace(/\*\*|__/g, "").trim().toLowerCase()),
  );

  if (issuesSection.empty && seen.length > 0) {
    return {
      verdict: "invalid",
      failures: ["Issues heading present but EMPTY — empty issues section is invalid"],
      reportHash,
    };
  }

  // ── 4. Decision order ──────────────────────────────────────────────────────
  if (validIssues.length > 0) {
    // Issues take precedence: even a PASS conclusion cannot mask valid issues
    const passAlsoPresent = seen.some((s) => s.value === "pass");
    return {
      verdict: "fail",
      reportHash,
      issues: validIssues,
      reason: passAlsoPresent
        ? "valid issues present — issues take precedence over PASS conclusion"
        : "valid issues present",
    };
  }

  const hasPass = seen.some((s) => s.value === "pass");
  const hasFail = seen.some((s) => s.value === "fail");
  if (hasPass && hasFail) {
    return { verdict: "invalid", failures: ["mutually exclusive PASS and FAIL conclusions"], reportHash };
  }
  if (seen.length > 1 && hasPass && !hasFail) {
    // multiple PASS lines are tolerated (same conclusion repeated)
    return { verdict: "pass", reportHash, issues: [], reason: "canonical single PASS conclusion" };
  }
  if (hasFail) {
    return {
      verdict: "fail",
      reportHash,
      // A FAIL conclusion with no issue items: issues MUST have been provided —
      // the section was empty of real items; FAIL without items is ambiguous
      // unless the section carried only the sentinel (then it would be PASS-side
      // exclusive) — keep fail with empty issues (consumer requires items).
      issues: [],
      reason: "FAIL conclusion without issue items",
    };
  }
  if (hasPass) {
    if (!sentinelPresent && rawItems.length === 0) {
      return {
        verdict: "invalid",
        failures: ["PASS without an explicit no-issues sentinel item"],
        reportHash,
      };
    }
    return { verdict: "pass", reportHash, issues: [], reason: "canonical single PASS conclusion" };
  }
  return { verdict: "invalid", failures: ["no recognized verdict conclusion line"], reportHash };
}
