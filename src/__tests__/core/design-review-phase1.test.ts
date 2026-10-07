/**
 * 192 fix (issue 3) REWRITE.
 *
 * The parallel weak implementations this file used to exercise are RETIRED per
 * plan Phase 0 task 2 / Phase 3 tasks 4 & 10 ("report semantics migrated into
 * verifiers — no parallel old implementation"):
 *   - report.ts `verifyDesignReviewReport` + `validateReportStructure`
 *     (basename matching, first-20/500-char structure heuristics, "none"/"无"
 *     substring filtering);
 *   - prompt.ts file-based `renderDesignReviewUpdatePrompt` adapter.
 *
 * These successor tests are equal-or-stronger (never weakened) against the
 * SINGLE production contract:
 *   A. verifyDesignReviewReportSnapshot — identity, issues-precedence,
 *      mutually-exclusive verdicts, inert-content exclusion, bilingual forms,
 *      exact sha256 reportHash, missing-field fail-closed;
 *   B. extractReportIssues — now delegates to the SAME domain extraction
 *      (fenced code never counts as an issue, exact sentinels only);
 *   C. I/O boundary via runVerification — an absent/unreadable report yields
 *      an explicit `invalid` domain outcome, never a silent pass;
 *   D. renderDesignReviewUpdatePromptText — token contract with exact values,
 *      "No issues found." for empty issues, fail-closed on missing params.
 *   (The retired adapter's "missing template FILE" error case is superseded by
 *   design-review-update-config.test.ts: the Markdown file is not a runtime
 *   source at all, and deleting it cannot affect selection.)
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  verifyDesignReviewReportSnapshot,
  extractDesignReviewIssueItems,
} from "../../core/verifiers/design-review-verifier";
import { extractReportIssues } from "../../core/design-review/report";
import {
  renderDesignReviewUpdatePromptText,
  DesignReviewUpdateConfigError,
} from "../../core/design-review/prompt";
import { runVerification } from "../../core/auto-verifier";
import {
  createInitialState,
  computeHash,
  deriveReportPath,
} from "../../core/design-review/state";
import {
  makeTestConfig,
  makeTestMeta,
  reviewReportContent,
  boundReviewOperation,
} from "../helpers";

const OP_ID = "op-phase1-successor-1";

/**
 * Build a report body in the SHIPPED template label form
 * (**operationId** / **baselinePlanHash**) — the retired weak parser could
 * only be satisfied by loose forms; the domain verifier accepts the canonical
 * labels, so successor fixtures use them.
 */
function templateFormReport(opts: {
  pipelineId: string;
  planDoc: string;
  round: number;
  operationId: string;
  inputHash: string;
  verdictRow: string;
  issueItems?: string[];
  extraLines?: string[];
}): string {
  const issues = opts.issueItems ?? [];
  return [
    "# Design Review Report",
    "",
    `**pipeline**: ${opts.pipelineId}`,
    `**plan**: ${opts.planDoc}`,
    `**round**: ${opts.round}`,
    `**operationId**: ${opts.operationId}`,
    `**baselinePlanHash**: ${opts.inputHash}`,
    "",
    "## Summary",
    "",
    "Reviewed.",
    "",
    "## Issues",
    "",
    ...(issues.length > 0 ? issues.map((i, idx) => `${idx + 1}. ${i}`) : ["None"]),
    "",
    "## Verdict",
    "",
    opts.verdictRow,
    ...(opts.extraLines ?? []),
    "",
    // 193 Phase 0: Recommendations is part of the complete-report contract.
    "## Recommendations",
    "",
    "Proceed with the plan as written.",
    "",
  ].join("\n");
}

function expectation(planDoc: string, round = 1) {
  return {
    pipelineId: "pipe-test-001",
    planDoc,
    round,
    operationId: OP_ID,
    inputHash: "a".repeat(64),
  };
}

describe("Phase 1 successor A: domain snapshot verdict (single contract)", () => {
  test("valid PASS report → pass with EXACT sha256 hash and no issues", () => {
    const planDoc = "/abs/docs/plan.md";
    const content = templateFormReport({
      pipelineId: "pipe-test-001",
      planDoc,
      round: 1,
      operationId: OP_ID,
      inputHash: "a".repeat(64),
      verdictRow: "**Design Review: PASS**",
    });
    const v = verifyDesignReviewReportSnapshot(content, expectation(planDoc));
    if (v.verdict !== "pass") throw new Error(`expected pass, got ${v.verdict}: ${JSON.stringify(v)}`);
    expect(v.reportHash).toBe(computeHash(content));
    expect(v.issues).toEqual([]);
  });

  test("report with critical issues → fail carrying every issue with stable ids", () => {
    const planDoc = "/abs/docs/plan.md";
    const content = templateFormReport({
      pipelineId: "pipe-test-001",
      planDoc,
      round: 1,
      operationId: OP_ID,
      inputHash: "a".repeat(64),
      verdictRow: "**Design Review: FAIL**",
      issueItems: [
        "Missing error handling strategy",
        "No security considerations",
        "Incomplete API design",
      ],
    });
    const v = verifyDesignReviewReportSnapshot(content, expectation(planDoc));
    if (v.verdict !== "fail") throw new Error(`expected fail, got ${v.verdict}`);
    // Stronger than the old reason-string check: exact issue ids + texts
    expect(v.issues.map((i) => i.issueId)).toEqual(["1", "2", "3"]);
    expect(v.issues.map((i) => i.text)).toEqual([
      "Missing error handling strategy",
      "No security considerations",
      "Incomplete API design",
    ]);
  });

  test("missing **pipeline** row → invalid naming the missing identity field", () => {
    const planDoc = "/abs/docs/plan.md";
    const content = [
      "# Design Review Report",
      "",
      `**plan**: ${planDoc}`,
      "**round**: 1",
      "",
      "## Issues",
      "",
      "None",
      "",
      "## Verdict",
      "",
      "**Design Review: PASS**",
    ].join("\n");
    const v = verifyDesignReviewReportSnapshot(content, {
      pipelineId: "pipe-test-001",
      planDoc,
      round: 1,
    });
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join("; ")).toContain("missing **pipeline**");
    }
  });

  test("no conclusion line → invalid (never defaults to pass)", () => {
    const planDoc = "/abs/docs/plan.md";
    const content = [
      "# Design Review Report",
      "",
      `**pipeline**: pipe-test-001`,
      `**plan**: ${planDoc}`,
      "**round**: 1",
      `**operationId**: ${OP_ID}`,
      `**baselinePlanHash**: ${"a".repeat(64)}`,
      "",
      "## Summary",
      "",
      "No verdict here.",
      "",
      // 193 Phase 0: the Verdict section EXISTS but carries no canonical
      // conclusion row, so the defect is exactly the unrecognised conclusion.
      "## Verdict",
      "",
      "The reviewers discussed the trade-offs at length.",
      "",
      "## Issues",
      "",
      "None",
      "",
      "## Recommendations",
      "",
      "Record an explicit conclusion next round.",
    ].join("\n");
    const v = verifyDesignReviewReportSnapshot(content, expectation(planDoc));
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join("; ")).toContain("no recognized verdict conclusion line");
    }
  });

  test("bilingual 设计评审：通过 is a canonical PASS form", () => {
    const planDoc = "/abs/docs/plan.md";
    const content = templateFormReport({
      pipelineId: "pipe-test-001",
      planDoc,
      round: 1,
      operationId: OP_ID,
      inputHash: "a".repeat(64),
      verdictRow: "**设计评审：通过**",
    });
    const v = verifyDesignReviewReportSnapshot(content, expectation(planDoc));
    expect(v.verdict).toBe("pass");
  });

  test("empty report → invalid listing the missing identity fields", () => {
    const planDoc = "/abs/docs/plan.md";
    const v = verifyDesignReviewReportSnapshot("", expectation(planDoc));
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join("; ")).toContain("missing **pipeline**");
      expect(v.failures.join("; ")).toContain("missing **plan**");
      expect(v.failures.join("; ")).toContain("missing **round**");
    }
  });

  test("regression H-1: PASS + non-empty issues → fail (issues take precedence)", () => {
    const planDoc = "/abs/docs/plan.md";
    const content = templateFormReport({
      pipelineId: "pipe-test-001",
      planDoc,
      round: 1,
      operationId: OP_ID,
      inputHash: "a".repeat(64),
      verdictRow: "**Design Review: PASS**",
      issueItems: [
        "Missing error handling in API endpoints",
        "No logging for critical operations",
      ],
    });
    const v = verifyDesignReviewReportSnapshot(content, expectation(planDoc));
    if (v.verdict !== "fail") throw new Error(`expected fail, got ${v.verdict}`);
    expect(v.reason).toContain("issues take precedence");
    expect(v.issues).toHaveLength(2);
  });

  test("regression H-1: mutually exclusive PASS and FAIL → invalid", () => {
    const planDoc = "/abs/docs/plan.md";
    const content = templateFormReport({
      pipelineId: "pipe-test-001",
      planDoc,
      round: 1,
      operationId: OP_ID,
      inputHash: "a".repeat(64),
      verdictRow: "**Design Review: PASS**",
      extraLines: ["", "**Design Review: FAIL**"],
    });
    const v = verifyDesignReviewReportSnapshot(content, expectation(planDoc));
    expect(v.verdict).toBe("invalid");
    if (v.verdict === "invalid") {
      expect(v.failures.join("; ")).toContain("mutually exclusive");
    }
  });

  test("regression H-1: verdict inside a fenced code block is inert; real FAIL counts", () => {
    const planDoc = "/abs/docs/plan.md";
    const content = templateFormReport({
      pipelineId: "pipe-test-001",
      planDoc,
      round: 1,
      operationId: OP_ID,
      inputHash: "a".repeat(64),
      issueItems: ["Real defect"],
      verdictRow: "```",
      extraLines: [
        "**Design Review: PASS**",
        "```",
        "",
        "**Design Review: FAIL**",
      ],
    });
    const v = verifyDesignReviewReportSnapshot(content, expectation(planDoc));
    if (v.verdict !== "fail") throw new Error(`expected fail, got ${v.verdict}`);
    // Fenced PASS line never became a candidate → no mutual-exclusion invalid
    expect(v.issues.map((i) => i.text)).toEqual(["Real defect"]);
  });

  test("regression H-1: verdict echoed in a blockquote is inert", () => {
    const planDoc = "/abs/docs/plan.md";
    const content = templateFormReport({
      pipelineId: "pipe-test-001",
      planDoc,
      round: 1,
      operationId: OP_ID,
      inputHash: "a".repeat(64),
      issueItems: ["Real defect"],
      verdictRow: "> **Design Review: PASS**",
      extraLines: ["", "**Design Review: FAIL**"],
    });
    const v = verifyDesignReviewReportSnapshot(content, expectation(planDoc));
    if (v.verdict !== "fail") throw new Error(`expected fail, got ${v.verdict}`);
  });
});

describe("Phase 1 successor B: extractReportIssues on canonical domain semantics", () => {
  let dir: string;
  test("scans only the Issues section; fenced code never counts as an issue", () => {
    dir = fs.mkdtempSync(path.join(tmpdir(), "dr-phase1-b-"));
    const planDoc = path.join(dir, "plan.md");
    const reportPath = deriveReportPath(planDoc, 1);
    // A fenced block INSIDE the Issues section whose lines look like list
    // items must be inert (the retired weak parser counted some of them).
    const withFence = [
      "# Design Review Report",
      "",
      `**pipeline**: pipe-test-001`,
      `**plan**: ${planDoc}`,
      "**round**: 1",
      `**operationId**: ${OP_ID}`,
      `**baselinePlanHash**: ${"a".repeat(64)}`,
      "",
      "## Issues",
      "",
      "1. Missing implementation for the intake API",
      "",
      "```typescript",
      "1. function example() {} // looks like an item but is INERT",
      "```",
      "",
      "## Verdict",
      "",
      "**Design Review: FAIL**",
      "",
    ].join("\n");
    fs.writeFileSync(reportPath, withFence, "utf-8");
    const issues = extractReportIssues(reportPath);
    expect(issues).toEqual(["Missing implementation for the intake API"]);
    expect(issues.some((i) => i.includes("function example()"))).toBe(false);
  });

  test("exact 'None' sentinel → no issues; '无法恢复…' stays a real issue", () => {
    const p = path.join(dir, "review-design-2-plan.md");
    fs.writeFileSync(
      p,
      templateFormReport({
        pipelineId: "pipe-test-001",
        planDoc: path.join(dir, "plan.md"),
        round: 2,
        operationId: OP_ID,
        inputHash: "a".repeat(64),
        verdictRow: "**Design Review: PASS**",
      }),
      "utf-8",
    );
    expect(extractReportIssues(p)).toEqual([]);

    const p2 = path.join(dir, "review-design-3-plan.md");
    fs.writeFileSync(
      p2,
      templateFormReport({
        pipelineId: "pipe-test-001",
        planDoc: path.join(dir, "plan.md"),
        round: 3,
        operationId: OP_ID,
        inputHash: "a".repeat(64),
        verdictRow: "**Design Review: FAIL**",
        issueItems: ["无法恢复该状态，需要重新设计"],
      }),
      "utf-8",
    );
    expect(extractReportIssues(p2)).toEqual(["无法恢复该状态，需要重新设计"]);
  });

  test("absent report → empty array (I/O shim contract; strict identity checks reject downstream)", () => {
    expect(extractReportIssues(path.join(dir, "does-not-exist.md"))).toEqual([]);
  });

  test("extractReportIssues and the domain parser agree on the same file (one implementation)", () => {
    const p = path.join(dir, "review-design-4-plan.md");
    const content = templateFormReport({
      pipelineId: "pipe-test-001",
      planDoc: path.join(dir, "plan.md"),
      round: 4,
      operationId: OP_ID,
      inputHash: "a".repeat(64),
      verdictRow: "**Design Review: FAIL**",
      issueItems: ["Defect one", "Defect two"],
    });
    fs.writeFileSync(p, content, "utf-8");
    const viaShim = extractReportIssues(p);
    const viaDomain = extractDesignReviewIssueItems(fs.readFileSync(p, "utf-8")).map((i) => i.text);
    expect(viaShim).toEqual(viaDomain);
    expect(viaShim).toEqual(["Defect one", "Defect two"]);
  });
});

describe("Phase 1 successor C: I/O boundary — unreadable report is an explicit invalid domain outcome", () => {
  let projectRoot: string;
  let planDoc: string;
  let planHash: string;

  const setup = () => {
    projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-phase1-c-"));
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    planDoc = path.join(projectRoot, "docs", "190_Feat_plan.md");
    fs.writeFileSync(planDoc, "# Plan\ncontent\n", "utf-8");
    planHash = computeHash(fs.readFileSync(planDoc, "utf-8"));
  };

  test("review_running with the report DELETED → invalid + report unreadable (never a silent pass)", async () => {
    setup();
    // Report exists and is valid first (identity bound), then is removed:
    // the domain path must produce an explicit invalid failure for the run.
    fs.writeFileSync(
      deriveReportPath(planDoc, 1),
      reviewReportContent({
        pipelineId: "pipe-test-001",
        planDoc,
        round: 1,
        operationId: OP_ID,
        inputHash: planHash,
        verdict: "PASS",
      }),
      "utf-8",
    );
    const base = createInitialState(planDoc, "menu", planHash, undefined, {
      pipelineId: "pipe-test-001",
    });
    const meta = makeTestMeta({
      currentStage: "design-review",
      designReview: {
        ...base,
        phase: "review_running",
        round: 1,
        operation: boundReviewOperation(OP_ID, planHash),
      },
    });
    fs.rmSync(deriveReportPath(planDoc, 1));

    const config = makeTestConfig({ projectRoot });
    const vr = await runVerification(config, meta, []);
    expect(vr.designReviewOutcome?.kind).toBe("invalid");
    if (vr.designReviewOutcome?.kind === "invalid") {
      expect(vr.designReviewOutcome.failures.some((f) => /unreadable/.test(f.detail))).toBe(true);
    }
  });
});

describe("Phase 1 successor D: update prompt rendering (single token contract)", () => {
  const params = {
    pipelineId: "test-pipeline-123",
    planDoc: "docs/plan with spaces.md",
    reviewDoc: "docs/review-1.md",
    round: 2,
    operationId: OP_ID,
    baselinePlanHash: "b".repeat(64),
    issues: ["Issue 1", "Issue 2", "Issue 3"],
  };

  test("renders every token exactly (double-brace form == single-brace form)", () => {
    const template = [
      "Pipeline: {{pipelineId}}",
      "Plan: {{planDoc}}",
      "Review Report: {{reviewDoc}}",
      "Round: {{round}}",
      "Operation ID: {{operationId}}",
      "Baseline Hash: {{baselinePlanHash}}",
      "",
      "Issues to address:",
      "{{issues}}",
    ].join("\n");
    const rendered = renderDesignReviewUpdatePromptText(template, params);
    expect(rendered).toContain("Pipeline: test-pipeline-123");
    expect(rendered).toContain("Plan: docs/plan with spaces.md");
    expect(rendered).toContain("Review Report: docs/review-1.md");
    expect(rendered).toContain("Round: 2");
    expect(rendered).toContain(`Operation ID: ${OP_ID}`);
    expect(rendered).toContain(`Baseline Hash: ${"b".repeat(64)}`);
    // Numbered issue list rendered exactly once per issue, stable order
    expect(rendered).toContain("1. Issue 1\n2. Issue 2\n3. Issue 3");
    expect(rendered).not.toContain("{{");
    // Single-brace form renders the SAME values
    const single = renderDesignReviewUpdatePromptText(
      template.replaceAll("{{", "{").replaceAll("}}", "}"),
      params,
    );
    expect(single).toBe(rendered);
  });

  test("empty issues render the explicit 'No issues found.' sentinel", () => {
    const rendered = renderDesignReviewUpdatePromptText("Issues: {{issues}}", {
      ...params,
      issues: [],
    });
    expect(rendered).toBe("Issues: No issues found.");
  });

  test("template structure survives rendering", () => {
    const template = [
      "# Design Review Update Request",
      "",
      "## Context",
      "- Pipeline: {{pipelineId}}",
      "- Plan: {{planDoc}}",
      "- Round: {{round}}",
      "",
      "## Instructions",
      "Please update the plan to address the issues identified in round {{round}}.",
    ].join("\n");
    const rendered = renderDesignReviewUpdatePromptText(template, { ...params, round: 3 });
    expect(rendered).toContain("# Design Review Update Request");
    expect(rendered).toContain("## Context");
    expect(rendered).toContain("## Instructions");
    expect(rendered).toContain("Round: 3");
    expect(rendered).toContain("round 3");
  });

  test("missing required params BLOCK fail-closed with typed error", () => {
    let err: unknown;
    try {
      renderDesignReviewUpdatePromptText("Pipeline: {{pipelineId}}", { ...params, pipelineId: "" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DesignReviewUpdateConfigError);
    expect((err as DesignReviewUpdateConfigError).code).toBe("missing-param");
    expect((err as Error).message).toContain("pipelineId");
  });

  test("unknown runtime tokens BLOCK (no silent leftovers)", () => {
    let err: unknown;
    try {
      renderDesignReviewUpdatePromptText("Hello {{nonexistentToken}}", params);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DesignReviewUpdateConfigError);
    expect((err as DesignReviewUpdateConfigError).code).toBe("unknown-token");
  });
});
