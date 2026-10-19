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
import { safeWriteAuditLog } from "../utils/auditLog";
import { planDocRelPathFromRequirementDoc, reqBaseFromRequirementDoc } from "./naming/doc-naming";

export interface PlanDocFeedback {
  /** Expected plan doc path, relative to the project root. */
  planDoc: string;
  /**
   * Non-conforming plan-like files found in the target directory.
   * Paths are relative to the PROJECT ROOT (same base as `planDoc`).
   * This requirement's near-name candidates come first; other requirements'
   * plan docs follow and are labelled separately in `message`.
   *
   * This requirement's OWN non-plan artifacts are NOT candidates: they are
   * excluded here and reported on the `message` "KEEP" line instead — both are
   * non-regenerable pipeline inputs, and renaming either onto the plan-doc path
   * silently destroys it:
   * - the requirement doc (`{reqBase}.md`, `meta.requirementDoc`) — moving it
   *   desynchronises every later stage (plan/develop/review resolves the
   *   requirement by that exact path);
   * - the plan-stage commit doc (`{reqBase}_plan_commit*.md`) — it records the
   *   dev/fix commit ids.
   */
  candidates: string[];
  /**
   * `true` when the directory could not be read for a reason OTHER than
   * "not created yet" (e.g. `EACCES`). `message` then reports the directory as
   * unreadable instead of the factually wrong "No plan-like document found".
   */
  scanFailed: boolean;
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

/** Candidates surfaced to the model. */
const MAX_CANDIDATES = 5;

/**
 * A plan doc that clearly belongs to SOME requirement
 * (`{index}_{name}_Plan.md` / `{index}_{name}_Plan_commit.md`). Such a candidate
 * is "foreign" only when it does not belong to this requirement's `reqBase`
 * family (see `belongsToReqFamily()`). Case-insensitive because plan-doc casing
 * is inconsistent on disk (`_plan.md` / `_Plan.md` are both in use).
 */
const INDEXED_PLAN_DOC = /^\d+_.+_plan(?:_commit)?\.md$/i;

const STRUCTURE_REQUIREMENT =
  "The document MUST contain the six sections Summary / Phase {x} / Task List / Acceptance Criteria / " +
  "Unit Tests Core / Commit Specification, and MUST end with a `## 用户确认` (or `## User Confirmation`) section.";

/**
 * Builds plan-doc corrective feedback, or `null` when this is not a plan-stage
 * format failure (caller then keeps its ordinary text).
 *
 * Invariant: this can only fire for `stageName === "plan"`, while
 * `buildDesignReviewReportFeedback()` can only fire for the design-review
 * stages. The two corrective messages are therefore mutually exclusive by
 * stage, and the `reportFeedback?.message ?? planFeedback?.message` precedence
 * in `applyVerifyFail()` is structurally unconstructible as a both-present case
 * (no test can drive it; the stage gate is the contract).
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
  const reqBase = reqBaseFromRequirementDoc(reqDoc);
  const scan = await scanPlanLikeCandidates({
    projectRoot: opts.config.projectRoot,
    relDir: dir,
    expectedName: path.posix.basename(planDoc),
    reqBase,
    // The requirement doc's OWN file name keeps it out of the rename
    // candidates: a requirement title that itself contains "plan"
    // (`208_Replan.md`) satisfies the candidate filter and ranks 0.
    reqDocName: path.posix.basename(String(reqDoc).replace(/\\/g, "/")),
  });
  const candidates = scan.candidates;

  // Other requirements' plan docs must never be renamed or overwritten — the
  // corrective instruction is scoped to THIS requirement only.
  const foreign = candidates.filter((rel) => isForeignPlanDoc(rel, reqBase));

  const candidateLine = describeCandidates(
    candidates,
    scan.scanFailed,
    dir,
    scan.ownArtifacts.length,
  );

  const message = [
    `Plan doc verification failed for "${opts.stageName}" — the deliverable is a FORMAT problem, the stage must not advance.`,
    `Expected EXACTLY: ${planDoc}`,
    candidateLine,
    ...(foreign.length > 0
      ? [`These belong to OTHER requirement(s) — never rename, move or overwrite them: ${foreign.join(", ")}`]
      : []),
    ...(scan.ownArtifacts.length > 0
      ? [
        `This requirement's OWN non-plan artifact(s) are NOT the plan doc — KEEP them, never rename, move or overwrite to ${planDoc}: ${scan.ownArtifacts.map((a) => `${a.rel} (${OWN_ARTIFACT_REASON[a.kind]})`).join("; ")}`,
      ]
      : []),
    `Fix in place: create or rename the file to the expected path (keep the existing content), then re-run pipeline_verify. Do not create a second plan document and do not invent another name.`,
    STRUCTURE_REQUIREMENT,
  ].join("\n");

  return { planDoc, candidates, scanFailed: scan.scanFailed, message };
}

/**
 * One line telling the model what is actually on disk. Three distinct states —
 * candidates found, directory unreadable, directory empty — because reporting
 * "no plan-like document" for an unreadable directory sends the model to
 * CREATE a file instead of investigating the directory.
 */
function describeCandidates(
  candidates: readonly string[],
  scanFailed: boolean,
  dir: string,
  ownArtifactCount: number,
): string {
  const where = dir || ".";
  if (candidates.length > 0) return `Found non-conforming candidate(s): ${candidates.join(", ")}`;
  if (scanFailed) {
    return `Directory ${where} is UNREADABLE (scan failed, see audit \`plan_doc_feedback_scan_failed\`) — inspect the directory itself before creating any file.`;
  }
  // An empty candidate list alongside own artifacts on disk is NOT the same
  // state as an empty directory: never let the model read the requirement doc
  // as "the only plan-like file" and move it onto the plan path.
  if (ownArtifactCount > 0) {
    return `No plan-like document found in ${where} (only this requirement's OWN non-plan artifacts are present — see the KEEP line below).`;
  }
  return `No plan-like document found in ${where}.`;
}

/**
 * The kinds of THIS requirement's own deliverables that are NOT the plan doc
 * and must never be renamed onto it.
 */
type OwnArtifactKind = "requirement-doc" | "commit-doc";

/** One own non-plan artifact found on disk. */
interface OwnArtifact {
  /** Path relative to the PROJECT ROOT (same base as `planDoc`). */
  rel: string;
  kind: OwnArtifactKind;
}

/** Why each own artifact must be kept — rendered into the single KEEP line. */
const OWN_ARTIFACT_REASON: Record<OwnArtifactKind, string> = {
  "requirement-doc": "the requirement input every later stage resolves by this exact path",
  "commit-doc": "it records the commit ids",
};

/**
 * `true` when `name` is THIS requirement's own requirement doc
 * (`{reqBase}.md` === `meta.requirementDoc`, case-insensitive).
 *
 * A requirement title may itself contain "plan" (`208_Replan.md`), which makes it
 * satisfy the "name mentions 'plan' but is not the expected name" candidate
 * filter and rank 0 as `reqBase` family — the FIRST file the corrective message
 * would tell the model to rename. Moving it silently breaks the pipeline's only
 * input: `meta.requirementDoc`, every later stage's requirement resolution and
 * `planDocRelPathFromRequirementDoc()` would all point at a missing file.
 */
function isOwnRequirementDoc(name: string, reqDocName: string): boolean {
  if (!reqDocName) return false;
  return name.toLowerCase() === reqDocName.toLowerCase();
}

/**
 * `true` when `name` is THIS requirement's own plan-stage commit doc
 * (`{reqBase}_plan_commit.md`, case-insensitive) — the Phase-1 deliverable that
 * records the dev/fix commit ids.
 *
 * It matches the "name contains 'plan' and is not the expected name" candidate
 * filter, so without this predicate the corrective message points
 * `Fix in place: rename the file to the expected path` straight at it and the
 * model renames away a non-regenerable artifact.
 */
function isOwnPlanCommitDoc(name: string, reqBase: string): boolean {
  if (!reqBase) return false;
  const stem = name.replace(/\.md$/i, "").toLowerCase();
  return stem.startsWith(`${reqBase.toLowerCase()}_plan_commit`);
}

/**
 * Predicate SET for "is `name` one of THIS requirement's OWN non-plan
 * deliverables?". Lives at the SAME layer as `isOwnPlanCommitDoc()` /
 * `belongsToReqFamily()` so a new member is added HERE rather than as another
 * ad-hoc filter at the scan call site (that is exactly how the requirement-doc
 * member went missing in review round 3).
 *
 * Returns the artifact kind (so the KEEP line can carry a per-item reason), or
 * `null` when the file is an ordinary rename candidate.
 */
function ownNonPlanArtifactKind(
  name: string,
  reqBase: string,
  reqDocName: string,
): OwnArtifactKind | null {
  if (isOwnRequirementDoc(name, reqDocName)) return "requirement-doc";
  if (isOwnPlanCommitDoc(name, reqBase)) return "commit-doc";
  return null;
}

/**
 * A candidate is "foreign" when it is an indexed plan doc that does not mention
 * this requirement's `reqBase` (e.g. `201_Feat_plan.md` while verifying
 * `204_Bug`). An empty `reqBase` disables the classification.
 */
function isForeignPlanDoc(relPath: string, reqBase: string): boolean {
  if (!reqBase) return false;
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  return !belongsToReqFamily(name, reqBase) && INDEXED_PLAN_DOC.test(name);
}

/**
 * Single source of truth for "is this file name THIS requirement's own plan-doc
 * family?" — shared by the off-limits classification and the ranking so the two
 * can never disagree (labelling a file foreign while ranking it as our own would
 * ask the model to rename a file it is simultaneously forbidden to touch).
 *
 * Two properties the bare `name.includes(reqBase)` substring test lacked:
 * - **Case-insensitive**: `204_bug_Plan.md` IS this requirement's own doc for
 *   `reqBase === "204_Bug"` (the repo mixes `_plan.md` / `_Plan.md`).
 * - **Anchored at a separator**: `1204_Bugfix_Plan.md` is NOT ours — a bare
 *   substring test would swallow it as "contains 204_Bug" and silently drop its
 *   off-limits label, exposing another requirement's document to a rename.
 *
 * Accepts a bare file name (path components are stripped by the caller).
 */
function belongsToReqFamily(name: string, reqBase: string): boolean {
  if (!reqBase) return false;
  const stem = name.replace(/\.md$/i, "").toLowerCase();
  const base = reqBase.toLowerCase();
  return stem === base || stem.startsWith(`${base}_`);
}

/**
 * Non-recursive scan of the plan doc's directory for `.md` files whose name
 * mentions "plan" but is NOT the expected name.
 *
 * Fail-open by contract, but never silently: a directory that cannot be read
 * for any reason other than "not created yet" (`ENOENT`) is audited and
 * reported through `scanFailed`, so the caller cannot emit the factually wrong
 * "No plan-like document found".
 */
async function scanPlanLikeCandidates(opts: {
  projectRoot: string;
  relDir: string;
  expectedName: string;
  reqBase: string;
  /** `path.posix.basename(meta.requirementDoc)` — never a rename candidate. */
  reqDocName: string;
}): Promise<{ candidates: string[]; ownArtifacts: OwnArtifact[]; scanFailed: boolean }> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.resolve(opts.projectRoot, opts.relDir));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // A directory that does not exist yet is the ordinary "plan doc not written
    // yet" state — no candidates, no log noise.
    if (code === "ENOENT") return { candidates: [], ownArtifacts: [], scanFailed: false };
    await safeWriteAuditLog("plan_doc_feedback_scan_failed", {
      projectRoot: opts.projectRoot,
      relDir: opts.relDir || ".",
      code: code ?? "unknown",
      error: err instanceof Error ? err.message : String(err),
      stack: (err instanceof Error ? (err.stack ?? "") : "").slice(0, 500),
    }, "warn");
    return { candidates: [], ownArtifacts: [], scanFailed: true };
  }

  const toRel = (name: string): string => (opts.relDir ? `${opts.relDir}/${name}` : name);

  const planLike = entries
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .filter((name) => name.toLowerCase().includes("plan"))
    .filter((name) => name !== opts.expectedName);

  // This requirement's OWN non-plan artifacts are split out BEFORE ranking: as
  // `reqBase` family they would rank 0, i.e. exactly the files the model would
  // rename to the expected plan path. One predicate set
  // (`ownNonPlanArtifactKind`) drives both this split and the exclusion below,
  // so the KEEP line and the candidate list can never disagree.
  const ownArtifacts: OwnArtifact[] = planLike
    .map((name) => ({ name, kind: ownNonPlanArtifactKind(name, opts.reqBase, opts.reqDocName) }))
    .filter((entry): entry is { name: string; kind: OwnArtifactKind } => entry.kind !== null)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => ({ rel: toRel(entry.name), kind: entry.kind }));

  // Rank the remaining candidates: this requirement's family first (a wrongly
  // named 204 doc is the real fix target), then near-name docs, then other
  // requirements' plan docs.
  const rank = (name: string): number => {
    if (belongsToReqFamily(name, opts.reqBase)) return 0;
    return INDEXED_PLAN_DOC.test(name) ? 2 : 1;
  };

  const candidates = planLike
    .filter((name) => ownNonPlanArtifactKind(name, opts.reqBase, opts.reqDocName) === null)
    // Sort BEFORE capping so the visible set never depends on the filesystem's
    // enumeration order. Explicit comparator: deterministic UTF-16 code-unit
    // order, locale-independent.
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_CANDIDATES)
    .map(toRel);

  return { candidates, ownArtifacts, scanFailed: false };
}
