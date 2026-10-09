/**
 * 194 Phase 1: unit tests for the STANDALONE update receipt contract
 * (`validateDesignReviewUpdate` with `output.kind === "standalone"`).
 *
 * These are pure evaluator tests — no filesystem, no coordinator: the snapshot
 * layer hands the verifier the exact bytes it captured once, and the verdict
 * must never look anywhere else. The suite pins the failure classes the plan
 * demands:
 *  - a missing / unreadable / empty receipt is INVALID and is NEVER back-filled
 *    from the plan body (a new operation cannot fall back to legacy evidence);
 *  - the receipt carries EXACTLY ONE protocol section;
 *  - all seven identity rows are required, duplicate-aware and alias-proof
 *    (review id and update id are not interchangeable);
 *  - a receipt belonging to a DIFFERENT operation cannot authorize this one;
 *  - dispositions, justifications and the `fixed` → Phase-location marker hold
 *    for every disposition value;
 *  - the plan body's protocol sections stay frozen (C1 baseline digest);
 *  - an unchanged plan hash pauses (no-change) before any receipt is read;
 *  - the explicit legacy shape keeps 192 behaviour byte-compatible (READ
 *    compatibility for pre-194 operations only).
 */
import { describe, expect, it } from "bun:test";
import {
  validateDesignReviewUpdate,
  computePlanHash,
  type DesignReviewUpdateValidationInput,
} from "../../../core/verifiers/design-review-update-verifier";
import {
  computeBaselineSectionsHash,
  deriveStandaloneReceiptPath,
  extractLegacyUpdateSections,
  narrowUpdateArtifact,
} from "../../../core/design-review/update-artifact";
import { standaloneReceiptContent } from "../../helpers";

const PLAN = "/abs/proj/docs/194_Feat_plan.md";
const REPORT = "/abs/proj/docs/194_Feat_plan-review-report-1.md";
const PIPELINE = "pipe-194";
const REVIEW_OP = "11111111-1111-4111-8111-111111111111";
const UPDATE_OP = "22222222-2222-4222-8222-222222222222";
const FOREIGN_UPDATE_OP = "33333333-3333-4333-8333-333333333333";
const ROUND = 1;
const BASELINE_PLAN = "# Plan\n\n## Approach\n\nOriginal design.\n";
const REVISED_PLAN = "# Plan\n\n## Approach\n\nRevised design with rollback coverage.\n";
const BASELINE_HASH = computePlanHash(BASELINE_PLAN);

const REPORT_CONTENT = [
  "# Design Review Report",
  "",
  `**pipeline**: ${PIPELINE}`,
  `**plan**: ${PLAN}`,
  `**round**: ${ROUND}`,
  `**operation**: ${REVIEW_OP}`,
  `**input hash**: ${BASELINE_HASH}`,
  "",
  "## Summary",
  "",
  "Two gaps block development.",
  "",
  "## Issues",
  "",
  "1. Missing error handling",
  "2. Incomplete specification",
  "",
].join("\n");
const REPORT_HASH = computePlanHash(REPORT_CONTENT);

function baseInput(
  overrides: Partial<DesignReviewUpdateValidationInput> = {},
): DesignReviewUpdateValidationInput {
  return {
    planContent: REVISED_PLAN,
    baselinePlanHash: BASELINE_HASH,
    reportDoc: REPORT,
    reportHash: REPORT_HASH,
    round: ROUND,
    reviewOperationId: REVIEW_OP,
    updateOperationId: UPDATE_OP,
    issueIds: ["1", "2"],
    pipelineId: PIPELINE,
    planDoc: PLAN,
    ...overrides,
  };
}

/** The standalone output binding for the CURRENT update operation. */
function standaloneOutput(
  receiptContent: string | undefined,
  overrides: Partial<{ receiptDoc: string; baselineSectionsHash: string; receiptReadError: string }> = {},
): DesignReviewUpdateValidationInput["output"] {
  return {
    kind: "standalone",
    receiptDoc: overrides.receiptDoc ?? deriveStandaloneReceiptPath(PLAN, ROUND, UPDATE_OP)!,
    ...(receiptContent !== undefined ? { receiptContent } : {}),
    ...(overrides.receiptReadError !== undefined ? { receiptReadError: overrides.receiptReadError } : {}),
    baselineSectionsHash:
      overrides.baselineSectionsHash ?? computeBaselineSectionsHash(extractLegacyUpdateSections(BASELINE_PLAN)),
  };
}

function validReceipt(extra: Partial<Parameters<typeof standaloneReceiptContent>[0]> = {}): string {
  return standaloneReceiptContent({
    pipelineId: PIPELINE,
    planDoc: PLAN,
    reviewOperationId: REVIEW_OP,
    reportDoc: REPORT,
    round: ROUND,
    updateOperationId: UPDATE_OP,
    baselinePlanHash: BASELINE_HASH,
    dispositions: [
      { issueId: "1", text: "Missing error handling", disposition: "fixed", justification: "added the retry section" },
      { issueId: "2", text: "Incomplete specification", disposition: "fixed", justification: "expanded the contract" },
    ],
    changesMade: ["- Phase 1: added retry and contract sections."],
    ...extra,
  });
}

describe("194 Phase 1: standalone update receipt validation", () => {
  it("valid revised plan + matching standalone receipt → ready with the receipt hash", () => {
    const receipt = validReceipt();
    const verdict = validateDesignReviewUpdate(baseInput({ output: standaloneOutput(receipt) }));
    expect(verdict.status).toBe("ready");
    if (verdict.status === "ready") {
      expect(verdict.newPlanHash).toBe(computePlanHash(REVISED_PLAN));
      expect(verdict.receiptHash).toBe(computePlanHash(receipt));
      expect(verdict.disposedIssueIds).toEqual(["1", "2"]);
    }
  });

  it("an unchanged plan pauses (no-change) even when the receipt is perfect", () => {
    const verdict = validateDesignReviewUpdate(
      baseInput({ planContent: BASELINE_PLAN, output: standaloneOutput(validReceipt()) }),
    );
    expect(verdict.status).toBe("paused");
    if (verdict.status === "paused") expect(verdict.reason).toBe("no-change");
  });

  describe("the receipt is never back-filled from the plan body", () => {
    it("unreadable receipt → invalid even though the plan body carries a valid embedded section", () => {
      const embeddedOnly = [
        "# Plan",
        "",
        "## Design Review Update",
        "",
        `**Report**: ${REPORT}`,
        `**Round**: ${ROUND}`,
        `**Operation**: ${UPDATE_OP}`,
        `**Baseline Hash**: ${BASELINE_HASH}`,
        "",
        "### Issue Dispositions",
        "",
        "| # | Issue | Disposition | Justification |",
        "|---|-------|-------------|---------------|",
        "| 1 | Missing error handling | fixed | added retry (Phase 1) |",
        "| 2 | Incomplete specification | fixed | expanded contract (Phase 1) |",
        "",
        "### Changes Made",
        "",
        "- Phase 1: retry and contract sections.",
        "",
      ].join("\n");
      const verdict = validateDesignReviewUpdate(
        baseInput({
          planContent: embeddedOnly,
          output: standaloneOutput(undefined, { receiptReadError: "ENOENT: no such file or directory" }),
        }),
      );
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") {
        expect(verdict.failures.join(" ")).toContain("standalone update receipt unreadable");
      }
    });

    it("empty receipt bytes → invalid", () => {
      const verdict = validateDesignReviewUpdate(
        baseInput({ output: standaloneOutput("   \n") }),
      );
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") {
        expect(verdict.failures.join(" ")).toContain("receipt is empty");
      }
    });

    it("receipt without the protocol section → invalid with the exact heading named", () => {
      const verdict = validateDesignReviewUpdate(
        baseInput({ output: standaloneOutput("# Receipt\n\nNothing structured here.\n") }),
      );
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") {
        expect(verdict.failures.join(" ")).toContain("missing the `## Design Review Update` section");
      }
    });

    it("two protocol sections in the receipt → invalid (never 'latest wins')", () => {
      const doubled = validReceipt() + "\n" + validReceipt({ updateOperationId: FOREIGN_UPDATE_OP });
      const verdict = validateDesignReviewUpdate(baseInput({ output: standaloneOutput(doubled) }));
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") {
        expect(verdict.failures.join(" ")).toContain("must be exactly one");
      }
    });
  });

  describe("identity rows: required, duplicate-aware, alias-proof", () => {
    it.each([
      ["Pipeline", /^\*\*Pipeline\*\*: .*$/m],
      ["Plan", /^\*\*Plan\*\*: .*$/m],
      ["Review Operation", /^\*\*Review Operation\*\*: .*$/m],
      ["Report", /^\*\*Report\*\*: .*$/m],
      ["Round", /^\*\*Round\*\*: .*$/m],
      ["Operation", /^\*\*Operation\*\*: .*$/m],
      ["Baseline Hash", /^\*\*Baseline Hash\*\*: .*$/m],
    ] as const)("a receipt missing the %s row is invalid", (_label, pattern) => {
      const receipt = validReceipt().replace(pattern, "");
      const verdict = validateDesignReviewUpdate(baseInput({ output: standaloneOutput(receipt) }));
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") {
        expect(verdict.failures.join(" ")).toContain("is missing the");
      }
    });

    it("a duplicated identity row is ambiguous evidence → invalid", () => {
      const receipt = validReceipt().replace(
        `**Round**: ${ROUND}`,
        `**Round**: ${ROUND}\n**Round**: ${ROUND}`,
      );
      const verdict = validateDesignReviewUpdate(baseInput({ output: standaloneOutput(receipt) }));
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") {
        expect(verdict.failures.join(" ")).toContain("declares `Round` more than once");
      }
    });

    it("the review/update ids are NOT interchangeable (alias identity) → invalid", () => {
      // The agent pastes the UPDATE id where the REPORT's review id belongs and
      // vice versa: every row must match its own pinned value.
      const receipt = validReceipt().replace(
        `**Review Operation**: ${REVIEW_OP}`,
        `**Review Operation**: ${UPDATE_OP}`,
      ).replace(
        `**Operation**: ${UPDATE_OP}`,
        `**Operation**: ${REVIEW_OP}`,
      );
      const verdict = validateDesignReviewUpdate(baseInput({ output: standaloneOutput(receipt) }));
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") {
        const text = verdict.failures.join(" ");
        expect(text).toContain("`Review Operation`");
        expect(text).toContain("`Operation`");
      }
    });

    it("a foreign baseline hash or foreign round cannot be laundered by an otherwise valid receipt", () => {
      const receipt = validReceipt().replace(`**Baseline Hash**: ${BASELINE_HASH}`, `**Baseline Hash**: ${computePlanHash("other")}`);
      const verdict = validateDesignReviewUpdate(baseInput({ output: standaloneOutput(receipt) }));
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") expect(verdict.failures.join(" ")).toContain("`Baseline Hash`");

      const roundReceipt = validReceipt().replace(`**Round**: ${ROUND}`, "**Round**: 2");
      const roundVerdict = validateDesignReviewUpdate(baseInput({ output: standaloneOutput(roundReceipt) }));
      expect(roundVerdict.status).toBe("invalid");
      if (roundVerdict.status === "invalid") expect(roundVerdict.failures.join(" ")).toContain("`Round`");
    });

    it("path rows compare canonically (a ./-prefixed twin still matches)", () => {
      const receipt = validReceipt().replace(`**Plan**: ${PLAN}`, "**Plan**: /abs/proj/./docs/194_Feat_plan.md");
      const verdict = validateDesignReviewUpdate(baseInput({ output: standaloneOutput(receipt) }));
      expect(verdict.status).toBe("ready");
    });
  });

  it("a receipt pinning a DIFFERENT update operation cannot authorize this one", () => {
    const receipt = validReceipt({ updateOperationId: FOREIGN_UPDATE_OP });
    const verdict = validateDesignReviewUpdate(baseInput({ output: standaloneOutput(receipt) }));
    expect(verdict.status).toBe("invalid");
    if (verdict.status === "invalid") expect(verdict.failures.join(" ")).toContain("`Operation`");
  });

  it("a receipt pinned at a foreign receipt path fails the C1 path narrowing before validation", () => {
    const foreignDoc = deriveStandaloneReceiptPath(PLAN, ROUND, FOREIGN_UPDATE_OP)!;
    // narrowUpdateArtifact is what the production context uses; a descriptor
    // naming another operation's document is ok:false — never legacy.
    const narrowed = narrowUpdateArtifact(
      { format: "standalone-v1", receiptDoc: foreignDoc, baselineSectionsHash: computeBaselineSectionsHash([]) },
      PLAN,
      ROUND,
      UPDATE_OP,
    );
    expect(narrowed.ok).toBe(false);
    if (!narrowed.ok) expect(narrowed.reason).toBe("update_artifact_receipt_path_drift");
  });

  describe("dispositions and justifications", () => {
    type Row = {
      issueId: string;
      disposition: "fixed" | "deferred" | "rejected" | "new-decision" | "unfixable";
      justification?: string;
    };
    const withDispositions = (rows: Row[]) =>
      standaloneReceiptContent({
        pipelineId: PIPELINE,
        planDoc: PLAN,
        reviewOperationId: REVIEW_OP,
        reportDoc: REPORT,
        round: ROUND,
        updateOperationId: UPDATE_OP,
        baselinePlanHash: BASELINE_HASH,
        dispositions: rows,
        changesMade: ["- Phase 1: revised sections."],
      });

    it.each(["fixed", "deferred", "rejected"])("every advancing disposition (%s) reaches ready", (disposition) => {
      const verdict = validateDesignReviewUpdate(
        baseInput({
          output: standaloneOutput(
            withDispositions([
              { issueId: "1", disposition },
              { issueId: "2", disposition },
            ]),
          ),
        }),
      );
      expect(verdict.status).toBe("ready");
    });

    it.each(["new-decision", "unfixable"])("the %s sentinel pauses for the owner instead of failing format", (disposition) => {
      const verdict = validateDesignReviewUpdate(
        baseInput({
          output: standaloneOutput(
            withDispositions([
              { issueId: "1", disposition: "fixed" },
              { issueId: "2", disposition },
            ]),
          ),
        }),
      );
      expect(verdict.status).toBe("paused");
      if (verdict.status === "paused") expect(verdict.reason).toBe("new-decision");
    });

    it("an empty justification is invalid", () => {
      const verdict = validateDesignReviewUpdate(
        baseInput({
          output: standaloneOutput(
            withDispositions([
              { issueId: "1", disposition: "fixed", justification: "   " },
              { issueId: "2", disposition: "fixed" },
            ]),
          ),
        }),
      );
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") expect(verdict.failures.join(" ")).toContain("empty justification");
    });

    it("a missing issue id is invalid (no leniency for partial coverage)", () => {
      const verdict = validateDesignReviewUpdate(
        baseInput({ output: standaloneOutput(withDispositions([{ issueId: "1", disposition: "fixed" }])) }),
      );
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") expect(verdict.failures.join(" ")).toContain('issue id "2" lacks exactly one disposition');
    });

    it("a duplicated issue id is invalid", () => {
      const verdict = validateDesignReviewUpdate(
        baseInput({
          output: standaloneOutput(
            withDispositions([
              { issueId: "1", disposition: "fixed" },
              { issueId: "1", disposition: "deferred" },
              { issueId: "2", disposition: "fixed" },
            ]),
          ),
        }),
      );
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") expect(verdict.failures.join(" ")).toContain("must be exactly one");
    });

    it("an issue id foreign to the consumed report is invalid", () => {
      const verdict = validateDesignReviewUpdate(
        baseInput({
          output: standaloneOutput(
            withDispositions([
              { issueId: "1", disposition: "fixed" },
              { issueId: "2", disposition: "fixed" },
              { issueId: "7", disposition: "fixed" },
            ]),
          ),
        }),
      );
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") expect(verdict.failures.join(" ")).toContain('unknown issue id "7"');
    });

    it("an unknown disposition word is invalid", () => {
      const verdict = validateDesignReviewUpdate(
        baseInput({
          output: standaloneOutput(
            withDispositions([
              { issueId: "1", disposition: "addressed" as never },
              { issueId: "2", disposition: "fixed" },
            ]),
          ),
        }),
      );
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") expect(verdict.failures.join(" ")).toContain("unknown disposition");
    });

    it("`fixed` without a plan Phase location in ### Changes Made is invalid", () => {
      const receipt = withDispositions([
        { issueId: "1", disposition: "fixed" },
        { issueId: "2", disposition: "fixed" },
      ]).replace("- Phase 1: revised sections.", "- we revised some sections somewhere.");
      const verdict = validateDesignReviewUpdate(baseInput({ output: standaloneOutput(receipt) }));
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") {
        expect(verdict.failures.join(" ")).toContain("requires the actual plan Phase location");
      }
    });

    it("a bilingual Phase marker (阶段2) satisfies the location requirement", () => {
      const receipt = withDispositions([
        { issueId: "1", disposition: "fixed" },
        { issueId: "2", disposition: "fixed" },
      ]).replace("- Phase 1: revised sections.", "- 阶段2：补充了回滚方案。");
      const verdict = validateDesignReviewUpdate(baseInput({ output: standaloneOutput(receipt) }));
      expect(verdict.status).toBe("ready");
    });

    it("a receipt with no ### Changes Made entries is invalid", () => {
      const receipt = withDispositions([
        { issueId: "1", disposition: "fixed" },
        { issueId: "2", disposition: "fixed" },
      ]).replace(/### Changes Made\n\n- Phase 1: revised sections\./, "### Changes Made\n");
      const verdict = validateDesignReviewUpdate(baseInput({ output: standaloneOutput(receipt) }));
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") {
        expect(verdict.failures.join(" ")).toContain("no `### Changes Made` entries");
      }
    });
  });

  describe("consumed-report attribution", () => {
    it("a replaced report snapshot after consumption is invalid", () => {
      const verdict = validateDesignReviewUpdate(
        baseInput({
          reportContent: REPORT_CONTENT.replace("Two gaps block development.", "One gap remains."),
          output: standaloneOutput(validReceipt()),
        }),
      );
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") {
        expect(verdict.failures.join(" ")).toContain("no longer matches the receipt reportHash");
      }
    });

    it("a report belonging to a different review operation is invalid", () => {
      const verdict = validateDesignReviewUpdate(
        baseInput({
          reportContent: REPORT_CONTENT.replace(`**operation**: ${REVIEW_OP}`, `**operation**: ${FOREIGN_UPDATE_OP}`),
          reportHash: "",
          output: standaloneOutput(validReceipt()),
        }),
      );
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") {
        expect(verdict.failures.join(" ")).toContain("not the consumed review operation");
      }
    });

    it("an empty consumed review id fails closed", () => {
      const verdict = validateDesignReviewUpdate(
        baseInput({
          reviewOperationId: "",
          reportContent: REPORT_CONTENT,
          output: standaloneOutput(validReceipt()),
        }),
      );
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") {
        expect(verdict.failures.join(" ")).toContain("consumed review operation id is empty");
      }
    });
  });

  describe("plan body protocol sections stay frozen (C1)", () => {
    /** A plan that already carries one historical protocol section. */
    const PLAN_WITH_HISTORY = `${BASELINE_PLAN}\n## Design Review Update\n\n**Round**: 1\n**Operation**: legacy\n\n### Changes Made\n\n- Phase 1: earlier edit.\n`;
    const HISTORY_HASH = computePlanHash(PLAN_WITH_HISTORY);
    const FROZEN_HISTORY = computeBaselineSectionsHash(extractLegacyUpdateSections(PLAN_WITH_HISTORY));

    it("adding a NEW protocol section to the plan is the only failure", () => {
      const pollutedPlan = `${REVISED_PLAN}\n## Design Review Update\n\n**Round**: ${ROUND}\n`;
      const verdict = validateDesignReviewUpdate(
        baseInput({ planContent: pollutedPlan, output: standaloneOutput(validReceipt()) }),
      );
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") {
        expect(verdict.failures).toHaveLength(1);
        expect(verdict.failures[0]).toContain("frozen baseline sections hash mismatch");
      }
    });

    it("editing a pre-existing historical protocol section is invalid", () => {
      const tampered = PLAN_WITH_HISTORY.replace("- Phase 1: earlier edit.", "- Phase 1: EDITED AFTER THE FACT.");
      const verdict = validateDesignReviewUpdate(
        baseInput({
          planContent: tampered,
          baselinePlanHash: HISTORY_HASH,
          output: standaloneOutput(validReceipt({ baselinePlanHash: HISTORY_HASH }), {
            baselineSectionsHash: FROZEN_HISTORY,
          }),
        }),
      );
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") {
        expect(verdict.failures).toHaveLength(1);
        expect(verdict.failures[0]).toContain("frozen baseline sections hash mismatch");
      }
    });

    it("leaving an untouched historical protocol section in place is tolerated", () => {
      // The agent only edits non-protocol content; the historical section survives byte-identical.
      const revised = PLAN_WITH_HISTORY.replace("Original design.", "Revised design with rollback coverage.");
      const verdict = validateDesignReviewUpdate(
        baseInput({
          planContent: revised,
          baselinePlanHash: HISTORY_HASH,
          output: standaloneOutput(validReceipt({ baselinePlanHash: HISTORY_HASH }), {
            baselineSectionsHash: FROZEN_HISTORY,
          }),
        }),
      );
      expect(verdict.status).toBe("ready");
    });
  });

  describe("explicit legacy shape stays 192-compatible (READ only, never a fallback)", () => {
    const embedded = [
      "# Plan",
      "",
      "## Design Review Update",
      "",
      `**Report**: ${REPORT}`,
      `**Round**: ${ROUND}`,
      `**Operation**: ${UPDATE_OP}`,
      `**Baseline Hash**: ${BASELINE_HASH}`,
      "",
      "### Issue Dispositions",
      "",
      "| # | Issue | Disposition | Justification |",
      "|---|-------|-------------|---------------|",
      "| 1 | Missing error handling | fixed | added retry |",
      "| 2 | Incomplete specification | fixed | expanded contract |",
      "",
      "### Changes Made",
      "",
      "- retry and contract sections.",
      "",
    ].join("\n");

    it("an absent output binding validates the embedded section exactly as 192 did", () => {
      const verdict = validateDesignReviewUpdate(baseInput({ planContent: embedded }));
      expect(verdict.status).toBe("ready");
      if (verdict.status === "ready") expect(verdict.receiptHash).toBeUndefined();
    });

    it("the legacy shape keeps 192 leniency: no Phase marker requirement, no identity rows", () => {
      const loose = embedded
        .replace(/^\*\*Pipeline\*\*: .*$\n?/m, "")
        .replace("- retry and contract sections.", "- Phase 9: whatever.");
      expect(validateDesignReviewUpdate(baseInput({ planContent: loose })).status).toBe("ready");
    });

    it("a stale foreign section in the plan body never counts (192 parity)", () => {
      const stale = embedded.replace(`**Operation**: ${UPDATE_OP}`, `**Operation**: ${FOREIGN_UPDATE_OP}`);
      const verdict = validateDesignReviewUpdate(baseInput({ planContent: stale }));
      expect(verdict.status).toBe("invalid");
      if (verdict.status === "invalid") {
        expect(verdict.failures.join(" ")).toContain("only stale/foreign sections found");
      }
    });
  });

  describe("narrowUpdateArtifact: the descriptor gate a new operation must pass", () => {
    const validDoc = deriveStandaloneReceiptPath(PLAN, ROUND, UPDATE_OP)!;
    const digest = computeBaselineSectionsHash([]);

    it("an absent descriptor is the ONLY route to the legacy contract", () => {
      expect(narrowUpdateArtifact(undefined, PLAN, ROUND, UPDATE_OP)).toEqual({ ok: true, kind: "legacy" });
    });

    it("a valid descriptor narrows to standalone with the canonical path", () => {
      const narrowed = narrowUpdateArtifact(
        { format: "standalone-v1", receiptDoc: validDoc, baselineSectionsHash: digest },
        PLAN,
        ROUND,
        UPDATE_OP,
      );
      expect(narrowed).toEqual({ ok: true, kind: "standalone", receiptDoc: validDoc, baselineSectionsHash: digest });
    });

    it.each([
      ["non-object", null],
      ["array", []],
      ["unknown format", { format: "standalone-v2", receiptDoc: validDoc, baselineSectionsHash: digest }],
      ["missing receipt path", { format: "standalone-v1", baselineSectionsHash: digest }],
      ["relative receipt path", { format: "standalone-v1", receiptDoc: "docs/plan-update-1.md", baselineSectionsHash: digest }],
      ["malformed baseline digest", { format: "standalone-v1", receiptDoc: validDoc, baselineSectionsHash: "zz" }],
    ])("a malformed descriptor (%s) fails closed — NEVER a silent legacy downgrade", (_label, input) => {
      const narrowed = narrowUpdateArtifact(input, PLAN, ROUND, UPDATE_OP);
      expect(narrowed.ok).toBe(false);
      if (!narrowed.ok) expect(narrowed.reason).toMatch(/^update_artifact_/);
    });

    it("a non-UUID operation id cannot produce a safe path", () => {
      expect(deriveStandaloneReceiptPath(PLAN, ROUND, "../evil")).toBeNull();
      const narrowed = narrowUpdateArtifact(
        { format: "standalone-v1", receiptDoc: validDoc, baselineSectionsHash: digest },
        PLAN,
        ROUND,
        "op-not-a-uuid",
      );
      expect(narrowed).toEqual({ ok: false, reason: "update_artifact_identity_invalid" });
    });
  });
});
