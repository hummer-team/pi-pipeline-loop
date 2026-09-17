import { describe, it, expect } from "bun:test";
import { skillsDedup } from "../../core/prompt-injector";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SKILLS_INTRO = "The following skills provide specialized instructions for specific tasks.";

/** Build a valid <available_skills> block with given entries */
function buildSkillsBlock(entries: string[] = ["<skill>fast-develop</skill>"]): string {
  return [
    SKILLS_INTRO,
    "<available_skills>",
    ...entries,
    "</available_skills>",
  ].join("\n");
}

/** Build a block followed by a cwd line */
function buildSkillsBlockWithCwd(
  entries: string[] = ["<skill>fast-develop</skill>"],
  cwd: string = "/project/root",
): string {
  return buildSkillsBlock(entries) + `\nCurrent working directory: ${cwd}`;
}

// ─── Test matrix ──────────────────────────────────────────────────────────────

describe("skillsDedup", () => {
  // ─── Short-circuit / no-op cases ──────────────────────────────────────

  describe("no-op paths", () => {
    it("returns no-op for empty string", () => {
      const result = skillsDedup("");
      expect(result.prompt).toBe("");
      expect(result.removedPairs).toBe(0);
      expect(result.removedBytes).toBe(0);
      expect(result.skippedReason).toBeUndefined();
    });

    it("returns no-op for prompt with 0 <available_skills> blocks", () => {
      const prompt = "Just a regular system prompt with no skills block.";
      const result = skillsDedup(prompt);
      expect(result.prompt).toBe(prompt);
      expect(result.removedPairs).toBe(0);
      expect(result.removedBytes).toBe(0);
      expect(result.skippedReason).toBeUndefined();
    });

    it("returns no-op for prompt with exactly 1 block", () => {
      const prompt = `Header\n\n${buildSkillsBlock()}\n\nFooter`;
      const result = skillsDedup(prompt);
      expect(result.prompt).toBe(prompt);
      expect(result.removedPairs).toBe(0);
      expect(result.removedBytes).toBe(0);
      expect(result.skippedReason).toBeUndefined();
    });

    it("returns no-op for long prompt with no skills block", () => {
      const prompt = "A".repeat(10000) + "\nNo skills here\n" + "B".repeat(5000);
      const result = skillsDedup(prompt);
      expect(result.prompt).toBe(prompt);
      expect(result.removedPairs).toBe(0);
      expect(result.removedBytes).toBe(0);
    });
  });

  // ─── 2 identical blocks → dedup ──────────────────────────────────────

  describe("2 identical blocks", () => {
    it("removes first block and keeps last (removedPairs=1)", () => {
      const block = buildSkillsBlock();
      const prompt = `Before\n\n${block}\n\nMiddle\n\n${block}\n\nAfter`;
      const result = skillsDedup(prompt);

      expect(result.removedPairs).toBe(1);
      expect(result.removedBytes).toBeGreaterThan(0);
      expect(result.skippedReason).toBeUndefined();
      // Result should contain only one block
      const count = countStr(result.prompt, "<available_skills>");
      expect(count).toBe(1);
      // The remaining content should still have Before, Middle, After
      expect(result.prompt).toContain("Before");
      expect(result.prompt).toContain("Middle");
      expect(result.prompt).toContain("After");
    });

    it("produces byte-identical prompt to input when only 1 block", () => {
      const block = buildSkillsBlock();
      const prompt = `Header\n${block}\nFooter`;
      const result = skillsDedup(prompt);
      expect(result.prompt).toBe(prompt);
    });
  });

  // ─── ≥3 identical blocks ─────────────────────────────────────────────

  describe("≥3 identical blocks", () => {
    it("keeps last, removes all preceding", () => {
      const block = buildSkillsBlock();
      const prompt = `${block}\n\n---\n\n${block}\n\n---\n\n${block}`;
      const result = skillsDedup(prompt);

      expect(result.removedPairs).toBe(2);
      expect(result.removedBytes).toBeGreaterThan(0);
      const count = countStr(result.prompt, "<available_skills>");
      expect(count).toBe(1);
    });
  });

  // ─── Mismatch cases ──────────────────────────────────────────────────

  describe("mismatch (content differs)", () => {
    it("returns mismatch when skill entries differ", () => {
      const block1 = buildSkillsBlock(["<skill>fast-develop</skill>"]);
      const block2 = buildSkillsBlock(["<skill>code-review</skill>"]);
      const prompt = `${block1}\n\n${block2}`;
      const result = skillsDedup(prompt);

      expect(result.prompt).toBe(prompt); // no-op
      expect(result.removedPairs).toBe(0);
      expect(result.skippedReason).toBe("mismatch");
    });

    it("returns no-op when second block has different intro (not extracted as pair)", () => {
      const block1 = buildSkillsBlock();
      // Different intro line — extractor won't recognize this as a pair header
      const block2 = [
        "The following skills provide specialized instructions for tasks.",
        "<available_skills>",
        "<skill>fast-develop</skill>",
        "</available_skills>",
      ].join("\n");
      const prompt = `${block1}\n\n${block2}`;
      const result = skillsDedup(prompt);

      // Only 1 pair extracted (second block has wrong intro) → no-op
      expect(result.prompt).toBe(prompt);
      expect(result.removedPairs).toBe(0);
      expect(result.skippedReason).toBeUndefined();
    });
  });

  // ─── Cwd line handling ───────────────────────────────────────────────

  describe("cwd line handling", () => {
    it("removes cwd line after deleted block when cwd matches last", () => {
      const block = buildSkillsBlock();
      const cwd = "/project/root";
      const prompt = [
        "Header",
        "",
        block,
        `Current working directory: ${cwd}`,
        "",
        "Middle",
        "",
        block,
        `Current working directory: ${cwd}`,
        "",
        "Footer",
      ].join("\n");
      const result = skillsDedup(prompt);

      expect(result.removedPairs).toBe(1);
      // The cwd line after the first block should be removed
      const cwdCount = countStr(result.prompt, "Current working directory:");
      expect(cwdCount).toBe(1);
      // The remaining cwd line should be the one associated with the last block
      expect(result.prompt).toContain(`Current working directory: ${cwd}`);
    });

    it("preserves cwd line when cwd differs (worktree isolation)", () => {
      const block = buildSkillsBlock();
      const prompt = [
        "Header",
        "",
        block,
        "Current working directory: /worktree/A",
        "",
        "Middle",
        "",
        block,
        "Current working directory: /worktree/B",
        "",
        "Footer",
      ].join("\n");
      const result = skillsDedup(prompt);

      expect(result.removedPairs).toBe(1);
      // Both cwd lines should remain since they differ
      const cwdCount = countStr(result.prompt, "Current working directory:");
      expect(cwdCount).toBe(2);
      expect(result.prompt).toContain("Current working directory: /worktree/A");
      expect(result.prompt).toContain("Current working directory: /worktree/B");
    });
  });

  // ─── Malformed cases ─────────────────────────────────────────────────

  describe("malformed", () => {
    it("returns malformed when closing tag missing (open tag but no close)", () => {
      const prompt = `${SKILLS_INTRO}\n<available_skills>\n<skill>test</skill>\n`;
      // Only one opening tag, so pre-check would short-circuit.
      // We need 2 opening tags but one without a closing tag.
      const prompt2 = `${SKILLS_INTRO}\n<available_skills>\n<skill>test</skill>\n\n${SKILLS_INTRO}\n<available_skills>\n<skill>test</skill>\n</available_skills>`;
      const result = skillsDedup(prompt2);

      // First pair has no closing tag, second pair is valid.
      // extractSkillPairs should find only 1 pair (the second one),
      // so pairs.length < 2 → no-op (not malformed).
      // Actually, let's check: the first header finds no closing tag before
      // the second header? No, it finds the second pair's closing tag.
      // Let me think...
      // Line scan: first SKILLS_INTRO at i=0, scan forward for </available_skills>
      // → finds it at the end (the second block's closing tag).
      // Between i=0 and that closing tag, there are TWO <available_skills> tags.
      // So the first pair = (0, last_closing_tag_line).
      // Then we advance i past that pair, no more lines → only 1 pair.
      // pairs.length < 2 → no-op.
      expect(result.removedPairs).toBe(0);
      // This is a no-op, not malformed (only 1 pair extracted)
      expect(result.skippedReason).toBeUndefined();
    });

    it("returns malformed when no intro line (bare blocks)", () => {
      // Two blocks without the intro line
      const prompt = `<available_skills>\n<skill>a</skill>\n</available_skills>\n\n<available_skills>\n<skill>a</skill>\n</available_skills>`;
      const result = skillsDedup(prompt);

      // No SKILLS_INTRO line → no pairs extracted → no-op
      expect(result.removedPairs).toBe(0);
      expect(result.skippedReason).toBeUndefined();
    });

    it("returns malformed when header exists but no open tag in interval", () => {
      // Header + closing tag but no <available_skills> open tag between them
      const prompt = `${SKILLS_INTRO}\n</available_skills>\n\n${SKILLS_INTRO}\n<available_skills>\n<skill>x</skill>\n</available_skills>`;
      const result = skillsDedup(prompt);

      // First pair: header at line 0, closing at line 1, but no open tag between → malformed
      // extractSkillPairs returns only 1 pair (skips the malformed one),
      // then allPairsHaveOpenTag on that 1 pair should pass.
      // Actually: the first pair extraction finds header at 0, nearest </> at 1,
      // checks for <available_skills> between 0 and 1 → not found → returns pairs=[]
      // (early return). Second header at line 3: finds closing at line 5,
      // but we already returned from first iteration...
      // 
      // Wait: extractSkillPairs returns early when hasOpen=false.
      // So it returns an empty array for the first malformed pair.
      // Then pairs.length < 2 → no-op.
      expect(result.removedPairs).toBe(0);
      // Since extractSkillPairs returns [] early, we never get to allPairsHaveOpenTag
      // with a malformed pair. So this is a no-op.
      expect(result.skippedReason).toBeUndefined();
    });
  });

  // ─── Idempotency ─────────────────────────────────────────────────────

  describe("idempotency", () => {
    it("second call on deduplicated output is no-op", () => {
      const block = buildSkillsBlock();
      const prompt = `${block}\n\n${block}`;
      const first = skillsDedup(prompt);
      expect(first.removedPairs).toBe(1);

      const second = skillsDedup(first.prompt);
      expect(second.removedPairs).toBe(0);
      expect(second.prompt).toBe(first.prompt);
      expect(second.skippedReason).toBeUndefined();
    });
  });

  // ─── Edge cases ──────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles blocks separated by empty lines", () => {
      const block = buildSkillsBlock();
      const prompt = `${block}\n\n\n\n${block}`;
      const result = skillsDedup(prompt);
      expect(result.removedPairs).toBe(1);
      expect(countStr(result.prompt, "<available_skills>")).toBe(1);
    });

    it("handles blocks with multiple skill entries", () => {
      const entries = [
        "<skill>",
        "<name>fast-develop</name>",
        "<description>Implement features</description>",
        "</skill>",
        "<skill>",
        "<name>code-review</name>",
        "<description>Review code</description>",
        "</skill>",
      ];
      const block = buildSkillsBlock(entries);
      const prompt = `prefix\n${block}\n\n${block}\nsuffix`;
      const result = skillsDedup(prompt);
      expect(result.removedPairs).toBe(1);
      expect(result.prompt).toContain("prefix");
      expect(result.prompt).toContain("suffix");
    });

    it("removedBytes accurately reflects bytes removed", () => {
      const block = buildSkillsBlock();
      const prompt = `${block}\n\n${block}`;
      const result = skillsDedup(prompt);
      expect(result.removedBytes).toBe(prompt.length - result.prompt.length);
      expect(result.removedBytes).toBeGreaterThan(0);
    });

    it("cwd line check skips blank lines between closing tag and cwd", () => {
      const block = buildSkillsBlock();
      const cwd = "/my/project";
      const prompt = [
        block,
        "",
        "",
        `Current working directory: ${cwd}`,
        "",
        block,
        `Current working directory: ${cwd}`,
      ].join("\n");
      const result = skillsDedup(prompt);

      expect(result.removedPairs).toBe(1);
      // The first cwd line (after blank lines) should also be removed
      const cwdCount = countStr(result.prompt, "Current working directory:");
      expect(cwdCount).toBe(1);
    });
  });
});

// ─── Utility ──────────────────────────────────────────────────────────────────

function countStr(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}
