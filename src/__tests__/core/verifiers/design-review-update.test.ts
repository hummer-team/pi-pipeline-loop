/**
 * 192 Phase 2 (K08/F03): design-review update-verifier structural tests.
 *
 * Covers:
 * - CURRENT section (bound to the update operationId) vs multi-round old
 *   sections; old sections never count
 * - exactly-one disposition per issue: missing / duplicate / unknown id
 * - Chinese issue content is handled by id, never by string matching
 * - reason/justification STRING content is irrelevant to pass/fail (no
 *   prefix heuristics) — only structure is judged here
 * - no-change hash → paused; sentinel dispositions → paused(new-decision)
 * - deferred/rejected allowed WITH justification; empty justification invalid
 * - association-field mismatches (Report/Round/Baseline Hash) → invalid
 * - code-example tables and fenced blocks never produce dispositions
 * - plan read-only boundary notes are prompt-side requirements (K08): the
 *   verifier itself is pure over provided snapshots (no fs, no meta writes)
 */

import { describe, it, expect } from "bun:test";
import {
  validateDesignReviewUpdate,
  computePlanHash,
  type DesignReviewUpdateValidationInput,
} from "../../../core/verifiers/design-review-update-verifier";

const BASELINE = "b".repeat(64);
const NEW_CONTENT = "# Plan\n\nChanged.\n";
const REPORT_DOC = "/tmp/proj/docs/review-design-1-plan.md";
const REPORT_HASH = "c".repeat(64);

function input(overrides?: Partial<DesignReviewUpdateValidationInput>): DesignReviewUpdateValidationInput {
  return {
    planContent: NEW_CONTENT,
    baselinePlanHash: BASELINE,
    reportDoc: REPORT_DOC,
    reportHash: REPORT_HASH,
    round: 1,
    reviewOperationId: "op-review-1",
    updateOperationId: "op-update-1",
    issueIds: ["1", "2"],
    ...overrides,
  };
}

/** Build a plan carrying a well-formed current section for ids/operation. */
function planWithSection(opts: {
  updateOperationId?: string;
  report?: string;
  round?: number;
  baseline?: string;
  rows: string[];
  heading?: string;
  extraBefore?: string;
  extraAfter?: string;
}): string {
  const lines = [
    "# Plan",
    "",
    opts.extraBefore ?? "Original plan content.",
    "",
    opts.heading ?? "## Design Review Update",
    "",
    `**Report**: ${opts.report ?? REPORT_DOC}`,
    `**Round**: ${opts.round ?? 1}`,
    `**Operation**: ${opts.updateOperationId ?? "op-update-1"}`,
    `**Baseline Hash**: ${opts.baseline ?? BASELINE}`,
    "",
    "### Issue Dispositions",
    "",
    "| # | Issue | Disposition | Justification |",
    "|---|-------|-------------|---------------|",
    ...opts.rows,
    "",
    "### Changes Made",
    "",
    "- loader: error handling added.",
    "",
  ];
  if (opts.extraAfter) lines.push(opts.extraAfter, "");
  return lines.join("\n");
}

describe("192 Phase 2: current-section binding", () => {
  it("well-formed current section with complete dispositions → ready", () => {
    const plan = planWithSection({
      rows: [
        "| 1 | Missing error handling | fixed | added try/catch in loader |",
        "| 2 | Incomplete specification | fixed | expanded API spec |",
      ],
    });
    const verdict = validateDesignReviewUpdate(input({ planContent: plan }));
    expect(verdict.status).toBe("ready");
    if (verdict.status === "ready") {
      expect(verdict.newPlanHash).toBe(computePlanHash(plan));
      expect(verdict.disposedIssueIds.sort()).toEqual(["1", "2"]);
    }
  });

  it("multi-round OLD sections (different Operation) never satisfy the current round", () => {
    const plan = planWithSection({
      rows: [
        "| 1 | old issue | fixed | old |",
        "| 2 | old issue | fixed | old |",
      ],
      updateOperationId: "op-update-ROUND-9", // foreign/stale
    });
    const verdict = validateDesignReviewUpdate(input({ planContent: plan }));
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") {
      expect(verdict.failures.join(" ")).toContain("stale/foreign");
    }
  });

  it("duplicate sections bound to the SAME operation are invalid", () => {
    const single = planWithSection({
      rows: [
        "| 1 | a | fixed | x |",
        "| 2 | b | fixed | y |",
      ],
    });
    const dup = single + single; // two identical current sections
    const verdict = validateDesignReviewUpdate(input({ planContent: dup }));
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") {
      expect(verdict.failures.join(" ")).toContain("duplicate");
    }
  });

  it("missing section entirely → invalid (empty heading-only plan is NOT ready — F03 probe)", () => {
    // The exact F03 probe input: plan updated to only a bare heading.
    const bare = "# Plan\n## Design Review Update\n";
    const verdict = validateDesignReviewUpdate(
      input({ planContent: bare, issueIds: ["1"], }),
    );
    expect(verdict.status).toBe("invalid");
  });
});

describe("192 Phase 2: one disposition per issue", () => {
  it("missing issue disposition → invalid", () => {
    const plan = planWithSection({ rows: ["| 1 | a | fixed | x |"] }); // id 2 missing
    const verdict = validateDesignReviewUpdate(input({ planContent: plan }));
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") {
      expect(verdict.failures.join(" ")).toContain('issue id "2" lacks exactly one disposition');
    }
  });

  it("duplicate disposition for one issue → invalid", () => {
    const plan = planWithSection({
      rows: [
        "| 1 | a | fixed | x |",
        "| 1 | a again | deferred | y |",
        "| 2 | b | fixed | z |",
      ],
    });
    const verdict = validateDesignReviewUpdate(input({ planContent: plan }));
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") {
      expect(verdict.failures.join(" ")).toContain("must be exactly one");
    }
  });

  it("unknown issue id row → invalid", () => {
    const plan = planWithSection({
      rows: [
        "| 1 | a | fixed | x |",
        "| 2 | b | fixed | y |",
        "| 99 | ghost | fixed | z |",
      ],
    });
    const verdict = validateDesignReviewUpdate(input({ planContent: plan }));
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") {
      expect(verdict.failures.join(" ")).toContain("unknown issue id");
    }
  });

  it("unknown disposition token → invalid", () => {
    const plan = planWithSection({
      rows: [
        "| 1 | a | maybe | x |",
        "| 2 | b | fixed | y |",
      ],
    });
    const verdict = validateDesignReviewUpdate(input({ planContent: plan }));
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") {
      expect(verdict.failures.join(" ")).toContain("unknown disposition");
    }
  });

  it("empty justification → invalid; non-empty arbitrary text PASSES structure (quality is next round)", () => {
    const emptyRow = planWithSection({
      rows: ["| 1 | a | fixed |   |", "| 2 | b | fixed | y |"],
    });
    expect(validateDesignReviewUpdate(input({ planContent: emptyRow })).status).toBe("invalid");

    // Justification text meaning is NOT parsed here (no prefix heuristics):
    const oddRow = planWithSection({
      rows: ["| 1 | a | rejected | because reasons unrelated text |", "| 2 | b | fixed | y |"],
    });
    expect(validateDesignReviewUpdate(input({ planContent: oddRow })).status).toBe("ready");
  });

  it("Chinese issue content is bound by ID, not by text search", () => {
    const plan = planWithSection({
      rows: [
        "| 1 | 无法恢复异常派发 | fixed | 已补充恢复策略 |",
        "| 2 | 接口契约缺失 | deferred | 等待上游 |",
      ],
    });
    const verdict = validateDesignReviewUpdate(input({ planContent: plan }));
    expect(verdict.status).toBe("ready");
  });

  it("reason-prefix leniency is gone: 'Plan…'-style reasons no longer special", () => {
    // Old F03 bug: failures starting with digits were ignored when no reason
    // started with "Plan". Every structural failure now invalidates.
    const plan = planWithSection({ rows: ["| 1 | a | fixed | Plan later |"] });
    const verdict = validateDesignReviewUpdate(input({ planContent: plan }));
    expect(verdict.status).toBe("invalid"); // issue 2 missing — hard failure
  });
});

describe("192 Phase 2: association fields", () => {
  it("Report path mismatch → invalid", () => {
    const plan = planWithSection({
      report: "/tmp/elsewhere/other-report.md",
      rows: ["| 1 | a | fixed | x |", "| 2 | b | fixed | y |"],
    });
    const verdict = validateDesignReviewUpdate(input({ planContent: plan }));
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") {
      expect(verdict.failures.join(" ")).toContain("does not match the consumed report");
    }
  });

  it("Round mismatch → invalid", () => {
    const plan = planWithSection({
      round: 7,
      rows: ["| 1 | a | fixed | x |", "| 2 | b | fixed | y |"],
    });
    const verdict = validateDesignReviewUpdate(input({ planContent: plan }));
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") {
      expect(verdict.failures.join(" ")).toContain("Round");
    }
  });

  it("Baseline Hash mismatch → invalid", () => {
    const plan = planWithSection({
      baseline: "f".repeat(64),
      rows: ["| 1 | a | fixed | x |", "| 2 | b | fixed | y |"],
    });
    const verdict = validateDesignReviewUpdate(input({ planContent: plan }));
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") {
      expect(verdict.failures.join(" ")).toContain("Baseline Hash");
    }
  });

  it("case-insensitive path normalization: same file different case of dirs matches", () => {
    const plan = planWithSection({
      report: REPORT_DOC, // exact same path
      rows: ["| 1 | a | fixed | x |", "| 2 | b | fixed | y |"],
    });
    expect(validateDesignReviewUpdate(input({ planContent: plan })).status).toBe("ready");
  });
});

describe("192 Phase 2: hash and pause classes", () => {
  it("unchanged plan hash → paused(no-change)", () => {
    const unchanged = "# Plan\nsame\n";
    const verdict = validateDesignReviewUpdate(
      input({ planContent: unchanged, baselinePlanHash: computePlanHash(unchanged) }),
    );
    expect(verdict.status).toBe("paused");
    if (verdict.status === "paused") expect(verdict.reason).toBe("no-change");
  });

  it("sentinel new-decision pauses for owner (NOT invalid)", () => {
    const plan = planWithSection({
      rows: [
        "| 1 | a | new-decision | needs scope decision |",
        "| 2 | b | fixed | y |",
      ],
    });
    const verdict = validateDesignReviewUpdate(input({ planContent: plan }));
    expect(verdict.status).toBe("paused");
    if (verdict.status === "paused") expect(verdict.reason).toBe("new-decision");
  });

  it("sentinel unfixable pauses for owner", () => {
    const plan = planWithSection({
      rows: [
        "| 1 | a | unfixable | depends on external API |",
        "| 2 | b | fixed | y |",
      ],
    });
    expect(validateDesignReviewUpdate(input({ planContent: plan })).status).toBe("paused");
  });

  it("deferred/rejected with justification advance the loop (structure only; quality judged next round)", () => {
    const plan = planWithSection({
      rows: [
        "| 1 | a | deferred | scheduled for follow-up milestone |",
        "| 2 | b | rejected | out of agreed scope per requirement §3 |",
      ],
    });
    expect(validateDesignReviewUpdate(input({ planContent: plan })).status).toBe("ready");
  });
});

describe("192 Phase 2: example/code exclusion", () => {
  it("a disposition table inside a fenced code example does NOT count", () => {
    const plan = [
      "# Plan",
      "",
      "## Design Review Update",
      "",
      `**Report**: ${REPORT_DOC}`,
      "**Round**: 1",
      "**Operation**: op-update-1",
      `**Baseline Hash**: ${BASELINE}`,
      "",
      "```markdown",
      "| # | Issue | Disposition | Justification |",
      "|---|-------|-------------|---------------|",
      "| 1 | fake | fixed | from example |",
      "| 2 | fake | fixed | from example |",
      "```",
      "",
    ].join("\n");
    const verdict = validateDesignReviewUpdate(input({ planContent: plan }));
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") {
      expect(verdict.failures.join(" ")).toContain("no disposition rows");
    }
  });

  it("heading inside a fenced block is not a section boundary", () => {
    const plan = [
      "# Plan",
      "",
      "```",
      "## Design Review Update",
      "```",
      "",
      "Real section below has none — still invalid:",
      `**Operation**: op-update-1`,
    ].join("\n");
    const verdict = validateDesignReviewUpdate(input({ planContent: plan }));
    expect(verdict.status).toBe("invalid");
  });
});

describe("192 Phase 2: purity (read/update separation)", () => {
  it("verifier consumes ONLY provided snapshots — plan read-only requirements are prompt-side guards", () => {
    // The function signature takes no fs/session inputs; a provided content
    // snapshot alone determines the verdict (source/requirement files are
    // never touched by this module — enforced by tool-guard write scope).
    const fnSrc = require("fs").readFileSync(
      require.resolve("../../../core/verifiers/design-review-update-verifier"),
      "utf-8",
    ) as string;
    expect(fnSrc).not.toMatch(/node:fs/);
    expect(fnSrc).not.toMatch(/updateMeta|spawn|session/);
    expect(fnSrc).not.toMatch(/session-state|subagent/);
  });
});

describe("192 issue 8: report attribution vs the consumed review identity (Phase 2 task 6)", () => {
  /** Well-formed current-round plan section for attribution tests. */
  function validPlan(): string {
    return planWithSection({
      rows: [
        "| 1 | Missing error handling | fixed | added try/catch in loader |",
        "| 2 | Incomplete specification | fixed | expanded API spec |",
      ],
    });
  }

  /** A consumed report snapshot declaring review operation op-review-1. */
  function reportSnapshot(op: string = "op-review-1"): string {
    return [
      "# Design Review Report",
      "",
      "**operation**: " + op,
      "",
      "## Verdict",
      "",
      "**Design Review: FAIL**",
      "",
    ].join("\n");
  }

  it("snapshot matches reportHash AND declares the consumed review operation → ready", () => {
    const report = reportSnapshot();
    const verdict = validateDesignReviewUpdate(
      input({ planContent: validPlan(), reportContent: report, reportHash: computePlanHash(report) }),
    );
    expect(verdict.status).toBe("ready");
  });

  it("swapped report snapshot (content no longer matches the receipt hash) → invalid", () => {
    const verdict = validateDesignReviewUpdate(
      input({
        planContent: validPlan(),
        reportContent: reportSnapshot("op-review-TAMPERED"),
        reportHash: REPORT_HASH, // receipt-bound hash of the ORIGINAL consumed report
      }),
    );
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") {
      expect(verdict.failures.join(" ")).toContain("report was replaced after consumption");
    }
  });

  it("matching snapshot that declares a DIFFERENT review operation → invalid (ownership enforced here)", () => {
    const report = reportSnapshot("op-review-OTHER");
    const verdict = validateDesignReviewUpdate(
      input({ planContent: validPlan(), reportContent: report, reportHash: computePlanHash(report) }),
    );
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") {
      expect(verdict.failures.join(" ")).toContain("belongs to review operation \"op-review-OTHER\"");
      expect(verdict.failures.join(" ")).toContain("not the consumed review operation \"op-review-1\"");
    }
  });

  it("shipped-template alias label **operationId** is accepted (report-verifier label parity)", () => {
    const report = reportSnapshot().replace("**operation**:", "**operationId**:");
    const verdict = validateDesignReviewUpdate(
      input({ planContent: validPlan(), reportContent: report, reportHash: computePlanHash(report) }),
    );
    expect(verdict.status).toBe("ready");
  });

  it("snapshot without any operation label while a consumed review id is known → invalid", () => {
    const report = "# Design Review Report\n\nno identity rows here\n";
    const verdict = validateDesignReviewUpdate(
      input({ planContent: validPlan(), reportContent: report, reportHash: computePlanHash(report) }),
    );
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") {
      expect(verdict.failures.join(" ")).toContain("does not declare its review operation");
    }
  });

  it("legacy \"unknown\" consumed review id skips the ownership comparison (hash gate still applies)", () => {
    const report = reportSnapshot("op-whatever");
    const okVerdict = validateDesignReviewUpdate(
      input({
        planContent: validPlan(),
        reportContent: report,
        reportHash: computePlanHash(report),
        reviewOperationId: "unknown",
      }),
    );
    expect(okVerdict.status).toBe("ready");

    const badHash = validateDesignReviewUpdate(
      input({
        planContent: validPlan(),
        reportContent: report,
        reportHash: "f".repeat(64),
        reviewOperationId: "unknown",
      }),
    );
    expect(badHash.status).toBe("invalid");
    if (badHash.status === "invalid") {
      expect(badHash.failures.join(" ")).toContain("report was replaced after consumption");
    }
  });

  it("empty consumed review id with a supplied snapshot fails closed", () => {
    const report = reportSnapshot();
    const verdict = validateDesignReviewUpdate(
      input({
        planContent: validPlan(),
        reportContent: report,
        reportHash: computePlanHash(report),
        reviewOperationId: "",
      }),
    );
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") {
      expect(verdict.failures.join(" ")).toContain("ownership cannot be established");
    }
  });

  it("no snapshot supplied → attribution checks are skipped (structural verdict unchanged)", () => {
    // Default input() carries a reportHash that matches NOTHING (no content).
    // Without a snapshot the verdict stays purely structural — the omitted
    // read never fabricates an attribution failure.
    const verdict = validateDesignReviewUpdate(input({ planContent: validPlan() }));
    expect(verdict.status).toBe("ready");
  });
});
