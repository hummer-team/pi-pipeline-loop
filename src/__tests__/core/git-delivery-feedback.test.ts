/**
 * 225 Phase 1: git-delivery corrective feedback builder.
 *
 * Contract points:
 * - Triggers ONLY on failures whose `group` is `commit_proof` (or `git_invariant`,
 *   Phase 5) AND whose ruleType is a known delivery defect.
 * - `commit_exists` gets the conclusion + the exact two-step REAL-id correction.
 * - `plan_doc_mismatch` / `commit_after_stage_start` get one-line corrections.
 * - Unrelated failures, or missing config/meta, never throw and return null.
 */

import { describe, it, expect } from "bun:test";
import { buildGitDeliveryFeedback } from "../../core/git-delivery-feedback";
import { COMMIT_PROOF_GROUP } from "../../core/commit-proof";
import { makeTestConfig, makeTestMeta } from "../helpers";
import type { VerifyFailureItem } from "../../types";

function failure(ruleType: string, detail: string, group = COMMIT_PROOF_GROUP): VerifyFailureItem {
  return { ruleType, detail, group, timestamp: Date.now() };
}

const META = makeTestMeta({
  currentStage: "fix",
  requirementDoc: "docs/design/210_Feat.md",
});

describe("buildGitDeliveryFeedback", () => {
  it("commit_exists → two-step real-id correction", () => {
    const result = buildGitDeliveryFeedback({
      config: makeTestConfig(),
      meta: META,
      stageName: "fix",
      failures: [failure("commit_exists", 'declared commit id "dead0001" is not a well-formed git revision')],
    });
    expect(result).not.toBeNull();
    expect(result!.message).toContain('Commit evidence invalid: declared id "dead0001" does not exist in this repository.');
    expect(result!.message).toContain("1) Run `git rev-parse HEAD`");
    expect(result!.message).toContain("2) Write that exact value into `**dev commit id**` of docs/design/210_Feat_Develop_Commit.md");
    expect(result!.message).toContain("Never register an id that git did not print.");
    expect(result!.ruleTypes).toEqual(["commit_exists"]);
  });

  it("plan_doc_mismatch → single-line correction to the expected plan doc", () => {
    const result = buildGitDeliveryFeedback({
      config: makeTestConfig(),
      meta: META,
      stageName: "fix",
      failures: [failure("plan_doc_mismatch", 'commit doc "**plan doc**" declares "docs/design/999_Other_Plan.md", expected "docs/design/210_Feat_Plan.md"')],
    });
    expect(result).not.toBeNull();
    expect(result!.message).toContain("docs/design/210_Feat_Plan.md");
    expect(result!.message).toContain("**plan doc**");
  });

  it("commit_after_stage_start → single-line baseline correction", () => {
    const result = buildGitDeliveryFeedback({
      config: makeTestConfig(),
      meta: META,
      stageName: "fix",
      failures: [failure("commit_after_stage_start", "commit dead0001 was created ... BEFORE ...")],
    });
    expect(result).not.toBeNull();
    expect(result!.message).toContain("Commit too old");
    expect(result!.message).toContain("Re-run `git commit`");
  });

  it("no git delivery failure → null (caller keeps the ordinary message)", () => {
    expect(
      buildGitDeliveryFeedback({
        config: makeTestConfig(),
        meta: META,
        stageName: "fix",
        failures: [failure("requiredFiles", "Missing files: docs/design/210_Feat_Plan.md", "plan_doc")],
      }),
    ).toBeNull();
  });

  it("right ruleType but foreign group → null (group is the trigger, not prose)", () => {
    expect(
      buildGitDeliveryFeedback({
        config: makeTestConfig(),
        meta: META,
        stageName: "fix",
        failures: [failure("commit_exists", 'declared commit id "dead0001"', "unrelated_group")],
      }),
    ).toBeNull();
  });

  it("missing/undefined failures → null, never throws", () => {
    expect(buildGitDeliveryFeedback({ stageName: "fix" })).toBeNull();
    expect(buildGitDeliveryFeedback({ config: undefined, meta: undefined, stageName: "fix", failures: [] })).toBeNull();
  });

  it("missing meta falls back without throwing (expectedDoc is derived from reqBase='')", () => {
    const result = buildGitDeliveryFeedback({
      stageName: "fix",
      failures: [failure("commit_exists", 'declared commit id "dead0001" something')],
    });
    expect(result).not.toBeNull();
    expect(result!.message).toContain('declared id "dead0001"');
  });
});

// ─── 225 Phase 5 (T5): git_invariant corrective branches ─────────────────────

describe("buildGitDeliveryFeedback — git_invariant ruleTypes (Phase 5)", () => {
  it("branch_drift → switch-back correction", () => {
    const result = buildGitDeliveryFeedback({
      config: makeTestConfig(),
      meta: META,
      stageName: "fix",
      failures: [failure("branch_drift", "expected branch 'fix/a', found 'fix/b'", "git_invariant")],
    });
    expect(result).not.toBeNull();
    expect(result!.message).toContain("expected branch 'fix/a', found 'fix/b'");
    expect(result!.message).toContain("Switch back to the recorded branch");
    expect(result!.message).toContain("re-run the commit");
  });

  it("stash_hidden → stash pop correction", () => {
    const result = buildGitDeliveryFeedback({
      config: makeTestConfig(),
      meta: META,
      stageName: "fix",
      failures: [failure("stash_hidden", "work was stashed during this stage: stash entries 0 → 2", "git_invariant")],
    });
    expect(result).not.toBeNull();
    expect(result!.message).toContain("work was stashed during this stage");
    expect(result!.message).toContain("Run `git stash pop`");
  });
});
