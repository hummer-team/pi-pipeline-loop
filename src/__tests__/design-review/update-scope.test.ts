/**
 * 229 Phase 3 (F3/B14/B15): the mechanical declared-update-scope check.
 *
 * Boundaries covered (plan Phase 3 "单元测试目标，边界"):
 * - section slicing/diff are covered in section-hashes.test.ts; here the
 *   DECLARED set (from `### Changes Made`) is checked against the ACTUAL
 *   changes: declare [2] + actual [5] ⇒ `scope_violation`; declare [2,5] +
 *   actual [2] ⇒ `declared_but_unchanged`; missing baseline ⇒ legacy
 *   aggregate mode with the `update_receipt_legacy_binding` signal;
 * - per-issue binding: a `fixed` disposition without an own-id `Changes
 *   Made` entry fails; an entry whose Phase is NOT declared fails; legacy
 *   numeric ids map by the `## Issues` order (audited upstream);
 * - declared-set carry-through: a READY verdict exposes `scope.declared`
 *   so the coordinator can persist `lastDeclaredScope`.
 */

import { describe, expect, it } from "bun:test";
import { validateDesignReviewUpdate } from "../../core/verifiers/design-review-update-verifier";
import type { DesignReviewUpdateValidationInput } from "../../core/verifiers/design-review-update-verifier";
import {
  parseChangesMadeLocations,
  parseChangesMadeIssueLinks,
} from "../../core/design-review/update-receipt";
import { computeSectionHashes, diffSectionHashes } from "../../core/design-review/section-hashes";
import { computeBaselineSectionsHash, extractLegacyUpdateSections } from "../../core/design-review/update-artifact";

const PLAN_BEFORE = [
  "# 229_Feat Plan",
  "",
  "## Phase 2 — verdict",
  "original phase 2 content",
  "",
  "## Phase 5 — handoff",
  "original phase 5 content",
  "",
  "## 验收",
  "acceptance",
  "",
].join("\n");

const PLAN_AFTER_P5 = PLAN_BEFORE.replace("original phase 5 content", "revised phase 5 content");

function receipt(changesMade: string[]): string {
  return [
    "# Design Review Update Receipt",
    "",
    "## Design Review Update",
    "",
    "**Pipeline**: pipe-scope",
    "**Plan**: /abs/plan.md",
    "**Review Operation**: op-review-1",
    "**Report**: /abs/report.md",
    "**Round**: 2",
    `**Operation**: ${OP}`,
    `**Baseline Hash**: ${"d".repeat(64)}`,
    "",
    "### Issue Dispositions",
    "",
    "| Issue | Summary | Disposition | Justification |",
    "| --- | --- | --- | --- |",
    "| DR-1-5 | fee caliber | fixed | safe to resolve |",
    "",
    "### Changes Made",
    "",
    ...changesMade,
    "",
  ].join("\n");
}

const OP = "op-scope-1";
/** Frozen-baseline digest of an EMPTY legacy-update-section plan. */
const FROZEN_HASH = computeBaselineSectionsHash(extractLegacyUpdateSections(PLAN_BEFORE));

function baseInput(changesMade: string[], overrides: Partial<DesignReviewUpdateValidationInput> = {}): DesignReviewUpdateValidationInput {
  return {
    planContent: PLAN_AFTER_P5,
    baselinePlanHash: "d".repeat(64),
    reportDoc: "/abs/report.md",
    reportHash: "f".repeat(64),
    round: 2,
    reviewOperationId: "op-review-1",
    updateOperationId: OP,
    issueIds: ["DR-1-5"],
    output: {
      kind: "standalone",
      receiptDoc: "/abs/receipt.md",
      receiptContent: receipt(changesMade),
      baselineSectionsHash: FROZEN_HASH,
    },
    pipelineId: "pipe-scope",
    planDoc: "/abs/plan.md",
    ...overrides,
  };
}

const BASELINE = computeSectionHashes(PLAN_BEFORE);

describe("229 Phase 3: parseChangesMadeLocations / parseChangesMadeIssueLinks", () => {
  it("parses Phase numbers + `section:<title>` declarations in order", () => {
    expect(
      parseChangesMadeLocations(["- Phase 2 — a", "- section:验收 — b", "- 阶段 5 — c"]),
    ).toEqual({ phases: [2, 5], sections: ["验收"] });
  });

  it("per-issue links: `- DR-2-1: Phase 3 — …`", () => {
    expect(parseChangesMadeIssueLinks(["- DR-2-1: Phase 3 — fee fix", "prose line not an entry"])).toEqual([
      { issueId: "DR-2-1", phases: [3] },
    ]);
  });
});

describe("229 Phase 3: mechanical scope check (F3/B15)", () => {
  it("declare Phase 2 + actual Phase 5 ⇒ scope_violation (F10 #4 replay)", () => {
    const v = validateDesignReviewUpdate(
      baseInput(["- DR-1-5: Phase 2 — fee caliber fix"], { baselineSectionHashes: BASELINE }),
    );
    expect(v.status).toBe("invalid");
    if (v.status === "invalid") {
      const scope = v.scope!;
      expect(scope.undeclared).toEqual(["phase:5"]);
      expect(scope.declared.phases).toEqual([2]);
      expect(v.failures.join(" ")).toContain("scope_violation");
    }
  });

  it("declare `## 验收` + actual `## 验收` edit passes (non-Phase sections are first-class)", () => {
    const plan = PLAN_BEFORE.replace("original phase 5 content", "revised phase 5 content").replace(
      /## 验收\nacceptance/,
      "## 验收\nrevised acceptance",
    );
    const v = validateDesignReviewUpdate(
      baseInput(
        [
          "- DR-1-5: Phase 5 — fee caliber fix",
          "- section:验收 — revised acceptance wording",
        ],
        { baselineSectionHashes: BASELINE, planContent: plan },
      ),
    );
    expect(v.status).toBe("ready");
    if (v.status === "ready") {
      expect(v.scope?.declared.sections).toEqual(["验收"]);
      expect(v.scope?.undeclared).toEqual([]);
    }
  });

  it("declare [Phase 2, Phase 5] + actual Phase 5 only ⇒ declared_but_unchanged", () => {
    const v = validateDesignReviewUpdate(
      baseInput(
        ["- DR-1-5: Phase 2 — x", "- DR-1-5: Phase 5 — fee caliber fix"],
        { baselineSectionHashes: BASELINE },
      ),
    );
    expect(v.status).toBe("invalid");
    if (v.status === "invalid") {
      // Phase 5 IS declared (so no scope_violation) but Phase 2 was declared
      // unchanged ⇒ the mechanical declared_but_unchanged failure fires.
      expect(v.failures.join(" ")).toContain("declared_but_unchanged");
      expect(v.failures.join(" ")).toContain("phase:2");
    }
  });

  it("missing baseline ⇒ legacy aggregate mode is signalled (caller audits legacy binding)", () => {
    const v = validateDesignReviewUpdate(
      baseInput(["- DR-1-5: Phase 5 — fee caliber fix"], { baselineSectionHashes: undefined }),
    );
    expect(v.status).toBe("ready");
    if (v.status === "ready") {
      expect(v.scope?.legacy).toBe(true);
    }
  });
});

describe("229 Phase 3: per-issue scope binding", () => {
  it("fixed without an own-id entry ⇒ per-issue binding failure", () => {
    const v = validateDesignReviewUpdate(
      baseInput(["- Phase 5 — aggregated prose without any issue id"], { baselineSectionHashes: BASELINE }),
    );
    expect(v.status).toBe("invalid");
    if (v.status === "invalid") {
      expect(v.failures.join(" ")).toContain('issue "DR-1-5" is fixed but');
    }
  });

  it("entry without any declared location (phases missing, no section) ⇒ binding failure naming the issue", () => {
    const v = validateDesignReviewUpdate(
      baseInput(
        // The entry cites the OWN id but its note carries NO Phase/section
        // marker and the declared set has no `section:` form — mechanically
        // the fix location is outside every declared bucket.
        ["- DR-1-5: prose note with no Phase or section marker"],
        {
          baselineSectionHashes: BASELINE,
          planContent: PLAN_BEFORE.replace("original phase 5 content", "revised"),
        },
      ),
    );
    expect(v.status).toBe("invalid");
    if (v.status === "invalid") {
      expect(v.failures.join(" ")).toContain('"DR-1-5" fix location is outside the declared scope');
    }
  });

  it("legacy numeric id maps by ## Issues order (B18) without a binding failure", () => {
    const legacyReceipt = receipt(["- 1: Phase 5 — fee caliber fix"]).replace(
      "| DR-1-5 | fee caliber | fixed | safe to resolve |",
      "| 1 | fee caliber | fixed | safe to resolve |",
    );
    const v = validateDesignReviewUpdate(
      baseInput(["- 1: Phase 5 — fee caliber fix"], {
        baselineSectionHashes: BASELINE,
        output: {
          kind: "standalone",
          receiptDoc: "/abs/receipt.md",
          receiptContent: legacyReceipt,
          baselineSectionsHash: FROZEN_HASH,
        },
      }),
    );
    // the numeric disposition maps to DR-1-5 and the entry carries its
    // location — binding passes; the verdict becomes ready.
    expect(v.status).toBe("ready");
  });

  it("READY exposes scope.declared for the coordinator's lastDeclaredScope (B14)", () => {
    const v = validateDesignReviewUpdate(
      baseInput(
        ["- DR-1-5: Phase 5 — fee caliber fix"],
        { baselineSectionHashes: BASELINE },
      ),
    );
    expect(v.status).toBe("ready");
    if (v.status === "ready") {
      expect(v.scope?.declared).toEqual({ phases: [5], sections: [] });
    }
  });
});
