import { describe, it, expect } from "bun:test";
import { deriveClarifyForwardArgs } from "../../utils/clarify-args";

describe("deriveClarifyForwardArgs", () => {
  it("returns 'fresh' when no round headings found", () => {
    const result = deriveClarifyForwardArgs("# Requirement\nSome text");
    expect(result).toEqual({ kind: "fresh", args: "1" });
  });

  it("returns 'await-answer' when latest round has no answer markers", () => {
    const doc = `# 第 1 轮澄清
- Question 1
- Question 2

No answers yet`;
    const result = deriveClarifyForwardArgs(doc);
    expect(result).toEqual({ kind: "await-answer", round: 1 });
  });

  it("returns 'full-und?' when latest round has answer but no confirmation", () => {
    const doc = `# 第 1 轮澄清（feat-design-plan-agent）
- Question 1
- **答**：Answer 1

Some other text`;
    const result = deriveClarifyForwardArgs(doc);
    expect(result).toEqual({ kind: "full-und?", round: 1 });
  });

  it("returns 'confirmed' when latest round has confirmation marker", () => {
    const doc = `# 第 1 轮澄清
- **答**：Answer 1

## 模型确认（full-und? 收口）
- C1: confirmed`;
    const result = deriveClarifyForwardArgs(doc);
    expect(result).toEqual({ kind: "confirmed", round: 1 });
  });

  it("handles 3 rounds with latest having answer (82_Feat.md real shape)", () => {
    const doc = `# 第 1 轮澄清（feat-design-plan-agent）
- Q1
- **答**：A1

# 第 2 轮澄清
- Q2
- **答**：A2

# 第 3 轮澄清
- Q3
- 答：A3

Some text`;
    const result = deriveClarifyForwardArgs(doc);
    expect(result).toEqual({ kind: "full-und?", round: 3 });
  });

  it("handles 3 rounds with latest confirmed", () => {
    const doc = `# 第 1 轮澄清
- **答**：A1

# 第 2 轮澄清
- **答**：A2

# 第 3 轮澄清
- **答**：A3

## 模型确认
- All confirmed`;
    const result = deriveClarifyForwardArgs(doc);
    expect(result).toEqual({ kind: "confirmed", round: 3 });
  });

  it("handles answer with colon (答:)", () => {
    const doc = `# 第 1 轮澄清
- Q1
- 答: Answer with colon`;
    const result = deriveClarifyForwardArgs(doc);
    expect(result).toEqual({ kind: "full-und?", round: 1 });
  });

  it("returns empty doc as fresh", () => {
    const result = deriveClarifyForwardArgs("");
    expect(result).toEqual({ kind: "fresh", args: "1" });
  });

  // ── Phase 0 / 175: bilingual round heading tests ──────────────────────────

  describe("Phase 0 / 175: bilingual round heading", () => {
    it("recognizes English `# Round 6 …` heading", () => {
      const doc = `# Round 6 — final questions
- Q1
- Answer: A1`;
      const result = deriveClarifyForwardArgs(doc);
      expect(result).toEqual({ kind: "full-und?", round: 6 });
    });

    it("recognizes English `## round 3 — x` heading (h2, lowercase)", () => {
      const doc = `## round 3 — minor fixes
- Q1`;
      const result = deriveClarifyForwardArgs(doc);
      expect(result).toEqual({ kind: "await-answer", round: 3 });
    });

    it("recognizes Chinese `# 第 2 轮澄清（…）` with parenthetical suffix", () => {
      const doc = `# 第 2 轮澄清（feat-agent）
- Q1
- **答**：A1

## Model Confirmation
- confirmed`;
      const result = deriveClarifyForwardArgs(doc);
      expect(result).toEqual({ kind: "confirmed", round: 2 });
    });

    it("recognizes English `## Model Confirmation` marker", () => {
      const doc = `# Round 1
- Answer: A1

## Model Confirmation
- C1: confirmed`;
      const result = deriveClarifyForwardArgs(doc);
      expect(result).toEqual({ kind: "confirmed", round: 1 });
    });

    it("recognizes English `Answer:` answer field", () => {
      const doc = `# Round 1
- Q1
- Answer: A1`;
      const result = deriveClarifyForwardArgs(doc);
      expect(result).toEqual({ kind: "full-und?", round: 1 });
    });

    it("handles mixed Chinese and English rounds — latest wins", () => {
      const doc = `# 第 1 轮澄清
- **答**：A1

# Round 2
- Answer: A2`;
      const result = deriveClarifyForwardArgs(doc);
      expect(result).toEqual({ kind: "full-und?", round: 2 });
    });
  });

  // ── Phase 0 / 175: false-positive prevention ──────────────────────────────

  describe("Phase 0 / 175: false-positive prevention", () => {
    it("does NOT match h3 heading `### 3.0 对 Round 2 的修正`", () => {
      const doc = `### 3.0 对 Round 2 的修正
Some content here
- No round heading at h1/h2 level`;
      const result = deriveClarifyForwardArgs(doc);
      expect(result).toEqual({ kind: "fresh", args: "1" });
    });

    it("does NOT match h2 heading that mentions Round N but is not a round heading", () => {
      const doc = `## 问题 6：…替代 Round 2…
Some content
- No actual round heading`;
      const result = deriveClarifyForwardArgs(doc);
      expect(result).toEqual({ kind: "fresh", args: "1" });
    });

    it("does NOT match body text mentioning `Round N`", () => {
      const doc = `# Some Heading
This paragraph discusses Round 3 modifications in detail.
- Another line about Round 5`;
      const result = deriveClarifyForwardArgs(doc);
      expect(result).toEqual({ kind: "fresh", args: "1" });
    });

    it("does NOT match body text mentioning `第 N 轮澄清`", () => {
      const doc = `# Some Heading
This paragraph discusses 第 3 轮澄清 modifications.`;
      const result = deriveClarifyForwardArgs(doc);
      expect(result).toEqual({ kind: "fresh", args: "1" });
    });
  });
});
