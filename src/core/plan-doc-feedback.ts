/**
 * @module plan-doc-feedback
 * 204 Phase 3: actionable corrective feedback for a failed PLAN document check.
 *
 * Read-only renderer: it never writes meta, dispatches a subagent or touches the
 * verify budget. Mirrors the `buildDesignReviewReportFeedback()` corrective
 * pattern — the model gets the EXACT expected path plus the non-conforming
 * candidates already on disk, so one round is enough to fix the file name.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { PipelineConfig, PipelineStage, SessionMeta, VerifyFailureItem } from "../types";
import { planDocRelPathFromRequirementDoc } from "./naming/doc-naming";

export interface PlanDocFeedback {
  /** Expected plan doc path, relative to the project root. */
  planDoc: string;
  /** Non-conforming plan-like files found in the target directory (relative paths). */
  candidates: string[];
  /** Actionable, line-oriented corrective message for the model. */
  message: string;
}

/**
 * Rule types that indicate a plan-document FORMAT defect.
 *
 * `requiredFile` (group-verifier) and `requiredFiles` (auto-verifier) are BOTH
 * accepted because the two engines spell the same check differently; matching
 * only one would silently skip the exact `Missing files: ...` case that starts
 * this loop. Group names are intentionally NOT used — they come from the
 * configurable `verify.md`.
 */
const PLAN_FORMAT_RULE_TYPES = new Set(["requiredFile", "requiredFiles", "fileContentPattern"]);

/** Directory entries inspected before filtering (bounded read). */
const MAX_DIR_ENTRIES = 200;
/** Candidates surfaced to the model. */
const MAX_CANDIDATES = 5;

const STRUCTURE_REQUIREMENT =
  "The document MUST contain the six sections Summary / Phase {x} / Task List / Acceptance Criteria / " +
  "Unit Tests Core / Commit Specification, and MUST end with a `## 用户确认` (or `## User Confirmation`) section.";

/**
 * Builds plan-doc corrective feedback, or `null` when this is not a plan-stage
 * format failure (caller then keeps its ordinary text).
 */
export async function buildPlanDocFeedback(opts: {
  config?: PipelineConfig;
  meta?: SessionMeta;
  stageName: PipelineStage;
  failures?: readonly VerifyFailureItem[];
}): Promise<PlanDocFeedback | null> {
  // Degrade to the pre-204 behavior on any missing input — never throw.
  if (!opts.config || !opts.meta) return null;
  if (opts.stageName !== "plan") return null;
  const reqDoc = opts.meta.requirementDoc;
  if (!reqDoc) return null;
  if (!opts.failures?.some((f) => PLAN_FORMAT_RULE_TYPES.has(f.ruleType))) return null;

  const planDoc = planDocRelPathFromRequirementDoc(reqDoc);
  const relDir = path.posix.dirname(planDoc);
  const dir = relDir === "." ? "" : relDir;
  const candidates = await listPlanLikeCandidates(opts.config.projectRoot, dir, path.posix.basename(planDoc));

  const message = [
    `Plan doc verification failed for "${opts.stageName}" — the deliverable is a FORMAT problem, the stage must not advance.`,
    `Expected EXACTLY: ${planDoc}`,
    candidates.length > 0
      ? `Found non-conforming candidate(s): ${candidates.join(", ")}`
      : `No plan-like document found in ${dir || "."}.`,
    `Fix in place: create or rename the file to the expected path (keep the existing content), then re-run pipeline_verify. Do not create a second plan document and do not invent another name.`,
    STRUCTURE_REQUIREMENT,
  ].join("\n");

  return { planDoc, candidates, message };
}

/**
 * Non-recursive scan of the plan doc's directory for `.md` files whose name
 * mentions "plan" but is NOT the expected name. Unreadable/missing directory
 * fails open to an empty list.
 */
async function listPlanLikeCandidates(
  projectRoot: string,
  relDir: string,
  expectedName: string,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.resolve(projectRoot, relDir));
  } catch {
    return [];
  }

  return entries
    .slice(0, MAX_DIR_ENTRIES)
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .filter((name) => name.toLowerCase().includes("plan"))
    .filter((name) => name !== expectedName)
    // Explicit comparator: deterministic UTF-16 code-unit order, locale-independent.
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_CANDIDATES)
    .map((name) => (relDir ? `${relDir}/${name}` : name));
}
