import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { verifyRequiredFiles, verifyFileContentPattern, globMatchFiles } from "../../../core/verifiers/file-verifier";

let TMP: string;

beforeEach(async () => {
  TMP = path.join(tmpdir(), "pi-file-verifier-" + Date.now());
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("verifyRequiredFiles", () => {
  it("passes when all required files exist", async () => {
    await fs.writeFile(path.join(TMP, "file1.md"), "content");
    await fs.writeFile(path.join(TMP, "file2.md"), "content");

    const result = await verifyRequiredFiles(["file1.md", "file2.md"], TMP);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain("2 required files exist");
  });

  it("fails when a file is missing", async () => {
    await fs.writeFile(path.join(TMP, "file1.md"), "content");

    const result = await verifyRequiredFiles(["file1.md", "missing.md"], TMP);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("missing.md");
  });

  it("passes with undefined or empty list", async () => {
    expect((await verifyRequiredFiles(undefined, TMP)).passed).toBe(true);
    expect((await verifyRequiredFiles([], TMP)).passed).toBe(true);
  });

  it("handles absolute paths", async () => {
    const absPath = path.join(TMP, "abs.md");
    await fs.writeFile(absPath, "content");

    const result = await verifyRequiredFiles([absPath], TMP);
    expect(result.passed).toBe(true);
  });
});

describe("verifyFileContentPattern", () => {
  it("passes when all patterns match", async () => {
    await fs.writeFile(
      path.join(TMP, "doc.md"),
      "phase_name: develop\nbranch: main\n",
    );

    const result = await verifyFileContentPattern(
      [
        { path: "doc.md", pattern: "^phase_name:" },
        { path: "doc.md", pattern: "branch: main" },
      ],
      TMP,
    );
    expect(result.passed).toBe(true);
  });

  it("fails when pattern does not match", async () => {
    await fs.writeFile(path.join(TMP, "doc.md"), "some content\n");

    const result = await verifyFileContentPattern(
      [{ path: "doc.md", pattern: "^phase_name:" }],
      TMP,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("pattern");
  });

  it("fails when file does not exist", async () => {
    const result = await verifyFileContentPattern(
      [{ path: "nonexistent.md", pattern: ".*" }],
      TMP,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("file read error");
  });

  it("passes with undefined or empty rules", async () => {
    expect((await verifyFileContentPattern(undefined, TMP)).passed).toBe(true);
    expect((await verifyFileContentPattern([], TMP)).passed).toBe(true);
  });

  it("calls logError when file read fails (real error path)", async () => {
    const logCalls: { stage: string; msg: Record<string, string> }[] = [];
    const logError = async (stage: string, msg?: Record<string, string>) => {
      logCalls.push({ stage, msg: msg ?? {} });
    };

    const result = await verifyFileContentPattern(
      [{ path: "nonexistent.md", pattern: ".*" }],
      TMP,
      logError,
    );

    expect(result.passed).toBe(false);
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0].stage).toBe("verify_error");
    expect(logCalls[0].msg.ruleType).toBe("fileContentPattern");
    expect(logCalls[0].msg.path).toBe("nonexistent.md");
    expect(logCalls[0].msg.error).toBeTruthy();
  });
});

describe("globMatchFiles", () => {
  it("matches files with * wildcard", async () => {
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    await fs.writeFile(path.join(TMP, "docs", "design", "101_plan.md"), "content");
    await fs.writeFile(path.join(TMP, "docs", "design", "102_plan.md"), "content");
    await fs.writeFile(path.join(TMP, "docs", "design", "101_commit.md"), "content");

    const matches = await globMatchFiles("docs/design/*_plan.md", TMP);
    expect(matches).toHaveLength(2);
    expect(matches.map(m => path.basename(m)).sort()).toEqual(["101_plan.md", "102_plan.md"]);
  });

  it("returns empty array when no files match", async () => {
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    await fs.writeFile(path.join(TMP, "docs", "design", "readme.md"), "content");

    const matches = await globMatchFiles("docs/design/*_plan.md", TMP);
    expect(matches).toHaveLength(0);
  });

  it("matches with ? wildcard", async () => {
    await fs.mkdir(path.join(TMP, "src"), { recursive: true });
    await fs.writeFile(path.join(TMP, "src", "a.ts"), "content");
    await fs.writeFile(path.join(TMP, "src", "b.ts"), "content");
    await fs.writeFile(path.join(TMP, "src", "ab.ts"), "content");

    const matches = await globMatchFiles("src/?.ts", TMP);
    expect(matches).toHaveLength(2);
  });
});

describe("verifyRequiredFiles with glob", () => {
  it("passes when glob pattern matches at least one file", async () => {
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    await fs.writeFile(path.join(TMP, "docs", "design", "101_plan.md"), "content");

    const result = await verifyRequiredFiles(["docs/design/*_plan.md"], TMP);
    expect(result.passed).toBe(true);
  });

  it("fails when glob pattern matches no files", async () => {
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });

    const result = await verifyRequiredFiles(["docs/design/*_plan.md"], TMP);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("docs/design/*_plan.md");
  });

  it("mixes glob and exact paths", async () => {
    await fs.mkdir(path.join(TMP, "docs", "design"), { recursive: true });
    await fs.writeFile(path.join(TMP, "docs", "design", "101_plan.md"), "content");
    await fs.writeFile(path.join(TMP, "src.ts"), "content");

    const result = await verifyRequiredFiles(["docs/design/*_plan.md", "src.ts"], TMP);
    expect(result.passed).toBe(true);
  });
});

describe("verifyFileContentPattern with glob", () => {
  it("checks most recent file when glob matches multiple", async () => {
    await fs.mkdir(path.join(TMP, "docs", "review"), { recursive: true });

    // Write older file without the pattern
    const oldPath = path.join(TMP, "docs", "review", "code_review_old.md");
    await fs.writeFile(oldPath, "no match here");
    // Set old mtime
    const oldTime = new Date(Date.now() - 100000);
    await fs.utimes(oldPath, oldTime, oldTime);

    // Write newer file with the pattern
    const newPath = path.join(TMP, "docs", "review", "code_review_new.md");
    await fs.writeFile(newPath, "结论：通过");

    const result = await verifyFileContentPattern(
      [{ path: "docs/review/code_review_*.md", pattern: "结论：通过" }],
      TMP,
    );
    expect(result.passed).toBe(true);
  });

  it("fails when no glob matches and pattern cannot be checked", async () => {
    const result = await verifyFileContentPattern(
      [{ path: "docs/review/code_review_*.md", pattern: "结论：通过" }],
      TMP,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("no files matched");
  });
});

// ─── Phase 1: empty path / directory path defense ─────────────────────────────

describe("verifyFileContentPattern — Phase 1 empty/directory path defense", () => {
  it("returns clear error for empty path rule without throwing", async () => {
    const result = await verifyFileContentPattern(
      [{ path: "", pattern: "anything" }],
      TMP,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("path is empty");
    expect(result.detail).toContain("config error");
  });

  it("returns clear error when path resolves to project root (empty string after placeholder)", async () => {
    // Simulates what would happen with path.join(root, "") → root directory
    // With Phase 1 guard, empty path is caught before path.join
    const result = await verifyFileContentPattern(
      [{ path: "", pattern: "anything" }],
      TMP,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("path is empty");
  });

  it("returns 'directory' error when path points to a real directory", async () => {
    // Create a real directory
    await fs.mkdir(path.join(TMP, "docs"), { recursive: true });

    const result = await verifyFileContentPattern(
      [{ path: "docs", pattern: "anything" }],
      TMP,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("path points to a directory");
  });

  it("EISDIR error message is friendly when readFile encounters a directory", async () => {
    // The Phase 1 stat check should catch this before readFile,
    // but if it somehow gets to catch, the EISDIR message should be friendly
    await fs.mkdir(path.join(TMP, "subdir"), { recursive: true });

    const result = await verifyFileContentPattern(
      [{ path: "subdir", pattern: "test" }],
      TMP,
    );
    expect(result.passed).toBe(false);
    // Should get the directory detection message (from stat check)
    expect(result.detail).toContain("path points to a directory");
  });
});
