/**
 * @module review-conclusion
 * Review report parser for the review decision chain (Bug 4).
 *
 * Extracts the verdict (pass/fail) from the latest code review report in
 * `docs/review/code_review_*.md`. Priority:
 * 1. Blocker/High/Medium open items → fail (matches `- 等级：Blocker`,
 *    `- [ ] Blocker`, `## Blocker`, `NOT PASS` formats)
 * 2. Conclusion line `結論[:：](通过|不通过)` → verdict from line
 * 3. No conclusion line → fail + warn (conservative)
 * 4. No report file → null (caller treats as fail + warn)
 *
 * Pure parsing, no side effects.
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Verdict result from review report parsing.
 */
export interface ReviewVerdict {
  /** The extracted verdict */
  verdict: "fail" | "pass";
  /** How the verdict was determined */
  source: "blocker-section" | "conclusion-line" | "missing";
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

/**
 * Extracts verdict from a conclusion line.
 * Matches patterns like:
 * - `结论：通过` / `结论:通过` / `结论：不通过` / `结论: 不通过`
 * - `Conclusion: pass` / `Conclusion: fail`
 */
function parseConclusionLine(line: string): "pass" | "fail" | null {
  const trimmed = line.trim();
  // Chinese: 结论[:：](不通过|通过)
  if (/结论\s*[:：]\s*不通过/.test(trimmed)) return "fail";
  if (/结论\s*[:：]\s*通过/.test(trimmed)) return "pass";
  // English: Conclusion[:：](fail|pass)
  if (/conclusion\s*[:：]\s*fail/i.test(trimmed)) return "fail";
  if (/conclusion\s*[:：]\s*pass/i.test(trimmed)) return "pass";
  return null;
}

/**
 * Parses the review conclusion from the latest review report.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns ReviewVerdict with verdict + source, or null if no report exists
 */
export async function parseReviewConclusion(projectRoot: string): Promise<ReviewVerdict | null> {
  const reportPath = await findLatestReviewReport(projectRoot);
  if (!reportPath) return null;

  let content: string;
  try {
    content = await fs.readFile(reportPath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n");

  // Priority 1: Check for Blocker/High/Medium open items
  for (const line of lines) {
    if (hasOpenIssueLine(line)) {
      return { verdict: "fail", source: "blocker-section" };
    }
  }

  // Priority 2: Check for conclusion line (scan from bottom for the last one)
  for (let i = lines.length - 1; i >= 0; i--) {
    const verdict = parseConclusionLine(lines[i]);
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
