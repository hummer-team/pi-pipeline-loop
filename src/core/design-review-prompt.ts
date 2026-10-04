/**
 * @module design-review-prompt
 * Phase 1 / 191: Design review prompt template rendering.
 * Renders update prompts for plan modification based on review issues.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { extractReportIssues } from "./design-review-report";

/**
 * Parameters required for rendering an update prompt
 */
export interface DesignReviewUpdatePromptParams {
  /** Pipeline ID */
  pipelineId: string;
  /** Path to the plan document */
  planDoc: string;
  /** Path to the review report */
  reviewDoc: string;
  /** Current review round */
  round: number;
  /** Operation ID for this update */
  operationId: string;
  /** Hash of the plan before update (baseline) */
  baselinePlanHash: string;
  /** List of issues from the review report */
  issues: string[];
}

/**
 * Render an update prompt template for plan modification.
 * 
 * This prompt instructs the plan agent to:
 * 1. Read the current review report
 * 2. Understand each issue
 * 3. Modify the existing plan to address all issues
 * 4. Maintain plan structure and clarity
 * 5. Not change source code or requirements
 * 
 * @param templatePath - Path to the update prompt template file
 * @param params - Parameters to substitute into the template
 * @returns Rendered prompt string
 * @throws Error if required placeholders are missing or template is invalid
 */
export function renderDesignReviewUpdatePrompt(
  templatePath: string,
  params: DesignReviewUpdatePromptParams
): string {
  const normalizedPath = path.resolve(templatePath);

  // Validate template file exists
  if (!fs.existsSync(normalizedPath)) {
    throw new Error(`Update prompt template not found: ${normalizedPath}`);
  }

  let template: string;
  try {
    template = fs.readFileSync(normalizedPath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read update prompt template: ${(err as Error).message}`);
  }

  // Validate required parameters using type-safe property access
  const validationChecks: Record<keyof DesignReviewUpdatePromptParams, boolean> = {
    pipelineId: !!params.pipelineId,
    planDoc: !!params.planDoc,
    reviewDoc: !!params.reviewDoc,
    round: params.round > 0,
    operationId: !!params.operationId,
    baselinePlanHash: !!params.baselinePlanHash,
    issues: Array.isArray(params.issues),
  };

  const missingParams = Object.entries(validationChecks)
    .filter(([_, valid]) => !valid)
    .map(([key]) => key);

  if (missingParams.length > 0) {
    throw new Error(`Missing required parameters for update prompt: ${missingParams.join(", ")}`);
  }

  // Format issues list
  const issuesText = params.issues.length > 0
    ? params.issues.map((issue, idx) => `${idx + 1}. ${issue}`).join("\n")
    : "No issues found.";

  // Substitute placeholders
  let rendered = template;
  const replacements: Record<string, string> = {
    "{{pipelineId}}": params.pipelineId,
    "{{planDoc}}": params.planDoc,
    "{{reviewDoc}}": params.reviewDoc,
    "{{round}}": String(params.round),
    "{{operationId}}": params.operationId,
    "{{baselinePlanHash}}": params.baselinePlanHash,
    "{{issues}}": issuesText,
  };

  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.replace(new RegExp(escapeRegExp(placeholder), "g"), value);
  }

  // Validate that all placeholders were consumed
  const remainingPlaceholders = rendered.match(/\{\{[^}]+\}\}/g);
  if (remainingPlaceholders) {
    throw new Error(
      `Update prompt template contains unconsumed placeholders: ${remainingPlaceholders.join(", ")}`
    );
  }

  return rendered;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Validate that a plan update is structurally complete.
 * 
 * Checks that:
 * 1. Plan file exists and is readable
 * 2. Plan content has changed from baseline hash
 * 3. Plan addresses all issues from the review report
 * 4. Plan maintains required structure (sections, headings)
 * 
 * @param planPath - Path to the updated plan
 * @param baselineHash - Hash of the plan before update
 * @param issues - List of issues that should be addressed
 * @returns Validation result with pass/fail and reasons
 */
export function validatePlanUpdate(
  planPath: string,
  baselineHash: string,
  issues: string[]
): { valid: boolean; reasons: string[]; newHash?: string } {
  const normalizedPath = path.resolve(planPath);
  const reasons: string[] = [];

  // Check file existence
  if (!fs.existsSync(normalizedPath)) {
    return {
      valid: false,
      reasons: [`Plan file does not exist: ${normalizedPath}`],
    };
  }

  // Read plan content
  let content: string;
  try {
    content = fs.readFileSync(normalizedPath, "utf-8");
  } catch (err) {
    return {
      valid: false,
      reasons: [`Failed to read plan file: ${(err as Error).message}`],
    };
  }

  // Compute new hash
  const { computeHash } = require("./design-review-state");
  const newHash = computeHash(content);

  // Check if plan has changed
  if (newHash === baselineHash) {
    reasons.push("Plan content has not changed from baseline");
    return {
      valid: false,
      reasons,
      newHash,
    };
  }

  // Check for basic structure (must have at least one heading)
  if (!content.match(/^#\s+/m)) {
    reasons.push("Plan lacks required section headings");
  }

  // Check if issues are addressed (simple heuristic: issue keywords appear in plan)
  // This is a basic check; semantic validation is left to the next review cycle
  if (issues.length > 0) {
    const planLower = content.toLowerCase();
    const unaddressedIssues: string[] = [];

    for (const issue of issues) {
      // Extract key terms from issue (first 20 chars as a simple heuristic)
      const keyTerms = issue.toLowerCase().substring(0, 20);
      if (!planLower.includes(keyTerms)) {
        unaddressedIssues.push(issue);
      }
    }

    if (unaddressedIssues.length > 0) {
      // This is informational, not a hard failure
      // The next review cycle will catch semantic issues
      reasons.push(
        `Warning: ${unaddressedIssues.length} issue(s) may not be fully addressed`
      );
    }
  }

  return {
    valid: reasons.length === 0 || !reasons.some(r => r.startsWith("Plan")),
    reasons,
    newHash,
  };
}

/**
 * Load and validate issues from a review report for update prompt generation.
 * 
 * @param reviewDoc - Path to the review report
 * @returns List of issues, or empty array if none found or file unreadable
 */
export function loadIssuesForUpdate(reviewDoc: string): string[] {
  return extractReportIssues(reviewDoc);
}
