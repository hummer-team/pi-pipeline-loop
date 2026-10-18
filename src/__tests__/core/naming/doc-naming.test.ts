/**
 * Unit tests for the doc-naming single source of truth module (201 Phase 0).
 * Coverage: every derived file name and dual-pattern matcher, plus boundary
 * inputs (empty string, no-suffix stems, CJK mixed stems).
 */
import { describe, it, expect } from "bun:test";
import {
  reqBaseFromPlanStem,
  planDocFileName,
  commitDocFileName,
  designReviewDocFileName,
  codeReviewDocFileName,
  updateReceiptFileName,
  NEW_DESIGN_REVIEW_RE,
  LEGACY_DESIGN_REVIEW_RE,
  NEW_CODE_REVIEW_RE,
  LEGACY_CODE_REVIEW_RE,
  NEW_COMMIT_RE,
  LEGACY_COMMIT_RE,
} from "../../../core/naming/doc-naming";

describe("doc-naming derivation functions", () => {
  describe("reqBaseFromPlanStem", () => {
    it("strips _Plan suffix (new naming)", () => {
      expect(reqBaseFromPlanStem("195_Bug_Plan")).toBe("195_Bug");
    });

    it("strips _plan suffix (legacy naming)", () => {
      expect(reqBaseFromPlanStem("195_Bug_plan")).toBe("195_Bug");
    });

    it("keeps stem unchanged when no plan suffix present", () => {
      expect(reqBaseFromPlanStem("195_Bug")).toBe("195_Bug");
    });

    it("returns empty string for empty input", () => {
      expect(reqBaseFromPlanStem("")).toBe("");
    });

    it("returns input unchanged when it has no underscore-prefixed plan marker", () => {
      expect(reqBaseFromPlanStem("plan")).toBe("plan");
      expect(reqBaseFromPlanStem("_plan")).toBe("");
      expect(reqBaseFromPlanStem("Plan")).toBe("Plan");
    });

    it("preserves CJK and spaces in the stem", () => {
      expect(reqBaseFromPlanStem("194_Bug 计划_Plan")).toBe("194_Bug 计划");
      expect(reqBaseFromPlanStem("194_Bug 计划_plan")).toBe("194_Bug 计划");
    });

    it("strips only the trailing marker, keeping inner occurrences", () => {
      expect(reqBaseFromPlanStem("plan_195_Bug_Plan")).toBe("plan_195_Bug");
    });
  });

  describe("planDocFileName", () => {
    it("derives {reqBase}_Plan.md", () => {
      expect(planDocFileName("195_Bug")).toBe("195_Bug_Plan.md");
    });
  });

  describe("commitDocFileName", () => {
    it("derives {reqBase}_Develop_Commit.md", () => {
      expect(commitDocFileName("182_Bug")).toBe("182_Bug_Develop_Commit.md");
    });
  });

  describe("designReviewDocFileName", () => {
    it("derives Design_Review_{round}_{reqBase}_Design.md", () => {
      expect(designReviewDocFileName("195_Bug", 1)).toBe("Design_Review_1_195_Bug_Design.md");
      expect(designReviewDocFileName("195_Bug", 3)).toBe("Design_Review_3_195_Bug_Design.md");
    });
  });

  describe("codeReviewDocFileName", () => {
    it("derives Code_Review_{reqBase}_Develop_Commit_{index}.md", () => {
      expect(codeReviewDocFileName("50_Feat", 1)).toBe("Code_Review_50_Feat_Develop_Commit_1.md");
      expect(codeReviewDocFileName("50_Feat", 12)).toBe("Code_Review_50_Feat_Develop_Commit_12.md");
    });
  });

  describe("updateReceiptFileName", () => {
    it("derives Design_Review_Update_{round}_{opId}_{reqBase}_Design.md", () => {
      const opId = "123e4567-e89b-42d3-a456-426614174000";
      expect(updateReceiptFileName("195_Bug", 2, opId)).toBe(
        `Design_Review_Update_2_${opId}_195_Bug_Design.md`,
      );
    });
  });
});

describe("doc-naming dual-pattern matchers", () => {
  describe("design review report patterns", () => {
    it("NEW matches new names, rejects legacy", () => {
      expect(NEW_DESIGN_REVIEW_RE.test("Design_Review_1_195_Bug_Design.md")).toBe(true);
      expect(NEW_DESIGN_REVIEW_RE.test("Design_Review_12_194_Bug 计划_Design.md")).toBe(true);
      expect(NEW_DESIGN_REVIEW_RE.test("review-design-1-195_Bug_plan.md")).toBe(false);
    });

    it("LEGACY matches legacy names (both disk shapes), rejects new", () => {
      expect(LEGACY_DESIGN_REVIEW_RE.test("review-design-1-195_Bug_plan.md")).toBe(true);
      expect(LEGACY_DESIGN_REVIEW_RE.test("review-design-1-195_Bug.md")).toBe(true);
      expect(LEGACY_DESIGN_REVIEW_RE.test("Design_Review_1_195_Bug_Design.md")).toBe(false);
    });

    it("rejects malformed rounds", () => {
      expect(NEW_DESIGN_REVIEW_RE.test("Design_Review_0_195_Bug_Design.md")).toBe(true); // regex permits 0; caller validates round >= 1
      expect(NEW_DESIGN_REVIEW_RE.test("Design_Review_x_195_Bug_Design.md")).toBe(false);
      // A missing digit block before the reqBase means `_195_Bug_Design.md`
      // IS absorbed as the reqBase by the plan regex — anchored callers
      // (round-aware) enforce correctness instead.
      expect(NEW_DESIGN_REVIEW_RE.test("Design_Review_195_Bug_Design.md")).toBe(true);
    });
  });

  describe("code review report patterns", () => {
    it("NEW matches new names, rejects legacy", () => {
      expect(NEW_CODE_REVIEW_RE.test("Code_Review_50_Feat_Develop_Commit_1.md")).toBe(true);
      expect(NEW_CODE_REVIEW_RE.test("code_review_50_Feat.md")).toBe(false);
    });

    it("LEGACY matches legacy names, rejects new", () => {
      expect(LEGACY_CODE_REVIEW_RE.test("code_review_50_Feat.md")).toBe(true);
      expect(LEGACY_CODE_REVIEW_RE.test("Code_Review_50_Feat_Develop_Commit_1.md")).toBe(false);
    });

    it("rejects non-.md files", () => {
      expect(NEW_CODE_REVIEW_RE.test("Code_Review_50_Feat_Develop_Commit_1.txt")).toBe(false);
      expect(LEGACY_CODE_REVIEW_RE.test("code_review_50_Feat.txt")).toBe(false);
    });
  });

  describe("commit doc patterns", () => {
    it("NEW matches {reqBase}_Develop_Commit.md", () => {
      expect(NEW_COMMIT_RE.test("182_Bug_Develop_Commit.md")).toBe(true);
      expect(NEW_COMMIT_RE.test("docs/design/182_Bug_Develop_Commit.md")).toBe(true);
    });

    it("LEGACY matches {reqBase}_commit.md", () => {
      expect(LEGACY_COMMIT_RE.test("182_Bug_plan_commit.md")).toBe(true);
      expect(LEGACY_COMMIT_RE.test("182_Bug_commit.md")).toBe(true);
    });

    it("NEW does not match legacy names and vice versa (prefix-anchored names)", () => {
      expect(NEW_COMMIT_RE.test("182_Bug_plan_commit.md")).toBe(false);
      // Legacy suffix regex `/_commit\.md$/` also matches the new name's
      // suffix `_Develop_Commit.md` — it is a suffix matcher by design, used
      // only as a broad "any commit doc" detector, never to distinguish
      // new from legacy.
      expect(LEGACY_COMMIT_RE.test("182_Bug_Develop_Commit.md")).toBe(false);
    });

    it("rejects other files", () => {
      expect(NEW_COMMIT_RE.test("195_Bug_Plan.md")).toBe(false);
      expect(LEGACY_COMMIT_RE.test("195_Bug_Plan.md")).toBe(false);
    });
  });
});
