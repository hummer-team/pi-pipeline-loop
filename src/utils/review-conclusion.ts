/**
 * @module review-conclusion
 * Review report parser for the review decision chain (Bug 4).
 *
 * Extracts the verdict (pass/fail) from the latest code review report in
 * `docs/review/code_review_*.md`. Priority:
 * 1. Blocker/High/Medium open items → fail (matches `- 等级：Blocker`,
 *    `- [ ] Blocker`, `## Blocker`, `NOT PASS` formats)
 * 2. Conclusion/Verdict line (bilingual, bold/italic tolerant, Phase 0 / 175) → verdict from line
 *    - Chinese: `结论：(通过|不通过)` with optional `**`/`_` markup
 *    - English: `Verdict: (PASS|FAIL)` or `Conclusion: (pass|fail)`
 * 3. No conclusion line → fail + warn (conservative)
 * 4. No report file → null (caller treats as fail + warn)
 *
 * Pure parsing, no side effects.
 *
 * Phase 2 (176, R1Q1B "declaration is behavior"): verdict patterns are supplied
 * by the caller as runtime contract anchors loaded from the deployed verify.md
 * (`loadVerifyContractAnchors`). When the verdict anchor is unavailable the
 * parser returns the `contract-unavailable` state and the caller falls back to
 * the existing "undeclared reviewConclusion" branch (fail-open).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { VerifyContractAnchors } from "./contract-loader";

/**
 * Verdict result from review report parsing.
 */
export interface ReviewVerdict {
  /**
   * The extracted verdict. `null` only for the `contract-unavailable` state
   * (verdict anchor missing from the deployed verify.md).
   */
  verdict: "fail" | "pass" | null;
  /** How the verdict was determined */
  source: "blocker-section" | "conclusion-line" | "missing" | "contract-unavailable";
  /** Optional warning message (e.g., when verdict is inferred) */
  warn?: string;
}

/**
 * Finds the latest review report file in docs/review/code_review_*.md by mtime.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns Absolute path to the latest review report, or null if none exists
 */
export async function findLatestReviewReport(projectRoot: string): Promise<string | null> {
  const reviewDir = path.join(projectRoot, "docs", "review");
  try {
    const entries = await fs.readdir(reviewDir);
    const reviewFiles = entries.filter((e) => e.startsWith("code_review_") && e.endsWith(".md"));
    if (reviewFiles.length === 0) return null;

    let bestFile: string | null = null;
    let bestMtime = 0;
    for (const file of reviewFiles) {
      try {
        const stat = await fs.stat(path.join(reviewDir, file));
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          bestFile = file;
        }
      } catch {
        // stat failure — skip
      }
    }
    return bestFile ? path.join(reviewDir, bestFile) : null;
  } catch {
    // Directory doesn't exist
    return null;
  }
}

/**
 * Checks if a line contains an open blocker/high/medium item.
 * Matches patterns like:
 * - `- [ ] Blocker:` / `- [ ] High:` / `- [ ] Medium:` (checkbox format)
 * - `## Blocker` / `## High` / `## Medium` (section header format)
 * - `- 等级：Blocker` / `- 等级: High` / `- 等级：Medium` (real report format)
 * - `NOT PASS` (case-insensitive)
 */
function hasOpenIssueLine(line: string): boolean {
  const trimmed = line.trim();
  // Unchecked task list with severity keyword
  if (/^-\s*\[\s*\]/.test(trimmed)) {
    if (/blocker|high|medium/i.test(trimmed)) return true;
  }
  // Section header with severity keyword
  if (/^##\s+(blocker|high|medium)/i.test(trimmed)) return true;
  // Real report format: `- 等级：Blocker` / `- 等级: High` / `- 等级：Medium`
  if (/^-\s*等级\s*[:：]\s*(blocker|high|medium)/i.test(trimmed)) return true;
  // Explicit "NOT PASS" marker
  if (/not\s+pass/i.test(trimmed)) return true;
  return false;
}

// ── Verdict regex from runtime contract anchors (bilingual, bold/italic tolerant) ──

/**
 * Maps a captured verdict token to a pass/fail code.
 * The判别 rule is code-internal and unchanged (Phase 2 / 176, R3Q2 solution ③):
 * `不通过` / `FAIL` / `fail` (case-insensitive) → fail, everything else → pass.
 */
function tokenToVerdict(token: string): "pass" | "fail" {
  if (token === "不通过") return "fail";
  if (/^fail$/i.test(token)) return "fail";
  return "pass";
}

/**
 * Extracts a verdict from a conclusion line using the anchor pattern set.
 * Patterns are tried in declaration order with the `i` flag; the first pattern
 * whose capture group 1 matches wins.
 *
 * Does NOT match `待定` or other non-committal terms.
 */
function parseConclusionLine(
  line: string,
  verdictPatterns: readonly string[],
): "pass" | "fail" | null {
  const trimmed = line.trim();

  for (const pattern of verdictPatterns) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      continue;
    }
    const match = re.exec(trimmed);
    if (match && match[1] !== undefined) {
      return tokenToVerdict(match[1]);
    }
  }

  return null;
}

/**
 * Parses the review conclusion from the latest review report.
 *
 * @param projectRoot - Absolute path to the project root
 * @param anchors - Runtime contract anchors loaded from the deployed verify.md.
 *   When the `verdict` anchor is unavailable, the `contract-unavailable` state
 *   is returned so the caller can fall back to the undeclared branch (fail-open).
 * @returns ReviewVerdict with verdict + source, or null if no report exists
 */
export async function parseReviewConclusion(
  projectRoot: string,
  anchors?: VerifyContractAnchors,
): Promise<ReviewVerdict | null> {
  const reportPath = await findLatestReviewReport(projectRoot);
  if (!reportPath) return null;

  let content: string;
  try {
    content = await fs.readFile(reportPath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n");

  // Priority 1: Check for Blocker/High/Medium open items.
  // The blocker scan is code-internal and does NOT depend on contract anchors
  // (Phase 2 / 176: `hasOpenIssueLine` behavior unchanged).
  for (const line of lines) {
    if (hasOpenIssueLine(line)) {
      return { verdict: "fail", source: "blocker-section" };
    }
  }

  // Fail-open: no verdict anchor declared → report the unavailability state so
  // the caller falls back to the undeclared reviewConclusion branch.
  const verdictPatterns = anchors?.verdict?.patterns;
  if (!verdictPatterns || verdictPatterns.length === 0) {
    return {
      verdict: null,
      source: "contract-unavailable",
      warn: "Verdict contract anchor unavailable; verify.md verdict runtime anchor is missing.",
    };
  }

  // Priority 2: Check for conclusion line (scan from bottom for the last one)
  for (let i = lines.length - 1; i >= 0; i--) {
    const verdict = parseConclusionLine(lines[i], verdictPatterns);
    if (verdict !== null) {
      return { verdict, source: "conclusion-line" };
    }
  }

  // Priority 3: No conclusion line → conservative fail + warn
  return {
    verdict: "fail",
    source: "missing",
    warn: "No conclusion line found in review report; defaulting to fail.",
  };
}
