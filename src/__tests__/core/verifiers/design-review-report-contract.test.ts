/**
 * 193 Phase 0 (Unit Tests Core #1): COMPLETE design-review report contract.
 *
 * Covers the three layers of the trusted contract on ONE snapshot:
 * - identity rows: presence, alias acceptance (operationId / baselinePlanHash /
 *   Chinese aliases), spacing tolerance, duplicate-agreeing vs contradictory
 *   ("ambiguous") rows;
 * - structure: Summary / Issues / Recommendations / Verdict each EXACTLY once
 *   with substantive content — missing / empty / placeholder-only /
 *   inert-only (code block, blockquote, HTML comment) / reordered / Chinese /
 *   spacing and case variants; the no-issues "None" sentinel;
 * - verdict: order of checks (identity → structure → verdict) and the preserved
 *   legacy semantics (issues take precedence, mutually exclusive conclusions,
 *   unknown tokens, PASS without sentinel).
 */

import { describe, it, expect } from "bun:test";
import {
  DESIGN_REVIEW_IDENTITY_FIELDS,
  DESIGN_REVIEW_REPORT_SECTIONS,
  checkDesignReviewReportIdentity,
  checkDesignReviewReportSections,
  findAmbiguousDesignReviewIdentityRows,
  findDesignReviewIdentityValue,
} from "../../../core/design-review/report-contract";
import {
  DEFAULT_ISSUE_HEADING_PATTERN,
  collectReportFieldValues,
  compileHeadingRe,
  extractReportSection,
  extractReportSections,
  findReportField,
  hasSubstantiveContent,
  isLazilyFilledLine,
  stripInertLines,
} from "../../../core/design-review/report-sections";
import {
  verifyDesignReviewReportSnapshot,
  type DesignReviewReportExpectation,
} from "../../../core/verifiers/design-review-verifier";

const PLAN_DOC = "/docs/193_Feat_plan.md";
const PIPELINE_ID = "pipe-contract-193";
const OP_ID = "op-contract-review-1";
const INPUT_HASH = "a".repeat(64);

/** Canonical identity block shared by every positive fixture. */
function identityBlock(extra?: string): string {
  return [
    `**pipeline**: ${PIPELINE_ID}`,
    `**plan**: ${PLAN_DOC}`,
    `**round**: 1`,
    `**operation**: ${OP_ID}`,
    `**input hash**: ${INPUT_HASH}`,
    ...(extra ? [extra] : []),
  ].join("\n");
}

/** Complete four-section report (PASS by default), built from the fixture. */
function completeReport(opts?: {
  verdict?: "PASS" | "FAIL";
  issuesBody?: string;
  summaryBody?: string;
  recommendationsBody?: string;
  identity?: string;
  order?: Array<"summary" | "issues" | "recommendations" | "verdict">;
}): string {
  const identity = opts?.identity ?? identityBlock();
  const bodies: Record<string, string> = {
    summary: opts?.summaryBody ?? "The plan matches the requirement; scope and phases are complete.",
    issues:
      opts?.issuesBody ??
      (opts?.verdict === "FAIL" ? "1. Phase 2 acceptance is missing a rollback check." : "None"),
    recommendations: opts?.recommendationsBody ?? "Keep the per-phase regression checklist as written.",
    verdict: `**Design Review: ${opts?.verdict ?? "PASS"}**`,
  };
  const order = opts?.order ?? ["summary", "issues", "recommendations", "verdict"];
  const sections = order.map((key) => {
    const heading = {
      summary: "## Summary",
      issues: "## Issues",
      recommendations: "## Recommendations",
      verdict: "## Verdict",
    }[key];
    return `${heading}\n\n${bodies[key]}`;
  });
  return [`# Design Review Report`, ``, identity, ``, ...sections].join("\n");
}

const EXPECTATION: DesignReviewReportExpectation = {
  pipelineId: PIPELINE_ID,
  planDoc: PLAN_DOC,
  round: 1,
  operationId: OP_ID,
  inputHash: INPUT_HASH,
};

describe("193 Phase 0: identity rows — presence, aliases, ambiguity", () => {
  it("five filled rows produce no identity failures", () => {
    const lines = stripInertLines(completeReport());
    expect(checkDesignReviewReportIdentity(lines)).toEqual([]);
  });

  it("each missing row reports its own canonical label", () => {
    const rows: Array<[string, string]> = [
      [`**pipeline**: ${PIPELINE_ID}`, "missing **pipeline** identity field"],
      [`**plan**: ${PLAN_DOC}`, "missing **plan** identity field"],
      ["**round**: 1", "missing **round** identity field"],
      [`**operation**: ${OP_ID}`, "missing **operation** identity field"],
      [`**input hash**: ${INPUT_HASH}`, "missing **input hash** identity field"],
    ];
    for (const [rowToRemove, expected] of rows) {
      const content = completeReport()
        .split("\n")
        .filter((l) => l !== rowToRemove)
        .join("\n");
      const failures = checkDesignReviewReportIdentity(stripInertLines(content));
      expect(failures).toContain(expected);
    }
  });

  it("operation and input-hash rows are optional for legacy reads", () => {
    const content = completeReport()
      .split("\n")
      .filter((l) => !l.startsWith("**operation**") && !l.startsWith("**input hash**"))
      .join("\n");
    const lines = stripInertLines(content);
    // Default policy requires both rows...
    expect(checkDesignReviewReportIdentity(lines).length).toBe(2);
    // ...and only the verifier's legacy mode (no current operation identity
    // to bind) may relax them.
    expect(
      checkDesignReviewReportIdentity(lines, { requireOperation: false, requireInputHash: false }),
    ).toEqual([]);
  });

  it("legacy aliases **operationId** / **baselinePlanHash** satisfy the rows", () => {
    const identity = [
      `**pipeline**: ${PIPELINE_ID}`,
      `**plan**: ${PLAN_DOC}`,
      `**round**: 1`,
      `**operationId**: ${OP_ID}`,
      `**baselinePlanHash**: ${INPUT_HASH}`,
    ].join("\n");
    const lines = stripInertLines(completeReport({ identity }));
    expect(checkDesignReviewReportIdentity(lines)).toEqual([]);
    expect(findDesignReviewIdentityValue(lines, "operation")).toBe(OP_ID);
    expect(findDesignReviewIdentityValue(lines, "inputHash")).toBe(INPUT_HASH);
  });

  it("Chinese aliases (输入版本 / 计划 hash) satisfy the input-hash row", () => {
    for (const alias of ["**输入版本**", "**计划 hash**"]) {
      const identity = identityBlock().replace(
        `**input hash**: ${INPUT_HASH}`,
        `${alias}: ${INPUT_HASH}`,
      );
      const lines = stripInertLines(completeReport({ identity }));
      expect(checkDesignReviewReportIdentity(lines)).toEqual([]);
    }
  });

  it("spacing, case and full-width colon are tolerated", () => {
    const identity = [
      `**Pipeline** ：  ${PIPELINE_ID}  `,
      `**plan** : ${PLAN_DOC}`,
      `**ROUND**:1`,
      `**operation**: ${OP_ID}`,
      `**INPUT  HASH**: ${INPUT_HASH}`,
    ].join("\n");
    const lines = stripInertLines(completeReport({ identity }));
    expect(checkDesignReviewReportIdentity(lines)).toEqual([]);
    expect(findDesignReviewIdentityValue(lines, "pipeline")).toBe(PIPELINE_ID);
    expect(findDesignReviewIdentityValue(lines, "round")).toBe("1");
  });

  it("duplicated rows with the SAME value are tolerated", () => {
    const identity = identityBlock() + `\n**pipeline**: ${PIPELINE_ID}`;
    const lines = stripInertLines(completeReport({ identity }));
    expect(checkDesignReviewReportIdentity(lines)).toEqual([]);
    expect(findAmbiguousDesignReviewIdentityRows(lines)).toEqual([]);
  });

  it("duplicated rows with DIFFERENT values are ambiguous (never last-one-wins)", () => {
    const identity = identityBlock() + `\n**pipeline**: pipe-forged-999`;
    const lines = stripInertLines(completeReport({ identity }));
    const failures = checkDesignReviewReportIdentity(lines);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("**pipeline** identity field is ambiguous");
    expect(failures[0]).toContain(PIPELINE_ID);
    expect(failures[0]).toContain("pipe-forged-999");
    // The alias table stays a single source: no duplicate policy per consumer
    const aliases = DESIGN_REVIEW_IDENTITY_FIELDS.flatMap((f) => f.aliases);
    expect(aliases).toContain("baselinePlanHash");
  });

  it("value lookup goes through the shared alias table", () => {
    const lines = stripInertLines(completeReport());
    // Legacy alias lists may overlap ("input hash" also matches `input\s*hash`),
    // so collection can report the SAME value more than once. Ambiguity is
    // decided by DISTINCT values, never by row count — that is what lets an
    // overlapping alias list stay a single policy source.
    const inputHashValues = collectReportFieldValues(
      lines,
      DESIGN_REVIEW_IDENTITY_FIELDS.find((f) => f.key === "inputHash")!.aliases,
    );
    expect([...new Set(inputHashValues)]).toEqual([INPUT_HASH]);
    expect(findReportField(lines, ["nonexistent"])).toBeUndefined();
    // canonical alias is tried first: a report carrying both canonical and
    // legacy rows with the same value resolves to the canonical one
    const both = identityBlock(`**operationId**: ${OP_ID}`);
    const bothLines = stripInertLines(both);
    expect(findReportField(bothLines, ["operation", "operationId"])).toBe(OP_ID);
  });
});

describe("193 Phase 0: structure — four sections exactly once, substantive content", () => {
  it("complete report has no structure failures (all four headings recognized)", () => {
    const lines = stripInertLines(completeReport());
    expect(checkDesignReviewReportSections(lines)).toEqual([]);
    expect(DESIGN_REVIEW_REPORT_SECTIONS.map((s) => s.key)).toEqual([
      "summary",
      "issues",
      "recommendations",
      "verdict",
    ]);
  });

  it("missing sections are named with their canonical heading hint", () => {
    const lines = stripInertLines(completeReport({ summaryBody: "" }).replace("## Summary", "## Notes"));
    const failures = checkDesignReviewReportSections(lines);
    expect(failures.some((f) => f.startsWith("missing Summary section heading"))).toBe(true);
    expect(failures.join(" ")).toContain("## Summary");
  });

  for (const key of ["summary", "issues", "recommendations", "verdict"] as const) {
    it(`missing ${key} section fails the contract`, () => {
      const heading = {
        summary: "## Summary",
        issues: "## Issues",
        recommendations: "## Recommendations",
        verdict: "## Verdict",
      }[key];
      const content = completeReport()
        .split("\n")
        .filter((l) => l !== heading)
        .join("\n");
      const failures = checkDesignReviewReportSections(stripInertLines(content));
      expect(failures.some((f) => f.startsWith(`missing ${key[0]!.toUpperCase()}${key.slice(1)} section heading`))).toBe(true);
    });
  }

  it("duplicated section headings are rejected (exactly-one rule)", () => {
    const content = completeReport() + "\n\n## Issues\n\n2. Another problem.\n";
    const failures = checkDesignReviewReportSections(stripInertLines(content));
    expect(failures.some((f) => f.includes("Issues section heading appears 2 times"))).toBe(true);
  });

  it("empty section body is not content", () => {
    const content = completeReport().replace("## Issues\n\nNone", "## Issues\n\n");
    const failures = checkDesignReviewReportSections(stripInertLines(content));
    expect(failures.some((f) => f.includes("Issues section has no content"))).toBe(true);
  });

  it("unfilled placeholders do not count as content", () => {
    const content = completeReport({ summaryBody: "{summary}\n{{assessment}}" });
    const failures = checkDesignReviewReportSections(stripInertLines(content));
    expect(failures.some((f) => f.includes("Summary section has no content"))).toBe(true);
    expect(isLazilyFilledLine("{summary}")).toBe(true);
    expect(isLazilyFilledLine("{{assessment}}")).toBe(true);
    expect(isLazilyFilledLine("{summary} with filled text")).toBe(false);
    expect(isLazilyFilledLine("None")).toBe(false);
  });

  it("markdown decoration-only body does not count as content", () => {
    expect(isLazilyFilledLine("** **")).toBe(true);
    expect(isLazilyFilledLine("---")).toBe(true);
    expect(hasSubstantiveContent(["", "  ", "---", "** **"])).toBe(false);
    expect(hasSubstantiveContent(["None"])).toBe(true);
  });

  it("inert-only sections (code block / blockquote / comment) are empty", () => {
    const inert = [
      "## Recommendations",
      "",
      "```markdown",
      "Some recommendation example",
      "```",
      "",
      "> quoted recommendation",
      "",
      "<!-- TODO: fill this -->",
    ].join("\n");
    const content = completeReport({ recommendationsBody: "" }).replace(
      "## Recommendations\n\n",
      inert,
    );
    const failures = checkDesignReviewReportSections(stripInertLines(content));
    expect(failures.some((f) => f.includes("Recommendations section has no content"))).toBe(true);
  });

  it("a heading that only appears inside a code fence does not satisfy the contract", () => {
    const content = completeReport({ summaryBody: "" }).replace(
      "## Summary\n\n",
      "## Summary\n\n```md\n## Summary\nplaceholder body\n```\n",
    );
    const sections = extractReportSections(stripInertLines(content), compileHeadingRe(undefined, "^#{1,4}\\s*(Summary)\\s*$"));
    // the fenced heading is stripped: only the real heading survives, with an
    // inert body → no content
    expect(sections.length).toBe(1);
    expect(checkDesignReviewReportSections(stripInertLines(content)).some((f) => f.includes("Summary section has no content"))).toBe(true);
  });

  it("section order is irrelevant (verdict first, summary last)", () => {
    const content = completeReport({ order: ["verdict", "recommendations", "issues", "summary"] });
    expect(checkDesignReviewReportSections(stripInertLines(content))).toEqual([]);
  });

  it("Chinese heading aliases satisfy the contract", () => {
    const content = [
      "# 设计评审报告",
      "",
      identityBlock(),
      "",
      "## 摘要",
      "",
      "已对照需求文档完成评审，计划范围与验收标准齐备。",
      "",
      "## 问题列表",
      "",
      "无",
      "",
      "## 修改建议",
      "",
      "保持各阶段回归清单。",
      "",
      "## 结论",
      "",
      "**设计评审: 通过**",
    ].join("\n");
    expect(checkDesignReviewReportSections(stripInertLines(content))).toEqual([]);
  });

  it("heading level, case and surrounding spaces are tolerated", () => {
    const content = completeReport()
      .replace("## Summary", "### summary ")
      .replace("## Recommendations", "# RECOMMENDATIONS");
    expect(checkDesignReviewReportSections(stripInertLines(content))).toEqual([]);
  });

  it("prose that merely mentions a section name is not a heading (anchored match)", () => {
    const content = completeReport().replace("## Summary\n\n", "Summary of everything below.\n\n");
    const failures = checkDesignReviewReportSections(stripInertLines(content));
    expect(failures.some((f) => f.startsWith("missing Summary section heading"))).toBe(true);
    // a sub-heading inside a section body belongs to that section's content
    const nested = completeReport({ summaryBody: "Assessment\n\n### Sub-point\n\nDetails." });
    expect(checkDesignReviewReportSections(stripInertLines(nested))).toEqual([]);
  });

  it("a custom issueHeadingPattern from the deployed verify.md drives the anchor", () => {
    const content = completeReport().replace("## Issues", "## Findings");
    // default anchor → Issues section is missing...
    expect(
      checkDesignReviewReportSections(stripInertLines(content)).some((f) =>
        f.startsWith("missing Issues section heading"),
      ),
    ).toBe(true);
    // ...but the contract-declared pattern resolves it
    const failures = checkDesignReviewReportSections(stripInertLines(content), {
      issueHeadingPattern: "^#{1,4}\\s*(Findings)\\s*$",
    });
    expect(failures.some((f) => f.startsWith("missing Issues"))).toBe(false);
    // an unusable pattern falls back to the default (fail-closed elsewhere)
    expect(compileHeadingRe("([unclosed", DEFAULT_ISSUE_HEADING_PATTERN).source).toBe(
      DEFAULT_ISSUE_HEADING_PATTERN,
    );
  });

  it("extractReportSection returns the FIRST match; the multi-form sees all", () => {
    const lines = stripInertLines(completeReport({ issuesBody: "1. A\n\n## Issues\n\n2. B" }));
    const re = compileHeadingRe(undefined, DEFAULT_ISSUE_HEADING_PATTERN);
    expect(extractReportSections(lines, re).length).toBe(2);
    expect(extractReportSection(lines, re)?.headingIndex).toBe(
      lines.findIndex((l) => l.trim() === "## Issues"),
    );
  });
});

describe("193 Phase 0: sentinel and verdict semantics on a complete report", () => {
  it("explicit 'None' sentinel PASS is a trustworthy pass", () => {
    const v = verifyDesignReviewReportSnapshot(completeReport(), EXPECTATION);
    expect(v.verdict).toBe("pass");
  });

  it("exact sentinel aliases '无'/'N/A' count as no-issues", () => {
    for (const sentinel of ["None", "无", "N/A", "not applicable", "**none**"]) {
      const content = completeReport({ issuesBody: sentinel });
      const v = verifyDesignReviewReportSnapshot(content, EXPECTATION);
      expect([sentinel, v.verdict]).toEqual([sentinel, "pass"]);
    }
  });

  it("'None' as a bare item among real issues still FAILs", () => {
    const v = verifyDesignReviewReportSnapshot(
      completeReport({ verdict: "FAIL", issuesBody: "None\n1. Concrete defect." }),
      EXPECTATION,
    );
    expect(v.verdict).toBe("fail");
    if (v.verdict === "fail") expect(v.issues.length).toBe(1);
  });

  it("PASS with a masked non-sentinel Issues body is never a pass", () => {
    // the body is substantive prose WITHOUT the sentinel → the prose itself is
    // a valid issue item → issues take precedence, never a pass
    const v = verifyDesignReviewReportSnapshot(
      completeReport({ issuesBody: "### Reviewed\n\nsee above" }),
      EXPECTATION,
    );
    expect(v.verdict).toBe("fail");
    if (v.verdict === "fail") {
      expect(v.reason).toContain("valid issues present");
    }
  });

  it("valid issues take precedence over a PASS conclusion", () => {
    const v = verifyDesignReviewReportSnapshot(
      completeReport({ verdict: "PASS", issuesBody: "1. Blocking defect." }),
      EXPECTATION,
    );
    expect(v.verdict).toBe("fail");
    if (v.verdict === "fail") {
      expect(v.reason).toContain("issues take precedence over PASS conclusion");
      expect(v.issues.map((i) => i.text)).toEqual(["Blocking defect."]);
    }
  });

  it("FAIL with substantive issues keeps every issue", () => {
    const v = verifyDesignReviewReportSnapshot(
      completeReport({ verdict: "FAIL", issuesBody: "1. A\n2. B\n- C" }),
      EXPECTATION,
    );
    expect(v.verdict).toBe("fail");
    if (v.verdict === "fail") expect(v.issues.length).toBe(3);
  });

  it("mutually exclusive PASS and FAIL conclusions are invalid", () => {
    const v = verifyDesignReviewReportSnapshot(
      completeReport({ verdict: "PASS", issuesBody: "None" }) +
        "\n**Design Review: FAIL**\n",
      EXPECTATION,
    );
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" ")).toContain("mutually exclusive PASS and FAIL conclusions");
    }
  });

  it("no recognized verdict line is invalid (not a default pass)", () => {
    // Verdict section carries substantive prose but NO anchored conclusion
    // line → the domain verdict cannot be decided → invalid.
    const content = completeReport({ verdict: "PASS" }).replace(
      "**Design Review: PASS**",
      "The reviewer will confirm the final conclusion later.",
    );
    const v = verifyDesignReviewReportSnapshot(content, EXPECTATION);
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" ")).toContain("no recognized verdict conclusion line");
    }
  });

  it("a verdict word in Summary prose is NOT a conclusion line (anchored)", () => {
    const content = completeReport({ summaryBody: "The word PASS here is prose. Design Review is fine." });
    const v = verifyDesignReviewReportSnapshot(content, EXPECTATION);
    expect(v.verdict).toBe("pass"); // canonical verdict row still decides
  });

  it("unknown verdict token from the contract pattern is invalid", () => {
    const content = completeReport().replace("**Design Review: PASS**", "VERDICT>>MAYBE<<");
    const v = verifyDesignReviewReportSnapshot(content, EXPECTATION, {
      verdictPatterns: ["VERDICT>>([A-Z]+)<<"],
    });
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" ")).toContain('unknown verdict token "MAYBE"');
    }
  });

  it("invalid verdict pattern in the contract is fail-closed", () => {
    const v = verifyDesignReviewReportSnapshot(completeReport(), EXPECTATION, {
      verdictPatterns: ["([unclosed"],
    });
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" ")).toContain("invalid verdict pattern");
    }
  });

  it("inert verdict lines (fence / blockquote / comment) never decide", () => {
    const content = completeReport({ issuesBody: "None" }) +
      "\n```\n**Design Review: FAIL**\n```\n\n> **Design Review: FAIL**\n\n" +
      "<!-- **Design Review: FAIL** -->\n";
    const v = verifyDesignReviewReportSnapshot(content, EXPECTATION);
    expect(v.verdict).toBe("pass");
  });
});

describe("193 Phase 0: verifier applies identity → structure → verdict in order", () => {
  it("identity mismatch is reported before structure defects", () => {
    const content = completeReport({
      identity: identityBlock().replace(PIPELINE_ID, "pipe-other-000"),
    }).replace("## Summary", "## Notes");
    const v = verifyDesignReviewReportSnapshot(content, EXPECTATION);
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" ")).toContain("pipeline identity mismatch");
      // structure is NOT even evaluated once identity fails
      expect(v.failures.join(" ")).not.toContain("missing Summary");
    }
  });

  it("identity ambiguity beats value comparison", () => {
    const content = completeReport({
      identity: identityBlock() + `\n**pipeline**: pipe-forged`,
    });
    const v = verifyDesignReviewReportSnapshot(content, EXPECTATION);
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" ")).toContain("ambiguous");
    }
  });

  it("plan basename reuse for a DIFFERENT document is a mismatch (canonical path)", () => {
    const content = completeReport({
      identity: identityBlock().replace(PLAN_DOC, `/other/${PLAN_DOC.split("/").pop()}`),
    });
    const v = verifyDesignReviewReportSnapshot(content, EXPECTATION);
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join(" ")).toContain("different plan document");
    }
  });

  it("stale round / foreign operation / drifted input hash are all mismatches", () => {
    const cases: Array<[string, string]> = [
      [identityBlock().replace("**round**: 1", "**round**: 2"), "round identity mismatch"],
      [identityBlock().replace(OP_ID, "op-other-99"), "different review operation"],
      [identityBlock().replace(INPUT_HASH, "b".repeat(64)), "different plan version"],
    ];
    for (const [identity, needle] of cases) {
      const v = verifyDesignReviewReportSnapshot(completeReport({ identity }), EXPECTATION);
      expect(v.verdict).toBe("invalid");
      if (v.verdict === "invalid") {
        expect(v.failures.join(" ")).toContain(needle);
      }
    }
  });

  it("structure is checked only after identity passes, verdict only after structure", () => {
    const brokenStructure = completeReport({ issuesBody: "" }); // Issues present, empty
    const v1 = verifyDesignReviewReportSnapshot(brokenStructure, EXPECTATION);
    expect(v1.verdict).toBe("invalid");
    if (v1.verdict === "invalid") {
      expect(v1.failures.join(" ")).toContain("Issues section has no content");
    }
    // With structure fixed, the same content reaches the verdict stage
    const v2 = verifyDesignReviewReportSnapshot(completeReport(), EXPECTATION);
    expect(v2.verdict).toBe("pass");
  });

  it("legacy mode (no operation binding) skips operation/input-hash comparison", () => {
    const identity = [
      `**pipeline**: ${PIPELINE_ID}`,
      `**plan**: ${PLAN_DOC}`,
      `**round**: 1`,
    ].join("\n");
    const content = [
      "# Design Review Report",
      "",
      identity,
      "",
      "## Summary",
      "",
      "Complete assessment text.",
      "",
      "## Issues",
      "",
      "None",
      "",
      "## Recommendations",
      "",
      "Proceed as planned.",
      "",
      "## Verdict",
      "",
      "**Design Review: PASS**",
    ].join("\n");
    const v = verifyDesignReviewReportSnapshot(content, {
      pipelineId: PIPELINE_ID,
      planDoc: PLAN_DOC,
      round: 1,
    });
    expect(v.verdict).toBe("pass");
  });

  it("reportHash binds the exact bytes for both pass and invalid verdicts", () => {
    const content = completeReport();
    const pass = verifyDesignReviewReportSnapshot(content, EXPECTATION);
    const again = verifyDesignReviewReportSnapshot(content, EXPECTATION);
    // same snapshot → same hash (stable identity of the reviewed bytes)
    if (pass.verdict !== "invalid" && again.verdict !== "invalid") {
      expect(pass.reportHash).toBe(again.reportHash);
    }
    // tampered snapshot (even an identity-only edit) → different hash
    const invalid = verifyDesignReviewReportSnapshot(content.replace(PIPELINE_ID, "x"), EXPECTATION);
    expect(invalid.verdict).toBe("invalid");
    if (invalid.verdict === "invalid" && pass.verdict !== "invalid") {
      expect(invalid.reportHash).toBeDefined();
      expect(invalid.reportHash).not.toBe(pass.reportHash);
    }
  });
});
