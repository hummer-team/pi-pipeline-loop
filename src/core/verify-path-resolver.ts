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
import type { VerifyRules, VerifyGroupRuleNode } from "./verify-frontmatter";
import { globMatchFiles } from "./verifiers/file-verifier";
import { escapeRegExp } from "../utils/regex-utils";
import { commitDocFileName } from "./naming/doc-naming";
// 192 Phase 3: canonical report path derivation for the design-review stage
/**
 * Resolve the commit document path for a given requirement base name.
 * Single source of truth for the contract deliverable path.
 *
 * 201 Phase 2: generated name is the new `{reqBase}_Develop_Commit.md`
 * (derived from the doc-naming single source); legacy `{reqBase}_plan_commit.md`
 * remains READ-compatible via the dual-mode glob detectors but is never
 * generated any more.
 *
 * @param reqBase - Requirement document base name (without .md extension)
 * @returns Relative path to the commit document
 */
export function resolveCommitDocPath(reqBase: string): string {
  return `docs/design/${commitDocFileName(reqBase)}`;
}

/**
 * Get stage deliverable exemptions for read-only path checks.
 * When stage is develop/fix and requirementDoc exists, return the commit doc path
 * as an exemption (195 Phase 1).
 *
 * @param meta - Session metadata
 * @param stage - Current pipeline stage
 * @returns Array of relative paths that are exempt from read-only checks
 */
export function getStageDeliverableExemptions(
  meta: SessionMeta,
  stage: PipelineStage
): string[] {
  if ((stage === "develop" || stage === "fix") && meta.requirementDoc) {
    const reqBase = path.basename(meta.requirementDoc, ".md");
    if (reqBase) {
      return [resolveCommitDocPath(reqBase)];
    }
  }
  return [];
}

// (state is a pure leaf module — no import cycle through this edge).
import { deriveReportPath } from "./design-review/state";

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

  // Phase 1 / 176: file-level path used as the group rule-node default.
  if (resolved.path) {
    resolved.path = replace(resolved.path);
  }

  // Phase 1 / 176: penetrate groups (node path + pattern placeholders).
  if (resolved.groups) {
    resolved.groups = resolved.groups.map((group) => ({
      ...group,
      rules: group.rules.map((node) => {
        const nextNode: VerifyGroupRuleNode = { ...node };
        if (node.path) nextNode.path = replace(node.path);
        if (node.patterns) nextNode.patterns = node.patterns.map(replace);
        return nextNode;
      }),
    }));
  }

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
 * Derivation: `{dirname}/{basename_without_.md}_Plan.md` (201 Phase 1 hard switch)
 * - Prevents `_Plan` duplication: if already `xxx_Plan.md`, returns as-is
 * - Falls back to glob `docs/design/*_Plan.md` (latest mtime) when derivation is unavailable
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
    // Prevent _Plan duplication (201 Phase 1: new naming is `_Plan` hard switch)
    const planBase = base.endsWith("_Plan") ? base : `${base}_Plan`;
    const derived = path.join(dir, `${planBase}.md`);
    return path.isAbsolute(derived) ? derived : path.join(config.projectRoot, derived);
  }

  // 201 Phase 1: fallback glob docs/design/*_Plan.md, return latest by mtime
  try {
    const matches = await globMatchFiles("docs/design/*_Plan.md", config.projectRoot);
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
 * - plan: `docs/design/*_Plan.md` → concrete plan doc path (via resolvePlanDocPath)
 * - develop/fix: commit-doc globs (new `docs/design/*_Develop_Commit.md` or
 *   legacy `docs/design/*_commit.md`) → `docs/design/{reqBase}_Develop_Commit.md`
 *   (201 Phase 2: narrowed to the exact new-name path — no wildcard infix allowed;
 *   legacy name is read-compatible but never generated)
 * - review: review-report globs (new `Code_Review_*` / legacy `code_review_*`)
 *   → `docs/review/Code_Review_{reqBase}_Develop_Commit_*.md` (201 Phase 3)
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
    // 189 Phase 0 + 201 Phase 2: Narrow commit doc glob to the exact NEW path
    // (no wildcard infix). Any commit doc MUST be named
    // `{reqBase}_Develop_Commit.md` — legacy `{reqBase}_plan_commit.md` globs
    // are still DETECTED (dual read) but always narrowed to the new name.
    concreteGlob = resolveCommitDocPath(reqBase);
    return replaceGlobInRules(result, isCommitDocGlob, concreteGlob);
  }

  if (stage === "review") {
    // 201 Phase 3: Narrow review doc glob to requirementDoc basename with the
    // NEW naming prefix; legacy authored `code_review_*` globs count too and
    // are narrowed to the same new concrete glob (dual read).
    concreteGlob = `docs/review/Code_Review_${reqBase}_Develop_Commit_*.md`;
    return replaceGlobInRules(result, isReviewDocGlob, concreteGlob);
  }

  if (stage === "design-review") {
    // 192 Phase 3 (task 2): the design-review report path comes ONLY from the
    // narrowed meta state (canonical derivation for the current round). No
    // glob/mtime discovery — a different round/plan report can never be
    // selected implicitly. Without an active design-review state the rules
    // stay as authored (ordinary flows unaffected).
    const dr = meta.designReview;
    if (dr) {
      const reportPath = dr.reportDoc ?? deriveReportPath(dr.planDoc, dr.round);
      const rel = path.relative(config.projectRoot, reportPath);
      const concretes = replaceGlobInRules(result, (p) => /review-design-.*\.md$/.test(p) || p === rel, rel);
      // 192 Phase 3 (task 5, issue-2 fix): identity placeholders inside
      // design-review contract patterns are substituted from the SAME
      // authoritative meta state (never from tool args), so the groups
      // really enforce pipeline/plan/round/operation/input-hash binding.
      return substituteDesignReviewIdentityPlaceholders(concretes, dr);
    }
    return rules;
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

  // Phase 1 / 176: concrete glob replacement for the file-level path and
  // group rule-node paths (requiredFile nodes inherit rules.path).
  if (result.path && isMatch(result.path)) {
    result.path = concretePath;
  }

  if (result.groups) {
    result.groups = result.groups.map((group) => ({
      ...group,
      rules: group.rules.map((node) => (
        node.path && isMatch(node.path) ? { ...node, path: concretePath } : node
      )),
    }));
  }

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
 * Checks whether a path pattern matches the plan doc glob `docs/design/*_Plan.md`
 * (201 Phase 1 hard switch — legacy `_plan.md` no longer matches).
 */
export function isPlanDocGlob(pattern: string): boolean {
  return pattern === "docs/design/*_Plan.md" || pattern === "docs\\design\\*_Plan.md";
}

/**
 * Checks whether a path pattern matches a commit-doc glob (dual read, 201
 * Phase 2): the new `docs/design/*_Develop_Commit.md` and the legacy
 * `docs/design/*_commit.md` form both count, so naming drift in authored
 * verify rule sets still narrows to the single concrete deliverable path.
 * Used by applyConcreteStageDocPaths to narrow develop/fix globs.
 */
export function isCommitDocGlob(pattern: string): boolean {
  return (
    pattern === "docs/design/*_Develop_Commit.md" ||
    pattern === "docs\\design\\*_Develop_Commit.md" ||
    pattern === "docs/design/*_commit.md" ||
    pattern === "docs\\design\\*_commit.md"
  );
}

/**
 * Checks whether a path pattern matches a review-report glob (dual read, 201
 * Phase 3): the new `docs/review/Code_Review_*.md` and the legacy
 * `docs/review/code_review_*.md` forms both count, so authored verify rule
 * sets still narrow to the current review deliverable.
 * Used by applyConcreteStageDocPaths to narrow review globs.
 */
export function isReviewDocGlob(pattern: string): boolean {
  return (
    pattern === "docs/review/Code_Review_*.md" ||
    pattern === "docs\\review\\Code_Review_*.md" ||
    pattern === "docs/review/code_review_*.md" ||
    pattern === "docs\\review\\code_review_*.md"
  );
}

/**
 * 192 Phase 3 (task 5, issue-2 fix): substitute design-review identity
 * placeholders in verification patterns from the AUTHORITATIVE narrowed meta
 * state only (never tool args / overrides):
 *
 *   {planDoc}     → canonical absolute plan document path
 *   {round}       → current review round
 *   {operationId} → current operation id (when bound)
 *   {inputHash}   → operation inputHash, else the authorized planHash (when known)
 *
 * Pattern fields receive regex-escaped values (paths contain metacharacters);
 * plain path fields (requiredFiles / node path) receive raw values. A
 * placeholder whose value is unknown stays unresolved so the auto-verifier's
 * fail-closed guard turns it into an explicit verification failure instead of
 * a silently-literal non-match.
 */
export function substituteDesignReviewIdentityPlaceholders(
  rules: VerifyRules,
  dr: NonNullable<SessionMeta["designReview"]>,
): VerifyRules {
  const values: Record<string, string | undefined> = {
    planDoc: dr.planDoc,
    round: String(dr.round),
    operationId: dr.operation?.operationId,
    inputHash: dr.operation?.inputHash ?? dr.planHash,
  };

  /** Raw substitution for plain path strings. */
  const subRaw = (s: string): string => {
    let out = s;
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && value !== "") out = out.replaceAll(`{${key}}`, value);
    }
    return out;
  };
  /** Regex-escaped substitution for pattern strings. */
  const subPattern = (s: string): string => {
    let out = s;
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && value !== "") out = out.replaceAll(`{${key}}`, escapeRegExp(value));
    }
    return out;
  };

  const resolved: VerifyRules = { ...rules };

  if (resolved.requiredFiles) {
    resolved.requiredFiles = resolved.requiredFiles.map(subRaw);
  }
  if (resolved.fileContentPattern) {
    resolved.fileContentPattern = resolved.fileContentPattern.map((rule) => ({
      ...rule,
      path: subRaw(rule.path),
      pattern: subPattern(rule.pattern),
    }));
  }
  if (resolved.groups) {
    resolved.groups = resolved.groups.map((group) => ({
      ...group,
      when: group.when !== undefined ? subPattern(group.when) : group.when,
      rules: group.rules.map((node) => {
        const nextNode: VerifyGroupRuleNode = { ...node };
        if (node.path) nextNode.path = subRaw(node.path);
        if (node.patterns) nextNode.patterns = node.patterns.map(subPattern);
        return nextNode;
      }),
    }));
  }
  return resolved;
}
