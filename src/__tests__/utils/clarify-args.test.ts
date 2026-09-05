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
});
