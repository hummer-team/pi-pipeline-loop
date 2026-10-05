/**
 * @module design-review-report
 * Phase 1 / 191: Design review report verification and verdict logic.
 * Reads review reports, validates structure, and determines pass/fail/invalid verdicts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { computeHash } from "./design-review-state";
import type { DesignReviewReportVerdict } from "../types";

/**
 * Report structure validation result
 */
export interface ReportValidationResult {
  valid: boolean;
  issues: string[];
  passFound: boolean;
  failFound: boolean;
  issuesList: string[];
}

/**
 * Read and validate a design review report file.
 * Returns verdict (pass/fail/invalid) with report hash and reasoning.
 * 
 * @param reportPath - Absolute path to the review report
 * @param planPath - Expected plan path (for attribution validation)
 * @param round - Expected round number
 * @returns Verdict result with hash and reasoning
 */
export function verifyDesignReviewReport(
  reportPath: string,
  planPath: string,
  round: number
): DesignReviewReportVerdict {
  const normalizedPath = path.resolve(reportPath);
  
  // Step 1: Check file existence and readability
  if (!fs.existsSync(normalizedPath)) {
    return {
      verdict: "invalid",
      reportHash: undefined,
      reason: `Report file does not exist: ${normalizedPath}`,
    };
  }

  let content: string;
  try {
    content = fs.readFileSync(normalizedPath, "utf-8");
  } catch (err) {
    return {
      verdict: "invalid",
      reportHash: undefined,
      reason: `Failed to read report file: ${(err as Error).message}`,
    };
  }

  // Step 2: Compute report hash
  const reportHash = computeHash(content);

  // Step 3: Validate report structure
  const validation = validateReportStructure(content, planPath, round);

  if (!validation.valid) {
    return {
      verdict: "invalid",
      reportHash,
      reason: `Report structure validation failed: ${validation.issues.join("; ")}`,
    };
  }

  // Step 4: Apply verdict rules (in priority order)
  
  // Rule 1: Valid non-empty issues list → fail (even if PASS also present)
  if (validation.issuesList.length > 0) {
    return {
      verdict: "fail",
      reportHash,
      reason: `Found ${validation.issuesList.length} issue(s) requiring fix`,
    };
  }

  // Rule 2: No valid issues and PASS/FAIL mutually exclusive → invalid
  if (validation.passFound && validation.failFound) {
    return {
      verdict: "invalid",
      reportHash,
      reason: "Report contains both PASS and FAIL markers (mutually exclusive)",
    };
  }

  // Rule 3: Single clear PASS → pass
  if (validation.passFound && !validation.failFound) {
    return {
      verdict: "pass",
      reportHash,
      reason: "Report contains clear PASS verdict with no issues",
    };
  }

  // Rule 4: Single clear FAIL → fail
  if (validation.failFound && !validation.passFound) {
    return {
      verdict: "fail",
      reportHash,
      reason: "Report contains clear FAIL verdict",
    };
  }

  // Rule 5: Empty or unknown tokens → invalid
  return {
    verdict: "invalid",
    reportHash,
    reason: "Report lacks clear PASS/FAIL verdict or contains only empty headings",
  };
}

/**
 * Validate report structure and extract verdict/issues.
 * 
 * Report must contain:
 * - **pipeline** marker (for attribution)
 * - Plan path reference
 * - Round number
 * - Clear verdict section with PASS/FAIL
 * - Issues section (can be empty for PASS)
 * 
 * @param content - Report file content
 * @param expectedPlanPath - Expected plan document path
 * @param expectedRound - Expected round number
 * @returns Validation result with extracted verdict and issues
 */
function validateReportStructure(
  content: string,
  expectedPlanPath: string,
  expectedRound: number
): ReportValidationResult {
  const issues: string[] = [];
  let passFound = false;
  let failFound = false;
  const issuesList: string[] = [];

  // Normalize line endings
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const lines = normalizedContent.split("\n");

  // Check for required markers (case-insensitive, supports bold)
  let hasPipelineMarker = false;
  let hasPlanReference = false;
  let hasRoundReference = false;

  // Track sections
  let inVerdictSection = false;
  let inIssuesSection = false;
  let issuesSectionEnded = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lowerLine = line.toLowerCase();

    // Check for pipeline marker (supports **pipeline**: value or pipeline: value)
    // Must be in key-value format to avoid false positives from text mentioning "pipeline"
    if (lowerLine.match(/\*\*pipeline\*\*\s*:/) || lowerLine.match(/\bpipeline\s*:/)) {
      hasPipelineMarker = true;
    }

    // Check for plan reference (supports various formats)
    if (line.includes(expectedPlanPath) || line.includes(path.basename(expectedPlanPath))) {
      hasPlanReference = true;
    }

    // Check for round reference (supports **round**: 1, round: 1, Round 1, etc.)
    const roundMatch = line.match(/round[^\d]*(\d+)/i);
    if (roundMatch && parseInt(roundMatch[1], 10) === expectedRound) {
      hasRoundReference = true;
    }

    // Detect verdict section
    if (lowerLine.includes("## verdict") || lowerLine.includes("## 结论") || 
        lowerLine.includes("# verdict") || lowerLine.includes("# 结论")) {
      inVerdictSection = true;
      inIssuesSection = false;
      continue;
    }

    // Detect issues section
    if (lowerLine.includes("## issues") || lowerLine.includes("## 问题") ||
        lowerLine.includes("# issues") || lowerLine.includes("# 问题")) {
      inIssuesSection = true;
      inVerdictSection = false;
      continue;
    }

    // Detect section end (next ## or # heading)
    if (line.startsWith("## ") || line.startsWith("# ")) {
      if (inIssuesSection) {
        issuesSectionEnded = true;
      }
      inVerdictSection = false;
      inIssuesSection = false;
    }

    // Parse verdict section
    if (inVerdictSection) {
      // Check for FAIL first (supports various formats) - MUST check before PASS to avoid false positives
      // "不通过" (not pass) contains "通过" (pass), so we must check for the negation first
      // Also check for "not pass" to avoid false positive when reason contains this phrase
      if (lowerLine.includes("**fail**") || lowerLine === "fail" ||
          lowerLine.includes("fail") || lowerLine.includes("不通过") || 
          lowerLine.includes("待修复") || lowerLine.includes("not pass")) {
        // Exclude false positives
        if (!line.startsWith("```") && !line.startsWith(">") && !line.startsWith("//")) {
          failFound = true;
        }
      }
      // Check for PASS (supports various formats, including **PASS**, pass, 通过)
      // Only set passFound if we haven't already found a FAIL (to handle "不通过" correctly)
      // Also exclude lines containing negation words like "not pass" or "不通过"
      else if (lowerLine.includes("**pass**") || lowerLine === "pass" || 
          lowerLine.includes("pass") || lowerLine.includes("通过")) {
        // Exclude false positives in code blocks, quotes, or lines with negation
        if (!line.startsWith("```") && !line.startsWith(">") && !line.startsWith("//") &&
            !lowerLine.includes("not pass") && !lowerLine.includes("不通过")) {
          passFound = true;
        }
      }
    }

    // Parse issues section
    if (inIssuesSection && !issuesSectionEnded) {
      // Detect issue items (numbered list, bullet points, or issue headers)
      const issueMatch = line.match(/^(\d+[\.\)]\s+|[-*]\s+|###?\s+issue\s*\d+)/i);
      if (issueMatch) {
        // Extract issue description (everything after the marker)
        const issueText = line.substring(issueMatch[0].length).trim();
        if (issueText && !issueText.toLowerCase().includes("none") && 
            !issueText.toLowerCase().includes("无") &&
            issueText.length > 0) {
          issuesList.push(issueText);
        }
      }
    }
  }

  // Validate required markers
  if (!hasPipelineMarker) {
    issues.push("Missing **pipeline** attribution marker");
  }
  if (!hasPlanReference) {
    issues.push(`Missing plan path reference (expected: ${expectedPlanPath})`);
  }
  if (!hasRoundReference) {
    issues.push(`Missing or incorrect round reference (expected: ${expectedRound})`);
  }

  return {
    valid: issues.length === 0,
    issues,
    passFound,
    failFound,
    issuesList,
  };
}

/**
 * Extract issues list from a report file.
 * Used for generating update prompts.
 * 
 * @param reportPath - Path to the review report
 * @returns Array of issue descriptions
 */
export function extractReportIssues(reportPath: string): string[] {
  const normalizedPath = path.resolve(reportPath);
  
  if (!fs.existsSync(normalizedPath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(normalizedPath, "utf-8");
    const validation = validateReportStructure(content, "", 0);
    return validation.issuesList;
  } catch {
    return [];
  }
}
