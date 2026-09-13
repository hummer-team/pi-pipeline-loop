import { describe, it, expect } from "bun:test";
import { findLatestReviewReport, parseReviewConclusion } from "../../utils/review-conclusion";
import type { VerifyContractAnchors } from "../../utils/contract-loader";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Anchors mirroring the v6 review verify.md verdict runtime declaration. */
const VERDICT_ANCHORS: VerifyContractAnchors = {
  verdict: {
    patterns: [
      "结论\\s*[:：]\\s*[*_]{0,2}(不通过|通过)[*_]{0,2}",
      "Verdict\\s*[:：]\\s*[*_]{0,2}(PASS|FAIL)[*_]{0,2}",
      "Conclusion\\s*[:：]\\s*[*_]{0,2}(pass|fail)[*_]{0,2}",
    ],
    mode: "or",
  },
};

describe("findLatestReviewReport", () => {
  it("returns null when docs/review does not exist", async () => {
    const TMP = join(tmpdir(), "pi-rc-nodir-" + Date.now());
    await mkdir(TMP, { recursive: true });
    const result = await findLatestReviewReport(TMP);
    expect(result).toBeNull();
    await rm(TMP, { recursive: true, force: true });
  });

  it("returns null when docs/review exists but has no review files", async () => {
    const TMP = join(tmpdir(), "pi-rc-nofiles-" + Date.now());
    await mkdir(join(TMP, "docs", "review"), { recursive: true });
    await writeFile(join(TMP, "docs", "review", "other.md"), "not a review");
    const result = await findLatestReviewReport(TMP);
    expect(result).toBeNull();
    await rm(TMP, { recursive: true, force: true });
  });

  it("returns the latest review report by mtime", async () => {
    const TMP = join(tmpdir(), "pi-rc-latest-" + Date.now());
    const reviewDir = join(TMP, "docs", "review");
    await mkdir(reviewDir, { recursive: true });

    // Write two review reports with a time gap
    const old = join(reviewDir, "code_review_old.md");
    await writeFile(old, "old content");
    // Small delay to ensure different mtime
    await new Promise(r => setTimeout(r, 50));
    const newer = join(reviewDir, "code_review_new.md");
    await writeFile(newer, "new content");

    const result = await findLatestReviewReport(TMP);
    expect(result).toBe(newer);
    await rm(TMP, { recursive: true, force: true });
  });
});

describe("parseReviewConclusion", () => {
  it("returns null when no report exists", async () => {
    const TMP = join(tmpdir(), "pi-rc-null-" + Date.now());
    await mkdir(TMP, { recursive: true });
    const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
    expect(result).toBeNull();
    await rm(TMP, { recursive: true, force: true });
  });

  it("detects Blocker section → fail (source: blocker-section)", async () => {
    const TMP = join(tmpdir(), "pi-rc-blocker-" + Date.now());
    const reviewDir = join(TMP, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "code_review_1.md"),
      "# Code Review\n\n## Blocker\n- [ ] Blocker: critical bug\n\n## 结论\n结论：通过\n");

    const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("fail");
    expect(result!.source).toBe("blocker-section");
    await rm(TMP, { recursive: true, force: true });
  });

  it("detects High section → fail (source: blocker-section)", async () => {
    const TMP = join(tmpdir(), "pi-rc-high-" + Date.now());
    const reviewDir = join(TMP, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "code_review_1.md"),
      "# Code Review\n\n## High\n- [ ] High: important issue\n");

    const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
    expect(result!.verdict).toBe("fail");
    expect(result!.source).toBe("blocker-section");
    await rm(TMP, { recursive: true, force: true });
  });

  it("detects conclusion line '结论：不通过' → fail (source: conclusion-line)", async () => {
    const TMP = join(tmpdir(), "pi-rc-fail-" + Date.now());
    const reviewDir = join(TMP, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "code_review_1.md"),
      "# Code Review\n\n## Summary\nAll good.\n\n## 结论\n结论：不通过\n");

    const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
    expect(result!.verdict).toBe("fail");
    expect(result!.source).toBe("conclusion-line");
    await rm(TMP, { recursive: true, force: true });
  });

  it("detects conclusion line '结论：通过' → pass (source: conclusion-line)", async () => {
    const TMP = join(tmpdir(), "pi-rc-pass-" + Date.now());
    const reviewDir = join(TMP, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "code_review_1.md"),
      "# Code Review\n\n## Summary\nLooks good.\n\n## 结论\n结论：通过\n");

    const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
    expect(result!.verdict).toBe("pass");
    expect(result!.source).toBe("conclusion-line");
    await rm(TMP, { recursive: true, force: true });
  });

  it("detects conclusion line 'Conclusion: pass' → pass (English)", async () => {
    const TMP = join(tmpdir(), "pi-rc-en-pass-" + Date.now());
    const reviewDir = join(TMP, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "code_review_1.md"),
      "# Code Review\n\nConclusion: pass\n");

    const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
    expect(result!.verdict).toBe("pass");
    expect(result!.source).toBe("conclusion-line");
    await rm(TMP, { recursive: true, force: true });
  });

  it("no conclusion line → fail + warn (source: missing)", async () => {
    const TMP = join(tmpdir(), "pi-rc-missing-" + Date.now());
    const reviewDir = join(TMP, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "code_review_1.md"),
      "# Code Review\n\nSome content without a conclusion line.\n");

    const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
    expect(result!.verdict).toBe("fail");
    expect(result!.source).toBe("missing");
    expect(result!.warn).toBeDefined();
    await rm(TMP, { recursive: true, force: true });
  });

  it("NOT PASS marker → fail (source: blocker-section)", async () => {
    const TMP = join(tmpdir(), "pi-rc-notpass-" + Date.now());
    const reviewDir = join(TMP, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "code_review_1.md"),
      "# Code Review\n\nNOT PASS\n");

    const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
    expect(result!.verdict).toBe("fail");
    expect(result!.source).toBe("blocker-section");
    await rm(TMP, { recursive: true, force: true });
  });

  it("detects real report format '- 等级：Blocker' → fail (source: blocker-section)", async () => {
    const TMP = join(tmpdir(), "pi-rc-realformat-blocker-" + Date.now());
    const reviewDir = join(TMP, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "code_review_1.md"),
      "# Summary\n\n## Review发现以下问题\n### 问题 1\n- 问题: src/utils/foo.ts:45-50 code bug\n- 等级：Blocker\n- 符合规划：否\n- 是否修复：待修复\n\n## 结论\n- 结论：通过\n");

    const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("fail");
    expect(result!.source).toBe("blocker-section");
    await rm(TMP, { recursive: true, force: true });
  });

  it("detects real report format '- 等级：High' → fail (contradicts '結論：通过')", async () => {
    const TMP = join(tmpdir(), "pi-rc-realformat-high-" + Date.now());
    const reviewDir = join(TMP, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "code_review_1.md"),
      "# Summary\n\n## Review发现以下问题\n### 问题 1\n- 问题: some issue\n- 等级：High\n- 是否修复：待修复\n\n## 结论\n- 结论：通过\n");

    const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
    expect(result!.verdict).toBe("fail");
    expect(result!.source).toBe("blocker-section");
    await rm(TMP, { recursive: true, force: true });
  });

  it("detects real report format '- 等级：Medium' → fail (contradicts '結論：通过')", async () => {
    const TMP = join(tmpdir(), "pi-rc-realformat-medium-" + Date.now());
    const reviewDir = join(TMP, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "code_review_1.md"),
      "# Summary\n\n### 问题 1\n- 等级: Medium\n- 是否修复：待修复\n\n## 结论\n- 结论：通过\n");

    const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
    expect(result!.verdict).toBe("fail");
    expect(result!.source).toBe("blocker-section");
    await rm(TMP, { recursive: true, force: true });
  });

  // ── Phase 0 / 175: bilingual + bold/italic tolerant verdict ─────────────

  describe("Phase 0 / 175: bilingual + bold/italic tolerant verdict", () => {
    it("detects `结论：**通过**` with bold markup → pass", async () => {
      const TMP = join(tmpdir(), "pi-rc-bold-pass-" + Date.now());
      const reviewDir = join(TMP, "docs", "review");
      await mkdir(reviewDir, { recursive: true });
      await writeFile(join(reviewDir, "code_review_1.md"),
        "# Review\n\n结论：**通过**\n");
      const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
      expect(result!.verdict).toBe("pass");
      expect(result!.source).toBe("conclusion-line");
      await rm(TMP, { recursive: true, force: true });
    });

    it("detects `结论：_不通过_` with italic markup → fail", async () => {
      const TMP = join(tmpdir(), "pi-rc-italic-fail-" + Date.now());
      const reviewDir = join(TMP, "docs", "review");
      await mkdir(reviewDir, { recursive: true });
      await writeFile(join(reviewDir, "code_review_1.md"),
        "# Review\n\n结论：_不通过_\n");
      const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
      expect(result!.verdict).toBe("fail");
      expect(result!.source).toBe("conclusion-line");
      await rm(TMP, { recursive: true, force: true });
    });

    it("detects `结论:通过` with half-width colon → pass", async () => {
      const TMP = join(tmpdir(), "pi-rc-half-colon-" + Date.now());
      const reviewDir = join(TMP, "docs", "review");
      await mkdir(reviewDir, { recursive: true });
      await writeFile(join(reviewDir, "code_review_1.md"),
        "# Review\n\n结论:通过\n");
      const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
      expect(result!.verdict).toBe("pass");
      expect(result!.source).toBe("conclusion-line");
      await rm(TMP, { recursive: true, force: true });
    });

    it("detects `Verdict: PASS` (English) → pass", async () => {
      const TMP = join(tmpdir(), "pi-rc-verdict-en-pass-" + Date.now());
      const reviewDir = join(TMP, "docs", "review");
      await mkdir(reviewDir, { recursive: true });
      await writeFile(join(reviewDir, "code_review_1.md"),
        "# Review\n\nVerdict: PASS\n");
      const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
      expect(result!.verdict).toBe("pass");
      expect(result!.source).toBe("conclusion-line");
      await rm(TMP, { recursive: true, force: true });
    });

    it("detects `Verdict: FAIL` (English) → fail", async () => {
      const TMP = join(tmpdir(), "pi-rc-verdict-en-fail-" + Date.now());
      const reviewDir = join(TMP, "docs", "review");
      await mkdir(reviewDir, { recursive: true });
      await writeFile(join(reviewDir, "code_review_1.md"),
        "# Review\n\nVerdict: FAIL\n");
      const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
      expect(result!.verdict).toBe("fail");
      expect(result!.source).toBe("conclusion-line");
      await rm(TMP, { recursive: true, force: true });
    });

    it("detects `Verdict: **PASS**` with bold → pass", async () => {
      const TMP = join(tmpdir(), "pi-rc-verdict-bold-" + Date.now());
      const reviewDir = join(TMP, "docs", "review");
      await mkdir(reviewDir, { recursive: true });
      await writeFile(join(reviewDir, "code_review_1.md"),
        "# Review\n\nVerdict: **PASS**\n");
      const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
      expect(result!.verdict).toBe("pass");
      expect(result!.source).toBe("conclusion-line");
      await rm(TMP, { recursive: true, force: true });
    });

    it("detects `Conclusion: **fail**` with bold → fail", async () => {
      const TMP = join(tmpdir(), "pi-rc-conclusion-bold-" + Date.now());
      const reviewDir = join(TMP, "docs", "review");
      await mkdir(reviewDir, { recursive: true });
      await writeFile(join(reviewDir, "code_review_1.md"),
        "# Review\n\nConclusion: **fail**\n");
      const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
      expect(result!.verdict).toBe("fail");
      expect(result!.source).toBe("conclusion-line");
      await rm(TMP, { recursive: true, force: true });
    });

    it("does NOT misjudge `结论：待定` (pending) — returns missing fail", async () => {
      const TMP = join(tmpdir(), "pi-rc-pending-" + Date.now());
      const reviewDir = join(TMP, "docs", "review");
      await mkdir(reviewDir, { recursive: true });
      await writeFile(join(reviewDir, "code_review_1.md"),
        "# Review\n\n结论：待定\n");
      const result = await parseReviewConclusion(TMP, VERDICT_ANCHORS);
      // 待定 should NOT match pass or fail — conservative fallback to missing
      expect(result!.verdict).toBe("fail");
      expect(result!.source).toBe("missing");
      await rm(TMP, { recursive: true, force: true });
    });
  });
});

describe("Phase 2 / 176: contract-unavailable (fail-open)", () => {
  it("returns contract-unavailable when the verdict anchor is missing", async () => {
    const TMP = join(tmpdir(), "pi-rc-contract-" + Date.now());
    const reviewDir = join(TMP, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "code_review_1.md"), "# Review\n\n结论：通过\n");

    const result = await parseReviewConclusion(TMP, {});
    expect(result!.verdict).toBeNull();
    expect(result!.source).toBe("contract-unavailable");
    await rm(TMP, { recursive: true, force: true });
  });

  it("blocker scan still wins without verdict anchors (code-internal, unchanged)", async () => {
    const TMP = join(tmpdir(), "pi-rc-contract-blocker-" + Date.now());
    const reviewDir = join(TMP, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "code_review_1.md"), "# Review\n- 等级：Blocker\n");

    const result = await parseReviewConclusion(TMP, {});
    expect(result!.verdict).toBe("fail");
    expect(result!.source).toBe("blocker-section");
    await rm(TMP, { recursive: true, force: true });
  });
});
