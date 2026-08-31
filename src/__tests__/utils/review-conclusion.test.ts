import { describe, it, expect } from "bun:test";
import { findLatestReviewReport, parseReviewConclusion } from "../../utils/review-conclusion";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
    const result = await parseReviewConclusion(TMP);
    expect(result).toBeNull();
    await rm(TMP, { recursive: true, force: true });
  });

  it("detects Blocker section → fail (source: blocker-section)", async () => {
    const TMP = join(tmpdir(), "pi-rc-blocker-" + Date.now());
    const reviewDir = join(TMP, "docs", "review");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "code_review_1.md"),
      "# Code Review\n\n## Blocker\n- [ ] Blocker: critical bug\n\n## 结论\n结论：通过\n");

    const result = await parseReviewConclusion(TMP);
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

    const result = await parseReviewConclusion(TMP);
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

    const result = await parseReviewConclusion(TMP);
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

    const result = await parseReviewConclusion(TMP);
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

    const result = await parseReviewConclusion(TMP);
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

    const result = await parseReviewConclusion(TMP);
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

    const result = await parseReviewConclusion(TMP);
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

    const result = await parseReviewConclusion(TMP);
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

    const result = await parseReviewConclusion(TMP);
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

    const result = await parseReviewConclusion(TMP);
    expect(result!.verdict).toBe("fail");
    expect(result!.source).toBe("blocker-section");
    await rm(TMP, { recursive: true, force: true });
  });
});
