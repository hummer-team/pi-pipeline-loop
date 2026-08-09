import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { verifyRequiredFiles, verifyFileContentPattern } from "../../../core/verifiers/file-verifier";

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
