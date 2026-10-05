import { describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import { verifyDesignReviewReport } from "../../core/design-review-report";
import { renderDesignReviewUpdatePrompt } from "../../core/design-review-prompt";

describe("Phase 1: Design Review Report Verification", () => {
  const testDir = "/tmp/pi-pipeline-test-design-review-phase1";
  
  // Test verdict patterns matching verify.md contract (runtime: verdict)
  const TEST_VERDICT_PATTERNS = [
    "结论\\s*[:：]\\s*[*_]{0,2}(不通过|通过)[*_]{0,2}",
    "Verdict\\s*[:：]\\s*[*_]{0,2}(PASS|FAIL)[*_]{0,2}",
    "Conclusion\\s*[:：]\\s*[*_]{0,2}(pass|fail)[*_]{0,2}",
    "\\*\\*Design Review:\\s*(PASS|FAIL)\\*\\*",
    "\\*\\*设计评审[:：]\\s*(通过|不通过)\\*\\*",
  ];

  test("should return pass for valid PASS report", async () => {
    const reportPath = path.join(testDir, "report-pass.md");
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(
      reportPath,
      `# Design Review Report

**pipeline**: test-pipeline-123
**plan**: docs/plan.md
**round**: 1
**operationId**: op-123
**baselinePlanHash**: abc123

## Summary

The plan is well-structured and complete.

## Issues

None

## Recommendations

Proceed with implementation.

## Verdict

**Design Review: PASS**

All requirements are addressed.`,
      "utf-8"
    );

    const result = verifyDesignReviewReport(reportPath, "docs/plan.md", 1);
    expect(result.verdict).toBe("pass");
    expect(result.reason).toContain("clear PASS verdict");
    expect(result.reportHash).toBeDefined();
  });

  test("should return fail for report with critical issues", async () => {
    const reportPath = path.join(testDir, "report-fail.md");
    await fs.writeFile(
      reportPath,
      `# Design Review Report

**pipeline**: test-pipeline-456
**plan**: docs/plan.md
**round**: 1
**operationId**: op-456
**baselinePlanHash**: def456

## Summary

The plan has significant gaps.

## Issues

- Missing error handling strategy
- No security considerations
- Incomplete API design

## Recommendations

Revise the plan to address critical issues.

## Verdict

**Design Review: FAIL**

Critical issues must be resolved.`,
      "utf-8"
    );

    const result = verifyDesignReviewReport(reportPath, "docs/plan.md", 1);
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("issue(s) requiring fix");
  });

  test("should return invalid for missing pipeline field", async () => {
    const reportPath = path.join(testDir, "report-no-pipeline.md");
    await fs.writeFile(
      reportPath,
      `# Design Review Report

**plan**: docs/plan.md
**round**: 1

## Summary

Missing pipeline field.

## Verdict

**Design Review: PASS**`,
      "utf-8"
    );

    const result = verifyDesignReviewReport(reportPath, "docs/plan.md", 1);
    expect(result.verdict).toBe("invalid");
    expect(result.reason).toContain("validation failed");
  });

  test("should return invalid for missing verdict", async () => {
    const reportPath = path.join(testDir, "report-no-verdict.md");
    await fs.writeFile(
      reportPath,
      `# Design Review Report

**pipeline**: test-pipeline-999
**plan**: docs/plan.md
**round**: 1

## Summary

Missing verdict section.`,
      "utf-8"
    );

    const result = verifyDesignReviewReport(reportPath, "docs/plan.md", 1);
    expect(result.verdict).toBe("invalid");
    expect(result.reason).toContain("lacks clear PASS/FAIL verdict");
  });

  test("should support bilingual verdict formats", async () => {
    const reportPath = path.join(testDir, "report-bilingual.md");
    await fs.writeFile(
      reportPath,
      `# Design Review Report

**pipeline**: test-pipeline-bi
**plan**: docs/plan.md
**round**: 1
**operationId**: op-bi
**baselinePlanHash**: ghi789

## Summary

Bilingual support test.

## Issues

None

## Verdict

**设计评审：通过**

计划完整。`,
      "utf-8"
    );

    const result = verifyDesignReviewReport(reportPath, "docs/plan.md", 1);
    expect(result.verdict).toBe("pass");
  });

  test("should handle report with code blocks in issues", async () => {
    const reportPath = path.join(testDir, "report-codeblock.md");
    await fs.writeFile(
      reportPath,
      `# Design Review Report

**pipeline**: test-pipeline-cb
**plan**: docs/plan.md
**round**: 1
**operationId**: op-cb
**baselinePlanHash**: jkl012

## Summary

Issues with code examples.

## Issues

Missing implementation for:

\`\`\`typescript
function example() {
  // code here
}
\`\`\`

## Verdict

**Design Review: FAIL**`,
      "utf-8"
    );

    const result = verifyDesignReviewReport(reportPath, "docs/plan.md", 1);
    expect(result.verdict).toBe("fail");
  });

  test("should return invalid for non-existent report", async () => {
    const result = verifyDesignReviewReport("/non/existent/report.md", "docs/plan.md", 1);
    expect(result.verdict).toBe("invalid");
    expect(result.reason).toContain("does not exist");
  });

  test("should return invalid for empty report", async () => {
    const reportPath = path.join(testDir, "report-empty.md");
    await fs.writeFile(reportPath, "", "utf-8");

    const result = verifyDesignReviewReport(reportPath, "docs/plan.md", 1);
    expect(result.verdict).toBe("invalid");
    expect(result.reason).toContain("validation failed");
  });

  test("H-1 regression: PASS + non-empty issues → fail (issues take priority)", async () => {
    const reportPath = path.join(testDir, "report-pass-with-issues.md");
    await fs.writeFile(
      reportPath,
      `# Design Review Report

**pipeline**: test-pipeline-789
**plan**: docs/plan.md
**round**: 1
**operationId**: op-789
**baselinePlanHash**: ghi789

## Summary

The plan addresses most requirements.

## Issues

1. Missing error handling in API endpoints
2. No logging for critical operations

## Verdict

**Design Review: PASS**

All requirements are met.`,
      "utf-8"
    );

    const result = verifyDesignReviewReport(reportPath, "docs/plan.md", 1, TEST_VERDICT_PATTERNS);
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("issue(s) requiring fix");
    expect(result.reason).toContain("issues take priority");
  });

  test("H-1 regression: Both PASS and FAIL → invalid (mutually exclusive)", async () => {
    const reportPath = path.join(testDir, "report-conflict.md");
    await fs.writeFile(
      reportPath,
      `# Design Review Report

**pipeline**: test-pipeline-101
**plan**: docs/plan.md
**round**: 1
**operationId**: op-101
**baselinePlanHash**: jkl101

## Summary

Conflicting verdicts present.

## Verdict

**Design Review: PASS**

But also:

**Design Review: FAIL**`,
      "utf-8"
    );

    const result = verifyDesignReviewReport(reportPath, "docs/plan.md", 1, TEST_VERDICT_PATTERNS);
    expect(result.verdict).toBe("invalid");
    expect(result.reason).toContain("both PASS and FAIL");
  });

  test("H-1 regression: Verdict in code block should be ignored", async () => {
    const reportPath = path.join(testDir, "report-codeblock.md");
    await fs.writeFile(
      reportPath,
      `# Design Review Report

**pipeline**: test-pipeline-102
**plan**: docs/plan.md
**round**: 1
**operationId**: op-102
**baselinePlanHash**: mno102

## Summary

Example of format.

## Verdict

\`\`\`
**Design Review: PASS**
\`\`\`

Actual verdict: **Design Review: FAIL**`,
      "utf-8"
    );

    const result = verifyDesignReviewReport(reportPath, "docs/plan.md", 1, TEST_VERDICT_PATTERNS);
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("clear FAIL verdict");
  });

  test("H-1 regression: Verdict in blockquote should be ignored", async () => {
    const reportPath = path.join(testDir, "report-blockquote.md");
    await fs.writeFile(
      reportPath,
      `# Design Review Report

**pipeline**: test-pipeline-103
**plan**: docs/plan.md
**round**: 1
**operationId**: op-103
**baselinePlanHash**: pqr103

## Summary

Quoted example.

## Verdict

> **Design Review: PASS**

Actual verdict: **Design Review: FAIL**`,
      "utf-8"
    );

    const result = verifyDesignReviewReport(reportPath, "docs/plan.md", 1, TEST_VERDICT_PATTERNS);
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("clear FAIL verdict");
  });
});

describe("Phase 1: Update Prompt Rendering", () => {
  const testDir = "/tmp/pi-pipeline-test-design-review-phase1";

  test("should render update prompt with all placeholders", async () => {
    await fs.mkdir(testDir, { recursive: true });
    const templatePath = path.join(testDir, "update-template.md");
    const template = `Please update the plan based on the following review:

Pipeline: {{pipelineId}}
Plan: {{planDoc}}
Review Report: {{reviewDoc}}
Round: {{round}}
Operation ID: {{operationId}}
Baseline Hash: {{baselinePlanHash}}

Issues to address:
{{issues}}

Please modify the plan file to address these issues.`;

    await fs.writeFile(templatePath, template, "utf-8");

    const params = {
      pipelineId: "test-pipeline-123",
      planDoc: "docs/plan.md",
      reviewDoc: "docs/review-1.md",
      round: 2,
      operationId: "op-123",
      baselinePlanHash: "abc123",
      issues: ["Issue 1", "Issue 2", "Issue 3"],
    };

    const rendered = renderDesignReviewUpdatePrompt(templatePath, params);
    expect(rendered).toContain("test-pipeline-123");
    expect(rendered).toContain("docs/plan.md");
    expect(rendered).toContain("docs/review-1.md");
    expect(rendered).toContain("Round: 2");
    expect(rendered).toContain("op-123");
    expect(rendered).toContain("abc123");
    expect(rendered).toContain("1. Issue 1");
    expect(rendered).not.toContain("{{");
  });

  test("should handle empty issues list", async () => {
    const templatePath = path.join(testDir, "update-template-empty.md");
    const template = `Pipeline: {{pipelineId}}
Plan: {{planDoc}}
Issues: {{issues}}`;

    await fs.writeFile(templatePath, template, "utf-8");

    const params = {
      pipelineId: "test-pipeline",
      planDoc: "docs/plan.md",
      reviewDoc: "docs/review.md",
      round: 1,
      operationId: "op-test",
      baselinePlanHash: "hash123",
      issues: [],
    };

    const rendered = renderDesignReviewUpdatePrompt(templatePath, params);
    expect(rendered).toContain("test-pipeline");
    expect(rendered).toContain("docs/plan.md");
    expect(rendered).toContain("No issues found.");
  });

  test("should preserve template structure", async () => {
    const templatePath = path.join(testDir, "update-template-structure.md");
    const template = `# Design Review Update Request

## Context
- Pipeline: {{pipelineId}}
- Plan: {{planDoc}}
- Round: {{round}}

## Instructions
Please update the plan to address the issues identified in round {{round}}.`;

    await fs.writeFile(templatePath, template, "utf-8");

    const params = {
      pipelineId: "pipeline-xyz",
      planDoc: "path/to/plan.md",
      reviewDoc: "path/to/review.md",
      round: 3,
      operationId: "op-xyz",
      baselinePlanHash: "hash456",
      issues: ["Issue A"],
    };

    const rendered = renderDesignReviewUpdatePrompt(templatePath, params);
    expect(rendered).toContain("# Design Review Update Request");
    expect(rendered).toContain("## Context");
    expect(rendered).toContain("## Instructions");
    expect(rendered).toContain("Round: 3");
    expect(rendered).toContain("round 3");
  });

  test("should throw error for missing required parameters", async () => {
    const templatePath = path.join(testDir, "update-template-missing.md");
    const template = `Pipeline: {{pipelineId}}`;
    await fs.writeFile(templatePath, template, "utf-8");

    const params = {
      pipelineId: "",
      planDoc: "docs/plan.md",
      reviewDoc: "docs/review.md",
      round: 1,
      operationId: "op-test",
      baselinePlanHash: "hash123",
      issues: [],
    };

    expect(() => renderDesignReviewUpdatePrompt(templatePath, params)).toThrow(
      "Missing required parameters"
    );
  });

  test("should throw error for non-existent template file", () => {
    const params = {
      pipelineId: "test-pipeline",
      planDoc: "docs/plan.md",
      reviewDoc: "docs/review.md",
      round: 1,
      operationId: "op-test",
      baselinePlanHash: "hash123",
      issues: [],
    };

    expect(() =>
      renderDesignReviewUpdatePrompt("/non/existent/template.md", params)
    ).toThrow("template not found");
  });
});
