/**
 * 230 Phase 6: contract evals — the shipped review-loop contract and the
 * trusted verifier must agree on every semantic the assets teach.
 *
 * Each case pins ONE contract section against the pure verifier API:
 *   - contract §3 (verdict gate): only a Blocker/High WITH Evidence blocks;
 *     `None` or Medium/Low-only reports pass;
 *   - contract §2 (issue schema): a Blocker/High without Evidence is invalid;
 *   - contract §4 (issue ledger): an injected id that is not restated is
 *     invalid.
 *
 * Boundary: pure functions only — no `fs`, no runtime imports, no new runtime
 * behaviour. The report builders below are local to this file so the suite
 * never depends on another test's fixtures.
 */

import { describe, expect, it } from "bun:test";
import { verifyDesignReviewReportSnapshot } from "../../core/verifiers/design-review-verifier";
import type { DesignReviewIssueRecord } from "../../types";

const INPUT_HASH = "b".repeat(64);
const OPERATION_ID = "op-contract-eval-1";
const PIPELINE_ID = "pipe-contract-eval";
const PLAN_DOC = "/abs/contract-eval-plan.md";

/** Builds an identity-complete report whose verdict/issues are parameterized. */
function buildReport(round: number, verdictRow: string, issuesBody: readonly string[]): string {
  return [
    "# Design Review Report",
    "",
    `**pipeline**: ${PIPELINE_ID}`,
    `**plan**: ${PLAN_DOC}`,
    `**round**: ${round}`,
    `**operation**: ${OPERATION_ID}`,
    `**input hash**: ${INPUT_HASH}`,
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
    ...issuesBody,
    "",
    "## Recommendations",
    "",
    "Keep the per-phase acceptance assertions as the regression checklist.",
    "",
  ].join("\n");
}

/** Builds a report that additionally carries a cross-round ledger table. */
function buildReportWithLedger(
  round: number,
  verdictRow: string,
  issuesBody: readonly string[],
  ledgerRows: readonly string[],
): string {
  const plain = buildReport(round, verdictRow, issuesBody);
  const ledger = [
    "## Issue Ledger",
    "",
    "| ID | Severity | Status | Evidence | Summary |",
    "| --- | --- | --- | --- | --- |",
    ...ledgerRows,
    "",
    "## Issues",
    "",
  ].join("\n");
  return plain.replace("## Issues\n", ledger);
}

/** The verifier expectation for the current fixture identity. */
function expectation(round: number) {
  return {
    pipelineId: PIPELINE_ID,
    planDoc: PLAN_DOC,
    round,
    operationId: OPERATION_ID,
    inputHash: INPUT_HASH,
  };
}

const MEDIUM_ONLY_ISSUES = [
  "| ID | Severity | Evidence | Summary |",
  "| --- | --- | --- | --- |",
  "| DR-1-1 | Medium | | wording nit in the summary |",
];

const BLOCKER_WITH_EVIDENCE = [
  "| ID | Severity | Evidence | Summary |",
  "| --- | --- | --- | --- |",
  "| DR-1-1 | Blocker | bun test src/__tests__/template exits 1 | a phase has no executable acceptance command |",
];

const BLOCKER_WITHOUT_EVIDENCE = [
  "| ID | Severity | Evidence | Summary |",
  "| --- | --- | --- | --- |",
  "| DR-1-1 | Blocker | | a phase has no executable acceptance command |",
];

const PREVIOUS_OPEN: readonly DesignReviewIssueRecord[] = [
  { id: "DR-1-1", origin: "1", severity: "Blocker", status: "open", text: "gap one" },
  { id: "DR-1-2", origin: "1", severity: "High", status: "open", text: "gap two" },
];

describe("230 Phase 6: review-loop contract evals", () => {
  it("contract §3: Medium/Low-only entries never fail the verdict", () => {
    const result = verifyDesignReviewReportSnapshot(
      buildReport(1, "**Design Review: PASS**", MEDIUM_ONLY_ISSUES),
      expectation(1),
    );
    expect(result.verdict).toBe("pass");
    if (result.verdict === "pass") {
      // the non-blocking entry is still recorded, never silently dropped
      expect(result.issues.map((issue) => issue.issueId)).toEqual(["DR-1-1"]);
    }
  });

  it("contract §3: a Blocker with Evidence forces FAIL even against a PASS conclusion", () => {
    const result = verifyDesignReviewReportSnapshot(
      buildReport(1, "**Design Review: PASS**", BLOCKER_WITH_EVIDENCE),
      expectation(1),
    );
    expect(result.verdict).toBe("fail");
  });

  it("contract §2: a Blocker without Evidence makes the report invalid", () => {
    const result = verifyDesignReviewReportSnapshot(
      buildReport(1, "**Design Review: FAIL**", BLOCKER_WITHOUT_EVIDENCE),
      expectation(1),
    );
    expect(result.verdict).toBe("invalid");
    if (result.verdict === "invalid") {
      expect(result.failures.join(" ")).toContain("DR-1-1");
      expect(result.failures.join(" ")).toContain("Evidence");
    }
  });

  it("contract §4: an injected id that is not restated in the ledger is invalid", () => {
    const missingOne = buildReportWithLedger(
      2,
      "**Design Review: PASS**",
      ["None"],
      ["| DR-1-1 | Blocker | fixed | failing assertion | gap one |"],
    );
    const result = verifyDesignReviewReportSnapshot(missingOne, expectation(2), {
      requireIssueLedger: true,
      previousOpenIssues: PREVIOUS_OPEN,
    });
    expect(result.verdict).toBe("invalid");
    if (result.verdict === "invalid") {
      expect(result.failures.join(" ")).toContain("DR-1-2");
    }
  });

  it("contract §4: restating every injected id lets the verdict proceed", () => {
    const complete = buildReportWithLedger(
      2,
      "**Design Review: PASS**",
      ["None"],
      [
        "| DR-1-1 | Blocker | fixed | failing assertion | gap one |",
        "| DR-1-2 | High | fixed | acceptance command now present | gap two |",
      ],
    );
    const result = verifyDesignReviewReportSnapshot(complete, expectation(2), {
      requireIssueLedger: true,
      previousOpenIssues: PREVIOUS_OPEN,
    });
    expect(result.verdict).toBe("pass");
  });
});