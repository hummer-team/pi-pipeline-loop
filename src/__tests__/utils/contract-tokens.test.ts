/**
 * Phase 0 / 175: Tests for CONTRACT_TOKENS single source of truth.
 *
 * Validates that:
 * 1. Round heading patterns correctly match/don't match bilingual headings.
 * 2. Verdict patterns correctly handle bold/italic tolerance.
 * 3. `待定` is not misidentified as pass/fail.
 */
import { describe, it, expect } from "bun:test";
import { CONTRACT_TOKENS } from "../../constants";

describe("CONTRACT_TOKENS (Phase 0 / 175)", () => {
  describe("ROUND_HEADING_ZH", () => {
    const re = new RegExp(CONTRACT_TOKENS.ROUND_HEADING_ZH, "gm");

    it("matches `# 第 1 轮澄清`", () => {
      expect(re.test("# 第 1 轮澄清")).toBe(true);
    });

    it("matches `## 第 3 轮澄清（extra info）`", () => {
      re.lastIndex = 0;
      expect(re.test("## 第 3 轮澄清（extra info）")).toBe(true);
    });

    it("does NOT match `### 第 2 轮澄清` (h3)", () => {
      re.lastIndex = 0;
      expect(re.test("### 第 2 轮澄清")).toBe(false);
    });
  });

  describe("ROUND_HEADING_EN", () => {
    const re = new RegExp(CONTRACT_TOKENS.ROUND_HEADING_EN, "gm");

    it("matches `# Round 6`", () => {
      expect(re.test("# Round 6")).toBe(true);
    });

    it("matches `## round 3 — fix`", () => {
      re.lastIndex = 0;
      expect(re.test("## round 3 — fix")).toBe(true);
    });

    it("does NOT match `### Round 2` (h3)", () => {
      re.lastIndex = 0;
      expect(re.test("### Round 2")).toBe(false);
    });

    it("does NOT match body text `about Round 5`", () => {
      re.lastIndex = 0;
      expect(re.test("about Round 5 in the document")).toBe(false);
    });
  });

  describe("VERDICT_ZH (bold/italic tolerant)", () => {
    const re = new RegExp(CONTRACT_TOKENS.VERDICT_ZH);

    it("matches `结论：通过`", () => {
      expect(re.test("结论：通过")).toBe(true);
    });

    it("matches `结论：不通过`", () => {
      re.lastIndex = 0;
      expect(re.test("结论：不通过")).toBe(true);
    });

    it("matches `结论：**通过**` (bold)", () => {
      re.lastIndex = 0;
      expect(re.test("结论：**通过**")).toBe(true);
    });

    it("matches `结论：_不通过_` (italic)", () => {
      re.lastIndex = 0;
      expect(re.test("结论：_不通过_")).toBe(true);
    });

    it("matches `结论:通过` (half-width colon)", () => {
      re.lastIndex = 0;
      expect(re.test("结论:通过")).toBe(true);
    });

    it("does NOT match `结论：待定`", () => {
      re.lastIndex = 0;
      expect(re.test("结论：待定")).toBe(false);
    });

    it("extracts pass/fail correctly", () => {
      re.lastIndex = 0;
      const m1 = re.exec("结论：通过");
      expect(m1?.[1]).toBe("通过");

      re.lastIndex = 0;
      const m2 = re.exec("结论：**不通过**");
      expect(m2?.[1]).toBe("不通过");
    });
  });

  describe("VERDICT_EN_VERDICT", () => {
    const re = new RegExp(CONTRACT_TOKENS.VERDICT_EN_VERDICT, "i");

    it("matches `Verdict: PASS`", () => {
      expect(re.test("Verdict: PASS")).toBe(true);
    });

    it("matches `Verdict: FAIL`", () => {
      re.lastIndex = 0;
      expect(re.test("Verdict: FAIL")).toBe(true);
    });

    it("matches `Verdict: **PASS**` (bold)", () => {
      re.lastIndex = 0;
      expect(re.test("Verdict: **PASS**")).toBe(true);
    });

    it("matches `verdict: pass` (case-insensitive)", () => {
      re.lastIndex = 0;
      expect(re.test("verdict: pass")).toBe(true);
    });
  });

  describe("VERDICT_EN_CONCLUSION", () => {
    const re = new RegExp(CONTRACT_TOKENS.VERDICT_EN_CONCLUSION, "i");

    it("matches `Conclusion: pass`", () => {
      expect(re.test("Conclusion: pass")).toBe(true);
    });

    it("matches `Conclusion: **fail**` (bold)", () => {
      re.lastIndex = 0;
      expect(re.test("Conclusion: **fail**")).toBe(true);
    });
  });

  describe("ANSWER_FIELD (bilingual)", () => {
    const re = new RegExp(CONTRACT_TOKENS.ANSWER_FIELD);

    it("matches `答：Answer`", () => {
      expect(re.test("答：Answer")).toBe(true);
    });

    it("matches `答: Answer` (half-width)", () => {
      re.lastIndex = 0;
      expect(re.test("答: Answer")).toBe(true);
    });

    it("matches `**答**`", () => {
      re.lastIndex = 0;
      expect(re.test("**答**")).toBe(true);
    });

    it("matches `Answer: yes`", () => {
      re.lastIndex = 0;
      expect(re.test("Answer: yes")).toBe(true);
    });
  });

  describe("MODEL_CONFIRM (bilingual)", () => {
    const reZh = new RegExp(CONTRACT_TOKENS.MODEL_CONFIRM_ZH, "gm");
    const reEn = new RegExp(CONTRACT_TOKENS.MODEL_CONFIRM_EN, "gm");

    it("matches `## 模型确认`", () => {
      expect(reZh.test("## 模型确认")).toBe(true);
    });

    it("matches `## Model Confirmation`", () => {
      expect(reEn.test("## Model Confirmation")).toBe(true);
    });

    it("does NOT match `### 模型确认` (h3)", () => {
      reZh.lastIndex = 0;
      expect(reZh.test("### 模型确认")).toBe(false);
    });
  });
});
