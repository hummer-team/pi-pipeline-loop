/**
 * 229 Phase 2 (F2): the cross-round Issue Ledger CLOSURE enforced by the
 * trusted verifier, and the stable-id receipt mapping (B18).
 *
 * Boundaries covered (plan Phase 2 "单元测试目标，边界"):
 * - closure: a missing previous open id (DR-1-2) ⇒ invalid and the failure
 *   TEXT names the id; complete + legal ⇒ verdict proceeds untouched;
 *   `fixed` rows restated in the ledger never re-FAIL on their own;
 * - closure is ORTHOGONAL: a PASS with unresolved closure debt is still invalid;
 * - first round (no previousOpenIssues) ⇒ the ledger is NOT required and the
 *   closure is skipped (the audit lives with the auto-verifier caller, the
 *   verifier itself stays pure);
 * - stable ids end-to-end: report id ⇒ verified issues ⇒ (pure-function level)
 *   the coordinator's legacy fallback numbering (`DR-<round>-n`).
 */

import { describe, expect, it } from "bun:test";
import { verifyDesignReviewReportSnapshot } from "../../core/verifiers/design-review-verifier";
import type { DesignReviewIssueRecord } from "../../types";

const HID = "c".repeat(64);
const OP = "op-closure-1";

function expectation(round: number, overrides: Partial<Parameters<typeof verifyDesignReviewReportSnapshot>[1]> = {}) {
  return {
    pipelineId: "pipe-closure",
    planDoc: "/abs/closure-plan.md",
    round,
    operationId: OP,
    inputHash: HID,
    ...overrides,
  };
}

function report(round: number, verdictRow: string, body: string[]): string {
  return [
    "# Design Review Report",
    "",
    "**pipeline**: pipe-closure",
    "**plan**: /abs/closure-plan.md",
    `**round**: ${round}`,
    `**operation**: ${OP}`,
    `**input hash**: ${HID}`,
    "",
    "## Summary",
    "",
    "Reviewed.",
    "",
    "## Verdict",
    "",
    verdictRow,
    "",
    "## Issue Ledger",
    "",
    "| ID | Severity | Status | Evidence | Summary |",
    "| --- | --- | --- | --- | --- |",
    "| DR-1-1 | Blocker | fixed | failing assertion | gap one |",
    "| DR-1-2 | High | open | missing AC coverage | gap two |",
    "",
    "## Issues",
    "",
    ...body,
    "",
    "## Recommendations",
    "",
    "ok",
    "",
  ].join("\n");
}

const prevOpen: DesignReviewIssueRecord[] = [
  { id: "DR-1-1", origin: "1", severity: "Blocker", status: "open", text: "gap one" },
  { id: "DR-1-2", origin: "1", severity: "High", status: "open", text: "gap two" },
];

describe("229 Phase 2: issue-ledger closure (F2)", () => {
  it("all previous open ids restated with legal statuses ⇒ verdict proceeds (fixed non-blocking ⇒ pass)", () => {
    const v = verifyDesignReviewReportSnapshot(
      report(2, "**Design Review: PASS**", ["None"]),
      expectation(2),
      { requireIssueLedger: true, previousOpenIssues: prevOpen },
    );
    expect(v.verdict).toBe("pass");
  });

  it("missing DR-1-2 ⇒ invalid and the failure names the MISSING ID", () => {
    const partial = report(2, "**Design Review: PASS**", ["None"]).replace(
      "| DR-1-2 | High | open | missing AC coverage | gap two |\n",
      "",
    );
    const v = verifyDesignReviewReportSnapshot(partial, expectation(2), {
      requireIssueLedger: true,
      previousOpenIssues: prevOpen,
    });
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" ")).toContain("DR-1-2");
      expect(v.failures.join(" ")).toContain("closure");
    }
  });

  it("closure is orthogonal: a PASS with unresolved debt (missing ledger section) is invalid", () => {
    const noLedger = report(2, "**Design Review: PASS**", ["None"]).replace(
      /## Issue Ledger[\s\S]*?(?=## Issues)/,
      "",
    );
    const v = verifyDesignReviewReportSnapshot(noLedger, expectation(2), {
      requireIssueLedger: true,
      previousOpenIssues: prevOpen,
    });
    expect(v.verdict).toBe("invalid");
  });

  it("first round: the ledger is NOT required and closure is skipped (verifier stays pure)", () => {
    const v = verifyDesignReviewReportSnapshot(
      report(1, "**Design Review: PASS**", ["None"]),
      expectation(1),
      { requireIssueLedger: false },
    );
    expect(v.verdict).toBe("pass");
  });

  it("blocking NEW issue + restated prev debt ⇒ fail with stable ids", () => {
    const v = verifyDesignReviewReportSnapshot(
      report(2, "**Design Review: FAIL**", [
        "| ID | Severity | Evidence | Summary |",
        "| --- | --- | --- | --- |",
        "| DR-2-1 | Blocker | failing assertion | new fee caliber defect |",
      ]),
      expectation(2),
      { requireIssueLedger: true, previousOpenIssues: prevOpen },
    );
    expect(v.verdict).toBe("fail");
    if (v.verdict === "fail") {
      expect(v.issues.map((i) => i.issueId)).toEqual(["DR-2-1"]);
    }
  });
});
