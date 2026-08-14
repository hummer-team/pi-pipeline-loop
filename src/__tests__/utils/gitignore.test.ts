import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  loadGitignoreInfo,
  isGitignored,
  resetGitignoreCache,
} from "../../utils/gitignore";

let TMP: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-gitignore-" + Date.now());
  await fs.mkdir(TMP, { recursive: true });
  resetGitignoreCache();
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("loadGitignoreInfo", () => {
  it("returns null when no .gitignore exists", async () => {
    const result = await loadGitignoreInfo(TMP);
    expect(result).toBeNull();
  });

  it("loads root .gitignore with directory pattern", async () => {
    await fs.writeFile(path.join(TMP, ".gitignore"), "docs\n");
    const result = await loadGitignoreInfo(TMP);
    expect(result).not.toBeNull();
    expect(isGitignored(result!, "docs/file.md")).toBe(true);
    expect(isGitignored(result!, "src/index.ts")).toBe(false);
  });

  it("handles *.md glob pattern", async () => {
    await fs.writeFile(path.join(TMP, ".gitignore"), "*.md\n");
    const result = await loadGitignoreInfo(TMP);
    expect(result).not.toBeNull();
    expect(isGitignored(result!, "README.md")).toBe(true);
    expect(isGitignored(result!, "docs/README.md")).toBe(true);
    expect(isGitignored(result!, "src/index.ts")).toBe(false);
  });

  it("handles trailing / directory semantic", async () => {
    await fs.writeFile(path.join(TMP, ".gitignore"), "/src/template/\n");
    const result = await loadGitignoreInfo(TMP);
    expect(result).not.toBeNull();
    expect(isGitignored(result!, "src/template/file.md")).toBe(true);
    expect(isGitignored(result!, "src/template/sub/file.md")).toBe(true);
    expect(isGitignored(result!, "src/template-old/file.md")).toBe(false);
  });

  it("handles ! negation pattern", async () => {
    await fs.writeFile(path.join(TMP, ".gitignore"), "*.md\n!important.md\n");
    const result = await loadGitignoreInfo(TMP);
    expect(result).not.toBeNull();
    expect(isGitignored(result!, "README.md")).toBe(true);
    expect(isGitignored(result!, "important.md")).toBe(false);
  });

  it("handles nested .gitignore with directory scope", async () => {
    // Root .gitignore
    await fs.writeFile(path.join(TMP, ".gitignore"), "build/\n");
    // Create sub directory with its own .gitignore
    await fs.mkdir(path.join(TMP, "sub"), { recursive: true });
    await fs.writeFile(path.join(TMP, "sub/.gitignore"), "*.tmp\n");

    const result = await loadGitignoreInfo(TMP);
    expect(result).not.toBeNull();

    // Root pattern should apply globally
    expect(isGitignored(result!, "build/output.js")).toBe(true);

    // Nested pattern should only apply within sub/
    expect(isGitignored(result!, "sub/temp.tmp")).toBe(true);
    expect(isGitignored(result!, "other/temp.tmp")).toBe(false);
  });

  it("caches results for same projectRoot", async () => {
    await fs.writeFile(path.join(TMP, ".gitignore"), "docs\n");

    const result1 = await loadGitignoreInfo(TMP);
    const result2 = await loadGitignoreInfo(TMP);
    expect(result1).toBe(result2); // Same reference
  });

  it("resetGitignoreCache clears cached results", async () => {
    await fs.writeFile(path.join(TMP, ".gitignore"), "docs\n");

    const result1 = await loadGitignoreInfo(TMP);
    resetGitignoreCache();
    const result2 = await loadGitignoreInfo(TMP);

    expect(result1).not.toBe(result2); // Different reference after reset
    expect(isGitignored(result2!, "docs/file.md")).toBe(true);
  });

  it("handles complex patterns together", async () => {
    await fs.writeFile(
      path.join(TMP, ".gitignore"),
      `# Build outputs
dist/
build/

# Logs
*.log

# But keep important logs
!important.log

# Templates
src/template/
`
    );
    const result = await loadGitignoreInfo(TMP);
    expect(result).not.toBeNull();

    // Directory patterns
    expect(isGitignored(result!, "dist/bundle.js")).toBe(true);
    expect(isGitignored(result!, "build/output.exe")).toBe(true);

    // Glob patterns
    expect(isGitignored(result!, "error.log")).toBe(true);
    expect(isGitignored(result!, "app/debug.log")).toBe(true);

    // Negation
    expect(isGitignored(result!, "important.log")).toBe(false);

    // Directory with trailing slash
    expect(isGitignored(result!, "src/template/index.md")).toBe(true);
    expect(isGitignored(result!, "src/template-old/index.md")).toBe(false);

    // Not ignored
    expect(isGitignored(result!, "src/index.ts")).toBe(false);
  });

  it("collects patterns for display", async () => {
    await fs.writeFile(
      path.join(TMP, ".gitignore"),
      "docs\n*.log\n!important.log\n"
    );
    const result = await loadGitignoreInfo(TMP);
    expect(result).not.toBeNull();
    expect(result!.patterns).toContain("docs");
    expect(result!.patterns).toContain("*.log");
    expect(result!.patterns).toContain("!important.log");
  });
});
