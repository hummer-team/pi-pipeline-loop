/**
 * @module auto-pipeline/start-stage-evidence
 * 220 Phase 1/5 (D5): the evidence gate in front of every start stage.
 *
 * Facts:
 * - Paths are derived EXACTLY (`{dir}/{base}_Plan.md`, `{reqBase}_Develop_Commit.md`,
 *   `Code_Review_{reqBase}_Develop_Commit_*.md`). No glob fallback: binding a document
 *   to ANOTHER document's plan/commit/report is the failure this gate prevents.
 * - Read-only: the module never writes, never freezes and never advances. The
 *   caller (`pipeline-auto`) turns a missing evidence into `handleDocFailure`.
 * - The review verdict is read through `loadVerifyContractAnchors(config,
 *   "review").anchors.verdict`, so no new verdict regex exists here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineConfig, PipelineStage, SessionMeta } from "../../types";
import { planDocHasConfirmMarker, resolveCommitDocPath } from "../verify-path-resolver";
import { loadVerifyContractAnchors } from "../../utils/contract-loader";
import { docsDirsOf } from "../../docs-paths";

/** What the start stage was verified against. */
export type StartStageBasis = "requirement" | "plan" | "plan-confirmed" | "commit" | "review-report";

/** Result of the evidence gate. */
export type StartStageEvidence =
  | { ok: true; basis: StartStageBasis }
  | { ok: false; missing: "requirement" | "plan" | "plan-confirmed" | "commit" | "review-verdict" };

/** Upper bound of the review-report directory scan. */
const MAX_REVIEW_FILES = 200;

/** TRUE when the path exists and is a regular file. */
async function isFile(absPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(absPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/** Base name of the requirement document (`docs/design/200_Feat.md` → `200_Feat`). */
function requirementBase(requirementDoc: string): string {
  return path.basename(requirementDoc, ".md");
}

/**
 * Exact plan path of a requirement document: `{dir}/{base}_Plan.md`.
 * The `_Plan` suffix is never duplicated (`200_Feat_Plan.md` stays itself).
 */
export function derivePlanDocPath(requirementDoc: string): string {
  const dir = path.dirname(requirementDoc);
  const base = requirementBase(requirementDoc);
  const planBase = base.endsWith("_Plan") ? base : `${base}_Plan`;
  return path.join(dir, `${planBase}.md`);
}

/** Latest review report of one requirement document, or `null`. */
async function findLatestReviewReport(
  projectRoot: string,
  reviewDir: string,
  reqBase: string,
): Promise<string | null> {
  const dir = path.isAbsolute(reviewDir) ? reviewDir : path.join(projectRoot, reviewDir);
  const prefix = `Code_Review_${reqBase}_Develop_Commit_`;
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return null;
  }
  let latest: string | null = null;
  let latestMtime = 0;
  for (const entry of entries.slice(0, MAX_REVIEW_FILES)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".md")) continue;
    const abs = path.join(dir, entry);
    try {
      const stat = await fs.promises.stat(abs);
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latest = abs;
      }
    } catch {
      // Unreadable candidate: skip, the next one may still be usable.
    }
  }
  return latest;
}

/** TRUE when the report declares FAIL through the deployed anchor (unmatched or
 * contract-unavailable reports fall through; `To-Fix` is the second source). */
async function reportDeclaresFail(config: PipelineConfig, body: string): Promise<boolean> {
  const { anchors } = await loadVerifyContractAnchors(config, "review");
  for (const pattern of anchors.verdict?.patterns ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "m");
    } catch {
      continue; // Invalid deployed pattern: not evidence of a verdict.
    }
    const match = re.exec(body);
    const value = match?.[1];
    if (value && /fail|不通过/i.test(value)) return true;
  }
  return false;
}

/** TRUE when the report carries the fixable-issues marker (both hyphen shapes). */
function reportMentionsToFix(body: string): boolean {
  return body.includes("To-Fix") || body.includes("To\u2011Fix") || body.includes("待修复");
}

/**
 * Verify that the requested start stage has its evidence on disk.
 *
 * @returns the basis when present; otherwise the FIRST missing evidence kind
 *   (stable order: requirement → plan → plan-confirmed → commit → review).
 */
export async function checkStartStageEvidence(input: {
  config: PipelineConfig;
  meta: Pick<SessionMeta, "requirementDoc">;
  startStage: PipelineStage;
  projectRoot: string;
}): Promise<StartStageEvidence> {
  const { config, meta, startStage, projectRoot } = input;
  const requirementDoc = meta.requirementDoc;
  if (!requirementDoc) return { ok: false, missing: "requirement" };

  const requirementAbs = path.resolve(projectRoot, requirementDoc);
  const planAbs = path.resolve(projectRoot, derivePlanDocPath(requirementDoc));

  switch (startStage) {
    case "clarify":
    case "plan": {
      return (await isFile(requirementAbs))
        ? { ok: true, basis: "requirement" }
        : { ok: false, missing: "requirement" };
    }
    case "design-review": {
      return (await isFile(planAbs)) ? { ok: true, basis: "plan" } : { ok: false, missing: "plan" };
    }
    case "develop": {
      // Two distinguishable failures (D5): no plan at all vs. a plan that was
      // never confirmed. The reviewer/operator sees the kind in the reason.
      if (!(await isFile(planAbs))) return { ok: false, missing: "plan" };
      return (await planDocHasConfirmMarker(planAbs))
        ? { ok: true, basis: "plan-confirmed" }
        : { ok: false, missing: "plan-confirmed" };
    }
    case "review": {
      const dirs = docsDirsOf(config);
      const commitAbs = path.resolve(
        projectRoot,
        resolveCommitDocPath(requirementBase(requirementDoc), dirs.designDir),
      );
      return (await isFile(commitAbs)) ? { ok: true, basis: "commit" } : { ok: false, missing: "commit" };
    }
    case "fix": {
      const reportAbs = await findLatestReviewReport(
        projectRoot,
        docsDirsOf(config).reviewDir,
        requirementBase(requirementDoc),
      );
      if (!reportAbs) return { ok: false, missing: "review-verdict" };
      let body: string;
      try {
        body = await fs.promises.readFile(reportAbs, "utf8");
      } catch {
        return { ok: false, missing: "review-verdict" };
      }
      const fixable = (await reportDeclaresFail(config, body)) || reportMentionsToFix(body);
      return fixable ? { ok: true, basis: "review-report" } : { ok: false, missing: "review-verdict" };
    }
    default: {
      // A stage without evidence rules cannot be started by the auto runner.
      return { ok: false, missing: "requirement" };
    }
  }
}
