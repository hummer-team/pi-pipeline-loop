/**
 * @module keyword-verifier
 * Verifies assistant messages contain required keywords (legacy compatibility).
 * Extracted from the original ruleVerify() in auto-verifier.ts.
 */

import type { AuditLogFn } from "../../types";
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

/**
 * Verifies `modelRuntimeResult` patterns against the aggregated assistant
 * messages of the current stage (Phase 1 / 176, R4Q5A).
 *
 * The aggregated text is evaluated as a whole with the `m` flag, so patterns
 * may anchor to line starts across message boundaries.
 *
 * @param patterns - Regex patterns (source strings)
 * @param mode - "and" = all patterns must match, "or" = any pattern match passes
 * @param assistantMessages - Aggregated assistant message strings
 * @param logError - Optional audit log callback for invalid-regex errors
 * @returns Verification result with the missing patterns on failure
 */
export function verifyModelRuntimeResult(
  patterns: string[] | undefined,
  mode: "and" | "or",
  assistantMessages: string[],
  logError?: AuditLogFn,
): VerifierResult {
  if (!patterns || patterns.length === 0) {
    return { passed: true, detail: "No model runtime patterns to check" };
  }

  const aggregated = assistantMessages.join("\n");

  const matches = (pattern: string): boolean => {
    try {
      return new RegExp(pattern, "m").test(aggregated);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Fire-and-forget audit; the invalid pattern counts as a non-match.
      void logError?.("verify_error", {
        ruleType: "modelRuntimeResult",
        pattern,
        error: errMsg,
      });
      return false;
    }
  };

  if (mode === "and") {
    const missing = patterns.filter((p) => !matches(p));
    if (missing.length > 0) {
      return {
        passed: false,
        detail: `Missing model runtime patterns (AND mode): ${missing.join(", ")}`,
      };
    }
    return { passed: true, detail: `All ${patterns.length} model runtime patterns found (AND mode)` };
  }

  const found = patterns.some((p) => matches(p));
  if (found) {
    return { passed: true, detail: "At least one model runtime pattern found (OR mode)" };
  }
  return {
    passed: false,
    detail: `No model runtime patterns found (OR mode): ${patterns.join(", ")}`,
  };
}
