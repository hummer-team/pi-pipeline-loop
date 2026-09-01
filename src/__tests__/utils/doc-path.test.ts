import { describe, it, expect } from "bun:test";
import { parseRequirementDocPath } from "../../utils/doc-path";

describe("parseRequirementDocPath", () => {
  // ─── Single path extraction ──────────────────────────────────────────────────

  it("extracts a bare docs/ path", () => {
    expect(parseRequirementDocPath("docs/design/82_Feat.md")).toBe("docs/design/82_Feat.md");
  });

  it("extracts a docs/ path with trailing text (round specifier)", () => {
    expect(parseRequirementDocPath("docs/design/82_Feat.md 1 答")).toBe("docs/design/82_Feat.md");
  });

  it("extracts a doc/ path (singular variant)", () => {
    expect(parseRequirementDocPath("Please review doc/spec/overview.md")).toBe("doc/spec/overview.md");
  });

  it("extracts an absolute path ending in .md", () => {
    expect(parseRequirementDocPath("See /Users/name/project/docs/spec.md for details")).toBe(
      "/Users/name/project/docs/spec.md",
    );
  });

  it("extracts a path from a sentence with surrounding text", () => {
    expect(parseRequirementDocPath("Let's start with docs/design/plan.md please")).toBe(
      "docs/design/plan.md",
    );
  });

  it("extracts a path with hyphens and underscores in segments", () => {
    expect(parseRequirementDocPath("docs/design/170_E2E_Flow_plan.md")).toBe(
      "docs/design/170_E2E_Flow_plan.md",
    );
  });

  // ─── No match ──────────────────────────────────────────────────────────────

  it("returns null for text with no doc paths", () => {
    expect(parseRequirementDocPath("Please implement the feature")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseRequirementDocPath("")).toBeNull();
  });

  it("returns null for non-md file paths", () => {
    expect(parseRequirementDocPath("docs/design/spec.ts")).toBeNull();
  });

  it("returns null for null/undefined input", () => {
    expect(parseRequirementDocPath(null as unknown as string)).toBeNull();
    expect(parseRequirementDocPath(undefined as unknown as string)).toBeNull();
  });

  // ─── Multiple matches (ambiguity) ──────────────────────────────────────────

  it("returns first path when multiple doc paths in different directories (take-first)", () => {
    // Multi-path in different directories → take first (user mentioned multiple docs)
    const text = "Start with docs/design/spec.md and then check docs/review/notes.md";
    let captured: string[] | undefined;
    const result = parseRequirementDocPath(text, (paths) => { captured = paths; });
    expect(result).toBe("docs/design/spec.md");
    // Candidates callback should NOT be invoked for take-first
    expect(captured).toBeUndefined();
  });

  it("returns null when multiple doc paths in same directory (version ambiguity)", () => {
    const text = "Compare docs/design/v1.md with docs/design/v2.md";
    let captured: string[] | undefined;
    const result = parseRequirementDocPath(text, (paths) => { captured = paths; });
    expect(result).toBeNull();
    expect(captured).toBeDefined();
    expect(captured!.length).toBe(2);
    expect(captured).toContain("docs/design/v1.md");
    expect(captured).toContain("docs/design/v2.md");
  });

  it("reports candidates via callback and returns first for same-dir non-version files", () => {
    // Same directory but filenames are NOT version-like → take first (not ambiguous)
    const text = "Check docs/spec.md or docs/notes.md";
    let callbackInvoked = false;
    const result = parseRequirementDocPath(text, () => { callbackInvoked = true; });
    expect(result).toBe("docs/spec.md");
    // Candidates callback should NOT be invoked (no version ambiguity)
    expect(callbackInvoked).toBe(false);
  });

  it("returns null for same-dir version-like filenames (v1/v2 ambiguity)", () => {
    const text = "Compare docs/design/v1.md with docs/design/v2.md";
    let captured: string[] | undefined;
    const result = parseRequirementDocPath(text, (paths) => { captured = paths; });
    expect(result).toBeNull();
    expect(captured).toBeDefined();
    expect(captured!.length).toBe(2);
    expect(captured).toContain("docs/design/v1.md");
    expect(captured).toContain("docs/design/v2.md");
  });

  it("returns null for same-dir _1/_2 suffix filenames (version ambiguity)", () => {
    const text = "Check docs/design/spec_1.md and docs/design/spec_2.md";
    const result = parseRequirementDocPath(text);
    expect(result).toBeNull();
  });

  it("returns the single match without invoking candidates callback", () => {
    let callbackInvoked = false;
    const result = parseRequirementDocPath("Just docs/one.md here", () => { callbackInvoked = true; });
    expect(result).toBe("docs/one.md");
    expect(callbackInvoked).toBe(false);
  });

  // ─── Edge cases ────────────────────────────────────────────────────────────

  it("extracts path from quoted context", () => {
    expect(parseRequirementDocPath('Read "docs/design/spec.md" for details')).toBe("docs/design/spec.md");
  });

  it("does not extract paths that start with non-doc prefixes", () => {
    // src/design/spec.md should NOT match (not under docs/ or doc/)
    expect(parseRequirementDocPath("Look at src/design/spec.md")).toBeNull();
  });
});
