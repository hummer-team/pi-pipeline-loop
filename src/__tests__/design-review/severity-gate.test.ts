/**
 * 229 Phase 1 (F1): the blocking-set severity gate.
 *
 * Boundaries covered (plan Phase 1 "单元测试目标，边界"):
 * - `None` + PASS ⇒ pass; `None` + one Medium ⇒ pass (the second entry is
 *   validated as Medium — sentinel-first, 问题 11);
 * - 4 Medium + PASS ⇒ pass AND 4 issues, each with a stable id `DR-2-n`;
 * - Blocker + Evidence ⇒ fail; Blocker WITHOUT evidence ⇒ invalid;
 *   missing / unknown severity ⇒ invalid (fail-closed, 两轨一致);
 * - EMPTY Issues body + PASS ⇒ invalid; FAIL conclusion with no entries ⇒ fail;
 * - `severityGate: false` restores the pre-229 verdict rule verbatim;
 * - ID打通: the verifier's `issues` carry the report's stable ids
 *   (`DR-2-1` ⇒ `verifiedIssues[0].issueId === "DR-2-1"`), and the
 *   coordinator's legacy fallback maps by round order (pure function level).
 */

import { describe, expect, it } from "bun:test";
import { verifyDesignReviewReportSnapshot } from "../../core/verifiers/design-review-verifier";

const HID = "a".repeat(64);
const OP = "op-sev-gate-1";

function expectation(overrides: Partial<Parameters<typeof verifyDesignReviewReportSnapshot>[1]> = {}) {
  return {
    pipelineId: "pipe-sev-gate",
    planDoc: "/abs/sev-gate-plan.md",
    round: 2,
    operationId: OP,
    inputHash: HID,
    ...overrides,
  };
}

function report(verdictRow: string, verdictBody: string[]): string {
  return [
    "# Design Review Report",
    "",
    "**pipeline**: pipe-sev-gate",
    "**plan**: /abs/sev-gate-plan.md",
    "**round**: 2",
    `**operation**: ${OP}`,
    `**input hash**: ${HID}`,
    "",
    "## Summary",
    "",
    "Reviewed the plan against the requirement document.",
    "",
    "## Verdict",
    "",
    verdictRow,
    "",
    "## Issues",
    "",
    ...verdictBody,
    "",
    "## Recommendations",
    "",
    "Keep the per-phase acceptance criteria as the regression checklist.",
    "",
  ].join("\n");
}

const ROWS_4_MEDIUM = [
  "| ID | Severity | Evidence | Summary |",
  "| --- | --- | --- | --- |",
  "| DR-2-1 | Medium | | nit one |",
  "| DR-2-2 | Medium | | nit two |",
  "| DR-2-3 | Medium | | nit three |",
  "| DR-2-4 | Medium | | nit four |",
];

describe("229 Phase 1: blocking-set severity gate (F1)", () => {
  it("None + PASS ⇒ pass", () => {
    const v = verifyDesignReviewReportSnapshot(report("**Design Review: PASS**", ["None"]), expectation());
    expect(v.verdict).toBe("pass");
    expect(v.verdict === "pass" && v.issues).toEqual([]);
  });

  it("None + one Medium ⇒ pass (the sentinel is stripped BEFORE records, 问题 11)", () => {
    const v = verifyDesignReviewReportSnapshot(
      report("**Design Review: PASS**", ["None", "| ID | Severity | Evidence | Summary |", "| --- | --- | --- | --- |", "| DR-2-1 | Medium | | wording nit |"]),
      expectation(),
    );
    expect(v.verdict).toBe("pass");
    expect(v.verdict === "pass" && v.issues.length).toBe(1);
  });

  it("4 Medium + PASS ⇒ pass with all four issues carrying stable ids (the ONLY relaxation)", () => {
    const v = verifyDesignReviewReportSnapshot(report("**Design Review: PASS**", ROWS_4_MEDIUM), expectation());
    expect(v.verdict).toBe("pass");
    if (v.verdict === "pass") {
      expect(v.issues.map((i) => i.issueId)).toEqual(["DR-2-1", "DR-2-2", "DR-2-3", "DR-2-4"]);
    }
  });

  it("Blocker + evidence ⇒ fail (blocks the PASS conclusion, issues take precedence)", () => {
    const v = verifyDesignReviewReportSnapshot(
      report(
        "**Design Review: PASS**",
        ["| ID | Severity | Evidence | Summary |", "| --- | --- | --- | --- |", "| DR-2-1 | Blocker | bun test exits 1 in test phase | fee caliber redefined |"],
      ),
      expectation(),
    );
    expect(v.verdict).toBe("fail");
    if (v.verdict === "fail") {
      expect(v.reason).toContain("blocking issues present");
      expect(v.reason).toContain("precedence");
    }
  });

  it("Blocker WITHOUT evidence ⇒ invalid (both tracks identical)", () => {
    const v = verifyDesignReviewReportSnapshot(
      report(
        "**Design Review: FAIL**",
        ["| ID | Severity | Evidence | Summary |", "| --- | --- | --- | --- |", "| DR-2-1 | Blocker | | fee caliber redefined |"],
      ),
      expectation(),
    );
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" ")).toContain(`blocking issue "DR-2-1" (Blocker) requires Evidence`);
    }
  });

  it("missing severity ⇒ invalid; unknown severity token ⇒ invalid", () => {
    const missing = verifyDesignReviewReportSnapshot(
      report(
        "**Design Review: FAIL**",
        ["| ID | Severity | Evidence | Summary |", "| --- | --- | --- | --- |", "| DR-2-1 | CRITICAL | assertion | fee caliber redefined |"],
      ),
      expectation(),
    );
    expect(missing.verdict).toBe("invalid");
    if (missing.verdict === "invalid") {
      expect(missing.failures.join(" ")).toContain(`issue "DR-2-1" is missing a legal severity`);
    }

    const noColumn = verifyDesignReviewReportSnapshot(
      report("**Design Review: FAIL**", ["1. a severity-less legacy bullet"]),
      expectation(),
    );
    expect(noColumn.verdict).toBe("invalid");
  });

  it("empty-item Issues body + PASS ⇒ invalid (rule 2 kept verbatim); FAIL conclusion without entries ⇒ fail", () => {
    // substantive content (a harmless sub-heading) but ZERO candidate items
    const subheadingOnly = ["#### notes"];
    const emptyPass = verifyDesignReviewReportSnapshot(report("**Design Review: PASS**", subheadingOnly), expectation());
    expect(emptyPass.verdict).toBe("invalid");
    if (emptyPass.verdict === "invalid") {
      expect(emptyPass.failures.join(" ")).toContain("PASS without an explicit no-issues sentinel item");
    }

    const failNoItems = verifyDesignReviewReportSnapshot(report("**Design Review: FAIL**", subheadingOnly), expectation());
    expect(failNoItems.verdict).toBe("fail");
  });

  it("smart gate still applies to blocking FAILs", () => {
    const v = verifyDesignReviewReportSnapshot(
      report(
        "**Design Review: FAIL**",
        ["| ID | Severity | Evidence | Summary |", "| --- | --- | --- | --- |", "| DR-2-1 | Blocker | failing assertion | fee caliber redefined |"],
      ),
      expectation(),
      { smartDecisionMode: true },
    );
    expect(v.verdict).toBe("invalid"); // no ## Plan Revision Decision section
  });

  it("severityGate:false restores the pre-229 verdict rule verbatim (MEDIUM issues also fail)", () => {
    const v = verifyDesignReviewReportSnapshot(
      report("**Design Review: PASS**", ROWS_4_MEDIUM),
      expectation(),
      {
        severityGate: false,
      },
    );
    expect(v.verdict).toBe("fail");
    if (v.verdict === "fail") {
      // exact legacy reason string
      expect(v.reason).toBe("valid issues present — issues take precedence over PASS conclusion");
    }
  });

  it("ID贯通: report id DR-2-1 ⇒ verifiedIssues[0].issueId === 'DR-2-1'", () => {
    const v = verifyDesignReviewReportSnapshot(
      report(
        "**Design Review: FAIL**",
        ["| ID | Severity | Evidence | Summary |", "| --- | --- | --- | --- |", "| DR-2-1 | Blocker | failing assertion | fee caliber redefined |"],
      ),
      expectation(),
    );
    if (v.verdict !== "fail") throw new Error(`expected fail, got ${JSON.stringify(v)}`);
    expect(v.issues[0]!.issueId).toBe("DR-2-1");
  });
});
