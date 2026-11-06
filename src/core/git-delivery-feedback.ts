/**
 * @module git-delivery-feedback
 * 225 Phase 1 (T3/Q2-A): actionable corrective feedback when the declared
 * commit evidence is invalid (or, in Phase 5, when a git invariant broke).
 *
 * Read-only renderer in the `plan-doc-feedback.ts` pattern: it never writes
 * meta, dispatches a subagent or touches the verify budget. The model gets
 * the conclusion FIRST and then the exact two steps to produce the real id,
 * so one round suffices and hallucinated ids stop costing retries.
 */

import type { PipelineConfig, PipelineStage, SessionMeta, VerifyFailureItem } from "../types";
import { COMMIT_PROOF_GROUP, COMMIT_TIME_TOLERANCE_MS } from "./commit-proof";
import { resolveCommitDocPath } from "./verify-path-resolver";
import { planDocRelPathFromRequirementDoc, reqBaseFromRequirementDoc } from "./naming/doc-naming";

export interface GitDeliveryFeedback {
  /** Actionable, line-oriented corrective message for the model. */
  message: string;
  /** Commit document the corrective copy points at (`**dev commit id**` line). */
  expectedDoc: string;
  /** Normative rule types that triggered this feedback. */
  ruleTypes: string[];
}

/**
 * Rule types that indicate an invalid commit-evidence delivery:
 * - `commit_exists`: the declared id is not a real commit in this repository.
 * - `plan_doc_mismatch`: the commit doc binds to a foreign plan document.
 * - `commit_after_stage_start`: the commit predates the allowed time baseline
 *   (the requirement's ledger called this `commit_too_old`, historically).
 */
const GIT_DELIVERY_RULE_TYPES = new Set(["commit_exists", "plan_doc_mismatch", "commit_after_stage_start"]);

/**
 * Builds corrective feedback for git delivery failures, or `null` when none of
 * the failures is a git delivery defect (caller keeps its ordinary text).
 *
 * Trigger condition comes from the failure `group` (never prose matching):
 * `commit_proof` (commit-proof reconciliation, 225 Phase 1) or `git_invariant`
 * (branch / stash baselines, 225 Phase 5 — branches are added as they land).
 */
export function buildGitDeliveryFeedback(opts: {
  config?: PipelineConfig;
  meta?: SessionMeta;
  stageName: PipelineStage;
  failures?: readonly VerifyFailureItem[];
}): GitDeliveryFeedback | null {
  const { meta, stageName, failures } = opts;
  if (!failures || failures.length === 0) return null;

  const relevant = failures.filter(
    (f) =>
      (f.group === COMMIT_PROOF_GROUP || f.group === "git_invariant") &&
      GIT_DELIVERY_RULE_TYPES.has(f.ruleType),
  );
  if (relevant.length === 0) return null;

  const expectedDoc = resolveCommitDocPath(reqBaseFromRequirementDoc(meta?.requirementDoc ?? "") || "");
  const ruleTypes = [...new Set(relevant.map((f) => f.ruleType))];

  // The plan-doc mismatch correction resolves again for its own message
  // (expected value, not the commit doc the ids live in).
  const expectedPlanDoc = meta?.requirementDoc
    ? planDocRelPathFromRequirementDoc(meta.requirementDoc)
    : "(unresolvable — requirementDoc missing)";

  const commitExists = relevant.find((f) => f.ruleType === "commit_exists");
  const planMismatch = relevant.find((f) => f.ruleType === "plan_doc_mismatch");
  const commitTooOld = relevant.find((f) => f.ruleType === "commit_after_stage_start");

  const lines: string[] = [];
  if (commitExists) {
    lines.push(gitExistsMessage(commitExists.detail, expectedDoc));
  }
  if (planMismatch) {
    lines.push(
      `Commit doc binding invalid: the commit doc's "**plan doc**" line does not name this run's plan document. ` +
        `Change it to the exact relative path \`${expectedPlanDoc}\`.`,
    );
  }
  if (commitTooOld) {
    lines.push(
      `Commit too old: commits must be at most ${COMMIT_TIME_TOLERANCE_MS / 1000}s older than the run's stage-start clock baseline. ` +
        `Re-run \`git commit\` for the pending work now — never re-register an old id.`,
    );
  }

  return { message: lines.join("\n"), expectedDoc, ruleTypes };
}

/** Exact two-step correction for a hallucinated commit id (plan T3 copy). */
function gitExistsMessage(detail: string, expectedDoc: string): string {
  // Detail format: `declared commit id "<id>" ...` (commit-proof.ts C1).
  const match = /declared commit id "([^"]+)"/.exec(detail);
  const allegedId = match ? match[1] : "<declared id>";
  return [
    `Commit evidence invalid: declared id "${allegedId}" does not exist in this repository.`,
    `1) Run \`git rev-parse HEAD\` (or \`git log -1 --format=%H\`) to get the REAL id.`,
    `2) Write that exact value into \`**dev commit id**\` of ${expectedDoc} and into \`generate_stage_summary\`'s commitIds.`,
    `Never register an id that git did not print.`,
  ].join("\n");
}
