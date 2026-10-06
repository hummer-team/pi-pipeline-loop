/**
 * @module design-review/report
 * 192 fix (issue 3): thin report FILE-I/O shim.
 *
 * The parallel weak report parser (verifyDesignReviewReport with basename
 * matching, first-20/500-character structure heuristics and "none"/"无"
 * substring filtering) and its helper validateReportStructure are RETIRED
 * here per plan Phase 0 task 2 / Phase 3 tasks 4 & 10 ("report semantics
 * migrated into verifiers — no parallel old implementation").
 *
 * The SINGLE authoritative report semantics live in
 * `core/verifiers/design-review-verifier.ts` (verifyDesignReviewReportSnapshot
 * over one snapshot). This module only adapts that same parsing to the
 * recovery path that has a report PATH but no in-memory outcome yet:
 * `extractReportIssues` reads the file and delegates item extraction to the
 * domain parser (canonical inert-line exclusion + exact whole-item sentinel
 * rules — never a weaker second implementation).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { extractDesignReviewIssueItems } from "../verifiers/design-review-verifier";

/**
 * Extract valid issue texts from a review report file using the SAME
 * canonical semantics as the domain verifier (stripInertLines + exact
 * "None"/"无" whole-item sentinels).
 *
 * Used by coordinator recovery paths that only have the report path (the
 * primary FAIL-consumption path receives verified issues from the trusted
 * domain outcome and does NOT re-read). Returns an empty array when the
 * file is absent or unreadable — callers treat that as "no issues to feed",
 * which the strict update-identity checks reject downstream, never a silent
 * PASS.
 *
 * @param reportPath - Path to the review report
 * @returns Array of issue descriptions (stable order, one per valid item)
 */
export function extractReportIssues(reportPath: string): string[] {
  const normalizedPath = path.resolve(reportPath);
  let content: string;
  try {
    content = fs.readFileSync(normalizedPath, "utf-8");
  } catch {
    return [];
  }
  return extractDesignReviewIssueItems(content).map((issue) => issue.text);
}
