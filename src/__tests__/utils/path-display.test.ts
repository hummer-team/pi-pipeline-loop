import { describe, it, expect } from "bun:test";
import { toProjectRelative } from "../../utils/path-display";
import path from "node:path";

describe("toProjectRelative", () => {
  const projectRoot = "/Users/test/my-project";

  it("returns relative path when inside project root", () => {
    const absPath = "/Users/test/my-project/.pi/audit/pipe-123/plan.md";
    expect(toProjectRelative(projectRoot, absPath)).toBe(".pi/audit/pipe-123/plan.md");
  });

  it("returns absolute path when outside project root", () => {
    const absPath = "/Users/other/some-file.md";
    const result = toProjectRelative(projectRoot, absPath);
    expect(result).toBe("/Users/other/some-file.md");
  });

  it("returns the path itself when it equals the project root", () => {
    const result = toProjectRelative(projectRoot, projectRoot);
    expect(result).toBe("");
  });

  it("uses POSIX separators regardless of platform", () => {
    const absPath = path.join(projectRoot, ".pi", "audit", "plan.md");
    const result = toProjectRelative(projectRoot, absPath);
    expect(result).not.toContain("\\");
    expect(result).toBe(".pi/audit/plan.md");
  });

  it("returns absPath as-is when projectRoot is empty", () => {
    expect(toProjectRelative("", "/some/path.md")).toBe("/some/path.md");
  });

  it("returns absPath as-is when absPath is empty", () => {
    expect(toProjectRelative(projectRoot, "")).toBe("");
  });

  it("handles nested project root paths correctly", () => {
    const deepPath = "/Users/test/my-project/src/deep/nested/file.ts";
    expect(toProjectRelative(projectRoot, deepPath)).toBe("src/deep/nested/file.ts");
  });
});
