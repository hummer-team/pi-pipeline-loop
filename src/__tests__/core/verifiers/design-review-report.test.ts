/**
 * 192 Phase 3 (K07/F02): trusted design-review report semantics over ONE
 * snapshot — pure tests for the domain verifier.
 *
 * Acceptance matrix (plan Unit Tests Core):
 * - full identity binding incl. operationId + input hash
 * - valid issues take precedence over a PASS conclusion
 * - bilingual / bold canonical conclusion forms; mutually exclusive tokens;
 *   unknown capture tokens never default to pass
 * - fenced code (``` and ~~~), block quotes and HTML comments excluded
 * - exact "None"/"无" whole-item sentinel; "无法恢复…" remains a real issue
 * - same BASENAME in a foreign directory / stale identity rows rejected
 * - PASS with no explicit conclusion → invalid; Summary-body "PASS" text
 *   never acts as the verdict
 */

import { describe, it, expect } from "bun:test";
import {
  verifyDesignReviewReportSnapshot,
  computeReportHash,
} from "../../../core/verifiers/design-review-verifier";
import type { DesignReviewReportExpectation } from "../../../core/verifiers/design-review-verifier";

const PLAN = "/abs/project/docs/190_Feat_plan.md";
const OP = "op-aaaa-1111";
const HASH = "d".repeat(64);

function expectation(overrides?: Partial<DesignReviewReportExpectation>): DesignReviewReportExpectation {
  return {
    pipelineId: "pipe-x",
    planDoc: PLAN,
    round: 2,
    operationId: OP,
    inputHash: HASH,
    ...overrides,
  };
}

/**
 * 193 Phase 0: the four contract sections. `identityHead` carries the two
 * sections that every case needs but rarely rewrites (Summary + Recommendations),
 * so a case only appends the Verdict/Issues tail it is actually testing.
 * `identityHeadOnly` stays available for cases that must control those sections
 * themselves (e.g. the duplicate/absent-heading negatives).
 */
const SUMMARY_SECTION = ["## Summary", "", "Reviewed the plan against the requirement document; phase split,", "acceptance criteria and regression coverage are addressed."];
const RECOMMENDATIONS_SECTION = ["## Recommendations", "", "Proceed with the plan as written; keep the per-phase acceptance", "criteria as the regression checklist."];

function identityHeadOnly(extra?: string): string {
  return [
    "# Design Review Report",
    "",
    "**pipeline**: pipe-x",
    `**plan**: ${PLAN}`,
    "**round**: 2",
    `**operation**: ${OP}`,
    `**input hash**: ${HASH}`,
    extra ?? "",
  ].filter((l) => l !== "").join("\n");
}

function identityHead(extra?: string): string {
  return [identityHeadOnly(extra), "", ...SUMMARY_SECTION, "", ...RECOMMENDATIONS_SECTION].join("\n");
}

describe("192 Phase 3: identity binding (full fields, canonical)", () => {
  it("all identity fields matching + PASS + None → pass", () => {
    const content = [
      identityHead(),
      "",
      "## Verdict",
      "",
      "**Design Review: PASS**",
      "",
      "## Issues",
      "None",
      "",
    ].join("\n");
    const v = verifyDesignReviewReportSnapshot(content, expectation());
    expect(v.verdict).toBe("pass");
    if (v.verdict === "pass") {
      expect(v.reportHash).toBe(computeReportHash(content));
      expect(v.issues).toEqual([]);
    }
  });

  it("foreign pipelineId rejected even with matching plan/round", () => {
    const content = identityHead().replace("pipe-x", "foreign-pipeline");
    const v = verifyDesignReviewReportSnapshot(content + "\n\n## Verdict\n\n**Design Review: PASS**\n\n## Issues\nNone\n", expectation());
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" ")).toContain("pipeline identity mismatch");
    }
  });

  it("same basename but different directory for plan is rejected (no basename matching)", () => {
    const content = identityHead().replace(PLAN, "/abs/other/docs/190_Feat_plan.md");
    const v = verifyDesignReviewReportSnapshot(
      content + "\n\n## Verdict\n\n**Design Review: PASS**\n\n## Issues\nNone\n",
      expectation(),
    );
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" ")).toContain("different plan document");
    }
  });

  it("stale operationId (previous review op) rejected", () => {
    const content = identityHead().replace(OP, "op-STALE-0000");
    const v = verifyDesignReviewReportSnapshot(
      content + "\n\n## Verdict\n\n**Design Review: PASS**\n\n## Issues\nNone\n",
      expectation(),
    );
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" ")).toContain("different review operation");
    }
  });

  it("input hash mismatch (plan version drift) rejected", () => {
    const content = identityHead().replace(HASH, "e".repeat(64));
    const v = verifyDesignReviewReportSnapshot(
      content + "\n\n## Verdict\n\n**Design Review: FAIL**\n\n## Issues\n1. x\n",
      expectation(),
    );
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" ")).toContain("different plan version");
    }
  });

  it("missing operation row entirely → invalid (never guess identity)", () => {
    const content = identityHead().replace(`**operation**: ${OP}\n`, "");
    const v = verifyDesignReviewReportSnapshot(
      content + "\n\n## Verdict\n\n**Design Review: PASS**\n\n## Issues\nNone\n",
      expectation(),
    );
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" ")).toContain("missing **operation**");
    }
  });
});

describe("192 Phase 3: issues precedence and verdict semantics", () => {
  it("valid non-empty issues force FAIL even under a PASS conclusion", () => {
    const content = [
      identityHead(),
      "",
      "## Verdict",
      "",
      "**Design Review: PASS**",
      "",
      "## Issues",
      "1. Missing error handling",
      "2. 接口契约未定义",
      "",
    ].join("\n");
    const v = verifyDesignReviewReportSnapshot(content, expectation());
    expect(v.verdict).toBe("fail");
    if (v.verdict === "fail") {
      expect(v.issues.map((i) => i.issueId)).toEqual(["1", "2"]);
      expect(v.reason).toContain("precedence");
    }
  });

  it('"无法恢复…" is a REAL issue, not a None sentinel', () => {
    const content = [
      identityHead(),
      "",
      "## Verdict",
      "",
      "**Design Review: PASS**",
      "",
      "## Issues",
      "- 无法恢复异常派发",
      "",
    ].join("\n");
    const v = verifyDesignReviewReportSnapshot(content, expectation());
    expect(v.verdict).toBe("fail");
  });

  it('"nonequivalent" is not the None sentinel either', () => {
    const content = [
      identityHead(),
      "",
      "## Verdict",
      "",
      "**设计评审: 通过**",
      "",
      "## Issues",
      "nonequivalent",
      "",
    ].join("\n");
    expect(verifyDesignReviewReportSnapshot(content, expectation()).verdict).toBe("fail");
  });

  it("exact whole-item 'None'/'无' sentinels mean no issues (PASS)", () => {
    for (const sentinel of ["None", "无", "N/A", "NOT APPLICABLE"]) {
      const content = [
        identityHead(),
        "",
        "## Verdict",
        "",
        "**Design Review: PASS**",
        "",
        "## Issues",
        sentinel,
        "",
      ].join("\n");
      expect(verifyDesignReviewReportSnapshot(content, expectation()).verdict).toBe("pass");
    }
  });

  it("bold/italic and bilingual conclusion forms are canonical", () => {
    for (const row of [
      "**Design Review: FAIL**",
      "**设计评审：不通过**",
      "结论：不通过",
      "Verdict: **FAIL**",
    ]) {
      const content = [
        identityHead(),
        "",
        "## Verdict",
        "",
        row,
        "",
        "## Issues",
        "1. defect",
        "",
      ].join("\n");
      expect(verifyDesignReviewReportSnapshot(content, expectation()).verdict).toBe("fail");
    }
  });

  it("mutually exclusive PASS and FAIL conclusions → invalid", () => {
    const content = [
      identityHead(),
      "",
      "## Verdict",
      "",
      "**Design Review: PASS**",
      "**Design Review: FAIL**",
      "",
      "## Issues",
      "None",
      "",
    ].join("\n");
    const v = verifyDesignReviewReportSnapshot(content, expectation());
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" ")).toContain("mutually exclusive");
    }
  });

  it("no conclusion line → invalid", () => {
    const content = [
      identityHead(),
      "",
      "## Verdict",
      "",
      "We discussed a lot.",
      "",
      "## Issues",
      "None",
      "",
    ].join("\n");
    expect(verifyDesignReviewReportSnapshot(content, expectation()).verdict).toBe("invalid");
  });

  it("Summary prose containing PASS does not act as verdict", () => {
    // Raw head on purpose: this case must control the Summary body itself and
    // carry NO verdict conclusion line (193 Phase 0: missing Verdict section or
    // missing conclusion line is invalid, never a silent pass).
    const content = [
      identityHeadOnly(),
      "",
      "## Summary",
      "",
      "Overall this looks PASS worthy in spirit.",
      "",
      "## Issues",
      "None",
      "",
    ].join("\n");
    expect(verifyDesignReviewReportSnapshot(content, expectation()).verdict).toBe("invalid");
  });
});

describe("192 Phase 3: inert content exclusion", () => {
  const verdictAndIssues = "\n\n## Verdict\n\n**Design Review: PASS**\n\n## Issues\nNone\n";

  it("PASS example inside a fenced code block never counts as the verdict; a real fenced issue row never counts either", () => {
    const content = identityHead()
      + "\n\n```markdown\n**Design Review: FAIL**\n\n## Issues\n1. inside-fence-only\n```\n"
      + verdictAndIssues;
    const v = verifyDesignReviewReportSnapshot(content, expectation());
    expect(v.verdict).toBe("pass");
  });

  it("~~~ fences excluded too", () => {
    const content = identityHead()
      + "\n\n~~~\n**Design Review: FAIL**\n~~~\n"
      + verdictAndIssues;
    expect(verifyDesignReviewReportSnapshot(content, expectation()).verdict).toBe("pass");
  });

  it("blockquote-echoed verdict is inert", () => {
    const content = identityHead() + "\n\n> **Design Review: FAIL**\n" + verdictAndIssues;
    expect(verifyDesignReviewReportSnapshot(content, expectation()).verdict).toBe("pass");
  });

  it("HTML-commented verdict is inert", () => {
    const content = identityHead() + "\n\n<!-- **Design Review: FAIL** -->\n" + verdictAndIssues;
    expect(verifyDesignReviewReportSnapshot(content, expectation()).verdict).toBe("pass");
  });
});

describe("192 Phase 3: unknown tokens / contract errors", () => {
  it("custom contract verdict patterns drive extraction", () => {
    // 193 Phase 0: the report stays structurally complete (all four sections) so
    // the assertion actually reaches the verdict phase and tests the TOKEN, not
    // the section contract.
    const content = identityHead() + "\n\n## Verdict\n\nVERDICT>>MAYBE<<\n\n## Issues\nNone\n";
    const v = verifyDesignReviewReportSnapshot(content, expectation(), {
      verdictPatterns: ["VERDICT>>(MAYBE)<<"],
    });
    // MAYBE is not in the known verdict vocabulary → unknown token, never pass
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" ")).toContain("unknown verdict token");
    }
  });

  it("invalid regex in the contract is fail-closed", () => {
    const content = identityHead()
      + "\n\n## Verdict\n\n**Design Review: PASS**\n\n## Issues\nNone\n";
    const v = verifyDesignReviewReportSnapshot(content, expectation(), {
      verdictPatterns: ["([unclosed"],
    });
    expect(v.verdict).toBe("invalid");
  });

  it("empty Issues section (heading present, no items) → invalid", () => {
    const content = identityHead() + "\n\n## Verdict\n\n**Design Review: FAIL**\n\n## Issues\n\n";
    const v = verifyDesignReviewReportSnapshot(content, expectation());
    expect(v.verdict).toBe("invalid");
  });
});
