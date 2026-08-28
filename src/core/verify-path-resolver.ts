/**
 * @module verify-path-resolver
 * Path resolution helpers for verify.md rule paths.
 *
 * Extracted from auto-verifier.ts (Phase 5 / 161_Feat) to isolate
 * plan-doc resolution and placeholder substitution from orchestration.
 *
 * Exports:
 * - resolvePlaceholders: replace {requirementDoc} in rule paths
 * - resolvePlanDocPath: derive plan doc path from requirementDoc
 * - planDocHasConfirmMarker: check for confirmation header
 * - applyConcreteStageDocPaths: replace glob patterns with concrete paths
 * - isPlanDocGlob: detect plan doc glob patterns
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig, PipelineStage, SessionMeta } from "../types";
import type { VerifyRules, FileContentRule } from "./verify-frontmatter";
import { globMatchFiles } from "./verifiers/file-verifier";

/**
 * Replaces `{requirementDoc}` placeholders in rule paths with the actual
 * requirement document path from session metadata.
 *
 * When `meta.requirementDoc` is unset (undefined or empty string), placeholders
 * are preserved as-is (not replaced with empty string). This prevents downstream
 * EISDIR errors from `path.join(projectRoot, "")` resolving to the project root.
 *
 * @param rules - Parsed verification rules
 * @param meta - Session metadata (may contain requirementDoc)
 * @returns A new VerifyRules object with placeholders resolved
 */
export function resolvePlaceholders(rules: VerifyRules, meta: SessionMeta): VerifyRules {
  const reqDoc = meta.requirementDoc;
  // When requirementDoc is unset, preserve the placeholder as-is (L2-A fix)
  const replace = (s: string): string =>
    reqDoc ? s.replace(/\{requirementDoc\}/g, reqDoc) : s;

  const resolved: VerifyRules = { ...rules };

  if (resolved.requiredFiles) {
    resolved.requiredFiles = resolved.requiredFiles.map(replace);
  }
  if (resolved.fileContentPattern) {
    resolved.fileContentPattern = resolved.fileContentPattern.map((rule) => ({
      ...rule,
      path: replace(rule.path),
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
 * Checks whether the plan document contains the `## 用户确认` confirmation marker.
 * The pattern matches the header at the start of any line (multiline mode).
 *
 * @param planDocPath - Absolute path to the plan document
 */
export async function planDocHasConfirmMarker(planDocPath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(planDocPath, "utf-8");
    return /^## 用户确认/m.test(content);
  } catch {
    return false;
  }
}

/**
 * Replaces glob patterns like `docs/design/*_plan.md` in rule paths with the
 * concrete plan document path resolved from requirementDoc.
 *
 * Only applies when currentStage === "plan". If resolvePlanDocPath fails,
 * the glob pattern is preserved as-is (fallback behavior).
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
  if (meta.currentStage !== "plan") return rules;

  const planDocPath = await resolvePlanDocPath(config, meta);
  if (!planDocPath) return rules;

  // Compute relative path from projectRoot for rule comparison
  const relPlanDoc = path.relative(config.projectRoot, planDocPath);

  const result: VerifyRules = { ...rules };

  // Replace glob in requiredFiles
  if (result.requiredFiles) {
    result.requiredFiles = result.requiredFiles.map((p) =>
      isPlanDocGlob(p) ? relPlanDoc : p,
    );
  }

  // Replace glob in fileContentPattern paths
  if (result.fileContentPattern) {
    result.fileContentPattern = result.fileContentPattern.map((rule) => ({
      ...rule,
      path: isPlanDocGlob(rule.path) ? relPlanDoc : rule.path,
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
