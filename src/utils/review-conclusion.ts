/**
 * @module review-conclusion
 * Review report parser for the review decision chain (Bug 4).
 *
 * Extracts the verdict (pass/fail) from the latest code review report in
 * `docs/review/` (201 Phase 3 dual read: `Code_Review_*` new family and
 * legacy `code_review_*`). Priority:
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
   * (verdict anchor missing from the deployed verify.md) and for the
   * `missing-expected` state (expected path is simply absent — the caller
   * treats it as "no conclusion yet", never as a fail).
   */
  verdict: "fail" | "pass" | null;
  /** How the verdict was determined */
  source: "blocker-section" | "conclusion-line" | "missing" | "contract-unavailable" | "missing-expected";
  /** Optional warning message (e.g., when verdict is inferred) */
  warn?: string;
}

import { NEW_CODE_REVIEW_RE, LEGACY_CODE_REVIEW_RE } from "../core/naming/doc-naming";
import { DEFAULT_REVIEW_DIR } from "../constants";

/**
 * Finds the latest review report file in the resolved review directory by mtime
 * (201 Phase 3 dual read): the new
 * `Code_Review_{reqBase}_Develop_Commit_{index}.md` family and the legacy
 * `code_review_{...}.md` family are both recognized; the newest file wins
 * regardless of which family it belongs to.
 *
 * 222 Phase 1: the directory is a PARAMETER (utils must not import `core/`, so
 * the caller passes `docsDirsOf(config).reviewDir`).
 *
 * @param projectRoot - Absolute path to the project root
 * @param reviewDir - Project-relative review directory (default `docs/review`)
 * @returns Absolute path to the latest review report, or null if none exists
 */
export async function findLatestReviewReport(
  projectRoot: string,
  reviewDir: string = DEFAULT_REVIEW_DIR,
): Promise<string | null> {
  const absReviewDir = path.isAbsolute(reviewDir)
    ? reviewDir
    : path.join(projectRoot, reviewDir);
  try {
    const entries = await fs.readdir(absReviewDir);
    // 201 Phase 3: family recognition via the doc-naming dual patterns
    const reviewFiles = entries.filter(
      (e) => NEW_CODE_REVIEW_RE.test(e) || LEGACY_CODE_REVIEW_RE.test(e),
    );
    if (reviewFiles.length === 0) return null;

    let bestFile: string | null = null;
    let bestMtime = 0;
    for (const file of reviewFiles) {
      try {
        const stat = await fs.stat(path.join(absReviewDir, file));
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          bestFile = file;
        }
      } catch {
        // stat failure — skip
      }
    }
    return bestFile ? path.join(absReviewDir, bestFile) : null;
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
 * @param reviewDir - Project-relative review directory (222 Phase 1; default
 *   `docs/review`). Callers pass `docsDirsOf(config).reviewDir`.
 * @param opts - 225 Phase 3 (T2): `expectedPath` selects the EXACT expected
 *   report of the current round (no mtime scan). When that file is absent the
 *   parser returns `{ verdict: null, source: "missing-expected" }` — the caller
 *   handles it as "no conclusion yet" (no routing, no fail).
 * @returns ReviewVerdict with verdict + source, or null if no report exists
 */
export async function parseReviewConclusion(
  projectRoot: string,
  anchors?: VerifyContractAnchors,
  reviewDir?: string,
  opts?: { expectedPath?: string },
): Promise<ReviewVerdict | null> {
  if (opts?.expectedPath) {
    const absExpected = path.isAbsolute(opts.expectedPath)
      ? opts.expectedPath
      : path.join(projectRoot, opts.expectedPath);
    let content: string;
    try {
      content = await fs.readFile(absExpected, "utf-8");
    } catch {
      // Expected path exists in the CONTRACT but not on disk: no conclusion.
      return { verdict: null, source: "missing-expected" };
    }
    return parseVerdictFromContent(content, anchors);
  }

  const reportPath = await findLatestReviewReport(projectRoot, reviewDir);
  if (!reportPath) return null;

  let content: string;
  try {
    content = await fs.readFile(reportPath, "utf-8");
  } catch {
    return null;
  }

  return parseVerdictFromContent(content, anchors);
}

/**
 * Parses a report body into a verdict (shared by the mtime-latest path and the
 * exact expectedPath path).
 */
function parseVerdictFromContent(
  content: string,
  anchors?: VerifyContractAnchors,
): ReviewVerdict | null {
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
