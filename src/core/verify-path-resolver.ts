/**
 * @module verify-path-resolver
 * Path resolution helpers for verify.md rule paths.
 *
 * Extracted from auto-verifier.ts (Phase 5 / 161_Feat) to isolate
 * plan-doc resolution and placeholder substitution from orchestration.
 *
 * Exports:
 * - resolvePlaceholders: replace {requirementDoc} and {pipelineId} in rule paths/patterns
 * - resolvePlanDocPath: derive plan doc path from requirementDoc
 * - planDocHasConfirmMarker: check for confirmation header
 * - applyConcreteStageDocPaths: replace glob patterns with concrete paths (plan/develop/fix/review)
 * - isPlanDocGlob: detect plan doc glob patterns
 * - isCommitDocGlob: detect commit doc glob patterns
 * - isReviewDocGlob: detect review doc glob patterns
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig, PipelineStage, SessionMeta } from "../types";
import type { VerifyRules, FileContentRule } from "./verify-frontmatter";
import { globMatchFiles } from "./verifiers/file-verifier";

/**
 * Replaces `{requirementDoc}` and `{pipelineId}` placeholders in rule paths
 * and fileContentPattern patterns with actual values from session metadata.
 *
 * When `meta.requirementDoc` is unset (undefined or empty string), placeholders
 * are preserved as-is (not replaced with empty string). This prevents downstream
 * EISDIR errors from `path.join(projectRoot, "")` resolving to the project root.
 * Same guard applies to `meta.pipelineId`.
 *
 * 168 Phase 3: `{pipelineId}` replacement added for both path and pattern fields,
 * enabling fileContentPattern to validate pipeline-specific content markers.
 *
 * @param rules - Parsed verification rules
 * @param meta - Session metadata (may contain requirementDoc and pipelineId)
 * @returns A new VerifyRules object with placeholders resolved
 */
export function resolvePlaceholders(rules: VerifyRules, meta: SessionMeta): VerifyRules {
  const reqDoc = meta.requirementDoc;
  const pipelineId = meta.pipelineId;

  // When requirementDoc is unset, preserve the placeholder as-is (L2-A fix)
  const replaceReqDoc = (s: string): string =>
    reqDoc ? s.replace(/\{requirementDoc\}/g, reqDoc) : s;

  // When pipelineId is unset, preserve the placeholder as-is (same guard)
  const replacePipelineId = (s: string): string =>
    pipelineId ? s.replace(/\{pipelineId\}/g, pipelineId) : s;

  // Compose both replacements (order-independent since placeholders are distinct)
  const replace = (s: string): string => replacePipelineId(replaceReqDoc(s));

  const resolved: VerifyRules = { ...rules };

  if (resolved.requiredFiles) {
    resolved.requiredFiles = resolved.requiredFiles.map(replace);
  }
  if (resolved.fileContentPattern) {
    resolved.fileContentPattern = resolved.fileContentPattern.map((rule) => ({
      ...rule,
      path: replace(rule.path),
      // 168 Phase 3: also replace {pipelineId} in the pattern field
      pattern: replace(rule.pattern),
    }));
  }

  return resolved;
}

/**
 * Resolves the plan document path from session metadata's requirementDoc.
 *
 * Derivation: `{dirname}/{basename_without_.md}_plan.md`
 * - Prevents `_plan` duplication: if already `xxx_plan.md`, returns as-is
 * - Falls back to glob `docs/design/*_plan.md` (latest mtime) when derivation is unavailable
 * - Returns null if no plan doc can be found
 *
 * @param config - Pipeline configuration (for projectRoot)
 * @param meta - Session metadata (may contain requirementDoc)
 */
export async function resolvePlanDocPath(
  config: PipelineConfig,
  meta: SessionMeta,
): Promise<string | null> {
  const reqDoc = meta.requirementDoc;

  // Try derivation from requirementDoc
  if (reqDoc && reqDoc.endsWith(".md")) {
    const dir = path.dirname(reqDoc);
    const base = path.basename(reqDoc, ".md");
    // Prevent _plan duplication
    const planBase = base.endsWith("_plan") ? base : `${base}_plan`;
    const derived = path.join(dir, `${planBase}.md`);
    return path.isAbsolute(derived) ? derived : path.join(config.projectRoot, derived);
  }

  // Fallback: glob docs/design/*_plan.md, return latest by mtime
  try {
    const matches = await globMatchFiles("docs/design/*_plan.md", config.projectRoot);
    if (matches.length === 0) return null;

    // Resolve to absolute paths and get mtime
    let latestPath: string | null = null;
    let latestMtime = 0;
    for (const rel of matches) {
      const abs = path.isAbsolute(rel) ? rel : path.join(config.projectRoot, rel);
      try {
        const stat = await fs.stat(abs);
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latestPath = abs;
        }
      } catch {
        // skip unreadable files
      }
    }
    return latestPath;
  } catch {
    return null;
  }
}

/**
 * Checks whether the plan document contains a confirmation marker.
 * Matches either the legacy Chinese marker `## 用户确认` or the bilingual
 * marker `## User Confirmation` at the start of any line (multiline mode).
 *
 * @param planDocPath - Absolute path to the plan document
 */
export async function planDocHasConfirmMarker(planDocPath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(planDocPath, "utf-8");
    return /^## (用户确认|User Confirmation)/m.test(content);
  } catch {
    return false;
  }
}

/**
 * Replaces glob patterns in rule paths with concrete paths narrowed to
 * the current requirementDoc basename.
 *
 * 168 Phase 3: Extended beyond "plan" stage to cover develop/fix/review.
 * - plan: `docs/design/*_plan.md` → concrete plan doc path (via resolvePlanDocPath)
 * - develop/fix: `docs/design/*_commit.md` → `docs/design/{reqBase}_*_commit.md`
 * - review: `docs/review/code_review_*.md` → `docs/review/code_review_{reqBase}*.md`
 *
 * When `meta.requirementDoc` is empty, globs are preserved as-is (fallback).
 * When concrete resolution fails, the original glob is preserved (fallback).
 *
 * @param rules - Parsed verification rules (after resolvePlaceholders)
 * @param config - Pipeline configuration
 * @param meta - Session metadata
 */
export async function applyConcreteStageDocPaths(
  rules: VerifyRules,
  config: PipelineConfig,
  meta: SessionMeta,
): Promise<VerifyRules> {
  const reqDoc = meta.requirementDoc;
  // Guard: when requirementDoc is missing, return rules unchanged
  if (!reqDoc) return rules;

  const reqBase = path.basename(reqDoc, ".md");
  if (!reqBase) return rules;

  const stage = meta.currentStage;
  const result: VerifyRules = { ...rules };

  // Determine the concrete glob pattern for the current stage
  let concreteGlob: string | null = null;

  if (stage === "plan") {
    // Plan stage: resolve to concrete plan doc path via mtime fallback
    const planDocPath = await resolvePlanDocPath(config, meta);
    if (planDocPath) {
      const relPlanDoc = path.relative(config.projectRoot, planDocPath);
      return replaceGlobInRules(result, isPlanDocGlob, relPlanDoc);
    }
    return rules; // fallback: preserve original globs
  }

  if (stage === "develop" || stage === "fix") {
    // Narrow commit doc glob to requirementDoc basename
    concreteGlob = `docs/design/${reqBase}_*_commit.md`;
    return replaceGlobInRules(result, isCommitDocGlob, concreteGlob);
  }

  if (stage === "review") {
    // Narrow review doc glob to requirementDoc basename
    concreteGlob = `docs/review/code_review_${reqBase}*.md`;
    return replaceGlobInRules(result, isReviewDocGlob, concreteGlob);
  }

  // Other stages (clarify, awaiting_human, completed): no narrowing
  return rules;
}

/**
 * Replaces paths matching a glob detector with a concrete path in both
 * requiredFiles and fileContentPattern rules.
 */
function replaceGlobInRules(
  rules: VerifyRules,
  isMatch: (pattern: string) => boolean,
  concretePath: string,
): VerifyRules {
  const result: VerifyRules = { ...rules };

  if (result.requiredFiles) {
    result.requiredFiles = result.requiredFiles.map((p) =>
      isMatch(p) ? concretePath : p,
    );
  }

  if (result.fileContentPattern) {
    result.fileContentPattern = result.fileContentPattern.map((rule) => ({
      ...rule,
      path: isMatch(rule.path) ? concretePath : rule.path,
    }));
  }

  return result;
}

/**
 * Checks whether a path pattern matches the plan doc glob `docs/design/*_plan.md`.
 */
export function isPlanDocGlob(pattern: string): boolean {
  return pattern === "docs/design/*_plan.md" || pattern === "docs\\design\\*_plan.md";
}

/**
 * Checks whether a path pattern matches the commit doc glob `docs/design/*_commit.md`.
 * 168 Phase 3: Used by applyConcreteStageDocPaths to narrow develop/fix globs.
 */
export function isCommitDocGlob(pattern: string): boolean {
  return pattern === "docs/design/*_commit.md" || pattern === "docs\\design\\*_commit.md";
}

/**
 * Checks whether a path pattern matches the review doc glob `docs/review/code_review_*.md`.
 * 168 Phase 3: Used by applyConcreteStageDocPaths to narrow review globs.
 */
export function isReviewDocGlob(pattern: string): boolean {
  return pattern === "docs/review/code_review_*.md" || pattern === "docs\\review\\code_review_*.md";
}
