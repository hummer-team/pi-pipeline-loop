/**
 * @module keyword-verifier
 * Verifies assistant messages contain required keywords (legacy compatibility).
 * Extracted from the original ruleVerify() in auto-verifier.ts.
 */

import type { VerifierResult } from "./file-verifier";

/**
 * Verifies that assistant messages contain the required keywords.
 *
 * @param keywords - Array of keyword strings to search for
 * @param mode - "and" = all must match, "or" = any match passes
 * @param assistantMessages - Aggregated assistant message strings
 * @returns Verification result with missing keywords on failure
 */
export function verifyRequiredKeywords(
  keywords: string[] | undefined,
  mode: "and" | "or",
  assistantMessages: string[],
): VerifierResult {
  if (!keywords || keywords.length === 0) {
    return { passed: true, detail: "No keywords to check" };
  }

  const aggregated = assistantMessages.join("\n");

  if (mode === "and") {
    const missing = keywords.filter((kw) => !aggregated.includes(kw));
    if (missing.length > 0) {
      return {
        passed: false,
        detail: `Missing keywords (AND mode): ${missing.join(", ")}`,
      };
    }
    return { passed: true, detail: `All ${keywords.length} keywords found (AND mode)` };
  }

  // mode "or" — any keyword match passes
  const found = keywords.some((kw) => aggregated.includes(kw));
  if (found) {
    return { passed: true, detail: `At least one keyword found (OR mode)` };
  }
  return {
    passed: false,
    detail: `No keywords found (OR mode): ${keywords.join(", ")}`,
  };
}
