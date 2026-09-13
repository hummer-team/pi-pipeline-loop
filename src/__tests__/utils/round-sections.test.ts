/**
 * @module round-sections.test
 * Phase 1 / 176 — shared round-section splitter.
 */
import { describe, it, expect } from "bun:test";
import { splitRoundSections } from "../../utils/round-sections";

/** Decodes \uXXXX sequences stored by the source-file encoding. */
function u(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

const ROUND_WHEN = u(String.raw`^#{1,2}\s*(?:第\s*(?<roundZh>\d+)\s*轮澄清|[Rr]ound\s+(?<roundEn>\d+))`);

describe("Phase 1 / 176: splitRoundSections", () => {
  it("splits by h1/h2 round headings and extends the last section to EOF", () => {
    const doc = [
      "# 第 1 轮澄清",
      "body one",
      "## 第 2 轮澄清",
      "body two",
      "trailing text",
    ].join("\n");
    const sections = splitRoundSections(doc, new RegExp(ROUND_WHEN));
    expect(sections.map((s) => s.round)).toEqual([1, 2]);
    expect(sections[0].text).toContain("body one");
    expect(sections[0].text).not.toContain("body two");
    // Last section runs to EOF.
    expect(sections[1].text).toContain("body two");
    expect(sections[1].text).toContain("trailing text");
  });

  it("does NOT split on h3 headings", () => {
    const doc = ["### 第 1 轮澄清", "body"].join("\n");
    const sections = splitRoundSections(doc, new RegExp(ROUND_WHEN));
    expect(sections).toHaveLength(0);
  });

  it("does NOT split on body mentions of Round N", () => {
    const doc = ["# Intro", "This discusses Round 5 in prose", "more text"].join("\n");
    const sections = splitRoundSections(doc, new RegExp(ROUND_WHEN));
    expect(sections).toHaveLength(0);
  });

  it("parses bilingual headings and extracts round numbers", () => {
    const doc = [
      "# 第 3 轮澄清",
      "zh body",
      "## Round 7 — fixes",
      "en body",
    ].join("\n");
    const sections = splitRoundSections(doc, new RegExp(ROUND_WHEN));
    expect(sections.map((s) => s.round)).toEqual([3, 7]);
  });

  it("ignores headings without a parseable round number", () => {
    const doc = ["# 第 轮澄清", "body"].join("\n");
    const sections = splitRoundSections(doc, new RegExp(ROUND_WHEN));
    expect(sections).toHaveLength(0);
  });
});
