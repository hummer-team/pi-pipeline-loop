/**
 * 221 Phase 1: clarify anchor RESOLUTION (job JSON → verify.md → defaults).
 *
 * The JSON-file parsing lives in `clarify-protocol-config.test.ts`; this suite
 * pins the precedence, the fail-open fallbacks and the additivity rules the
 * parsers and prompt injectors depend on.
 */

import { describe, it, expect, spyOn } from "bun:test";
import {
  COMPAT_ROUND_PATTERN,
  DEFAULT_CLARIFY_PROTOCOL,
  resolveClarifyAnchors,
} from "../../core/auto-pipeline/clarify-anchors";

function quiet<T>(run: () => T): T {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    return run();
  } finally {
    warn.mockRestore();
  }
}

describe("resolveClarifyAnchors precedence", () => {
  it("job-declared headings win over everything", () => {
    const anchors = resolveClarifyAnchors({
      job: {
        assessmentHeading: ["## Requirement Assessment"],
        goalHeading: ["## Goal"],
        ledgerHeading: ["## Decision Ledger"],
        verdictReady: ["ready"],
        verdictNeedsClarify: ["needs-clarify"],
      },
    });
    expect(anchors.assessmentHeading[0]).toBe("## Requirement Assessment");
    expect(anchors.goalHeading[0]).toBe("## Goal");
    expect(anchors.ledgerHeading[0]).toBe("## Decision Ledger");
    expect(anchors.verdictNeedsClarify[0]).toBe("needs-clarify");
  });

  it("verify.md round patterns are used when the job declares none", () => {
    const anchors = resolveClarifyAnchors({
      verify: { roundHeading: { patterns: ["^## Round (?<roundEn>\\d+)"], mode: "and" } },
    });
    expect(anchors.roundPatterns[0]!.source).toBe("^## Round (?<roundEn>\\d+)");
    // The compatibility alias is always appended for deployed documents.
    expect(anchors.roundPatterns.at(-1)!.source).toBe(COMPAT_ROUND_PATTERN);
  });

  it("verify.md answer patterns are used when the job declares no answers", () => {
    const anchors = resolveClarifyAnchors({
      verify: { answerField: { patterns: ["Answer\\s*:"], mode: "or" } },
    });
    expect(anchors.answerPatterns[0]!.source).toBe("Answer\\s*:");
  });

  it("falls back to the bilingual defaults with no configuration at all", () => {
    const anchors = resolveClarifyAnchors({});
    expect(anchors.assessmentHeading).toEqual(DEFAULT_CLARIFY_PROTOCOL.assessmentHeading);
    expect(anchors.questionPatterns.map((p) => p.source)).toEqual(
      DEFAULT_CLARIFY_PROTOCOL.questionPatterns,
    );
    expect(anchors.answerPrimary).toBe("答：");
    expect(anchors.completionPrimary).toBe("## 模型确认");
  });
});

describe("resolveClarifyAnchors fail-open behavior", () => {
  it("drops an invalid question pattern group and keeps the defaults", () => {
    const anchors = quiet(() =>
      resolveClarifyAnchors({ job: { questionPatterns: ["([unclosed"] } }),
    );
    expect(anchors.questionPatterns.map((p) => p.source)).toEqual(
      DEFAULT_CLARIFY_PROTOCOL.questionPatterns,
    );
  });

  it("falls back from a broken job round group to verify.md", () => {
    const anchors = quiet(() =>
      resolveClarifyAnchors({
        job: { roundPatterns: ["^## 第 (?<roundZh>\\d+ 轮"] },
        verify: { roundHeading: { patterns: ["^## Round (?<roundEn>\\d+)"], mode: "and" } },
      }),
    );
    expect(anchors.roundPatterns[0]!.source).toBe("^## Round (?<roundEn>\\d+)");
  });

  it("never throws on an empty verify anchor set", () => {
    expect(() => quiet(() => resolveClarifyAnchors({ verify: {} }))).not.toThrow();
  });
});

describe("resolveClarifyAnchors model confirmation aliases", () => {
  it("is additive: job aliases + completionMarker + defaults, deduped", () => {
    const anchors = resolveClarifyAnchors({
      job: { modelConfirm: ["## Custom Confirm"] },
      completionMarker: ["## 模型确认", "## Model Confirmation"],
    });
    expect(anchors.modelConfirm).toEqual([
      "## Custom Confirm",
      "## 模型确认",
      "## Model Confirmation",
    ]);
    expect(anchors.completionPrimary).toBe("## Custom Confirm");
  });

  it("keeps the configured stage marker primary when the job declares none", () => {
    const anchors = resolveClarifyAnchors({
      completionMarker: ["## Model Confirmation", "## 模型确认"],
    });
    expect(anchors.completionPrimary).toBe("## Model Confirmation");
    expect(anchors.modelConfirm).toContain("## 模型确认");
  });

  it("reports the configured answer primary", () => {
    const anchors = resolveClarifyAnchors({ job: { answerMarkers: ["Answer："] } });
    expect(anchors.answerPrimary).toBe("Answer：");
    expect(anchors.answerPatterns.map((p) => p.source)).toContain("^\\s*Answer：");
  });
});
