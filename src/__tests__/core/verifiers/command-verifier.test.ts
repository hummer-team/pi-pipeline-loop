import { describe, it, expect } from "bun:test";
import { verifyRequiredCommands } from "../../../core/verifiers/command-verifier";
import type { ExecFn } from "../../../types";

describe("verifyRequiredCommands", () => {
  it("passes when command exits with expected code", async () => {
    const result = await verifyRequiredCommands(
      [{ cmd: "echo hello", expectExit: 0 }],
      process.cwd(),
    );
    expect(result.passed).toBe(true);
    expect(result.detail).toContain("1 required commands passed");
  });

  it("passes when output contains expected substring", async () => {
    const result = await verifyRequiredCommands(
      [{ cmd: "echo hello world", expectExit: 0, expectOutput: "hello" }],
      process.cwd(),
    );
    expect(result.passed).toBe(true);
  });

  it("fails when output does not contain expected substring", async () => {
    const result = await verifyRequiredCommands(
      [{ cmd: "echo hello", expectExit: 0, expectOutput: "goodbye" }],
      process.cwd(),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("expected output containing");
  });

  it("fails when exit code does not match", async () => {
    const result = await verifyRequiredCommands(
      [{ cmd: "exit 1", expectExit: 0 }],
      process.cwd(),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("expected exit code 0, got 1");
  });

  it("passes with undefined or empty rules", async () => {
    expect((await verifyRequiredCommands(undefined, process.cwd())).passed).toBe(true);
    expect((await verifyRequiredCommands([], process.cwd())).passed).toBe(true);
  });

  it("defaults expectExit to 0 when not specified", async () => {
    const result = await verifyRequiredCommands(
      [{ cmd: "echo ok" }],
      process.cwd(),
    );
    expect(result.passed).toBe(true);
  });

  // ── Phase 3: mock execFn tests ──────────────────────────────────────────────

  it("uses execFn when provided — non-zero exit code → failure", async () => {
    const mockExecFn: ExecFn = async () => ({
      stdout: "",
      stderr: "error occurred",
      code: 1,
    });

    const result = await verifyRequiredCommands(
      [{ cmd: "npm test", expectExit: 0 }],
      process.cwd(),
      mockExecFn,
    );

    expect(result.passed).toBe(false);
    expect(result.detail).toContain("expected exit code 0, got 1");
  });

  it("uses execFn when provided — matching expectOutput → pass", async () => {
    const mockExecFn: ExecFn = async () => ({
      stdout: "build successful\nall tests passed",
      stderr: "",
      code: 0,
    });

    const result = await verifyRequiredCommands(
      [{ cmd: "npm run build", expectExit: 0, expectOutput: "build successful" }],
      process.cwd(),
      mockExecFn,
    );

    expect(result.passed).toBe(true);
    expect(result.detail).toContain("1 required commands passed");
  });

  it("uses execFn when provided — throws exception → caught and reported", async () => {
    const mockExecFn: ExecFn = async () => {
      throw new Error("sandbox execution failed");
    };

    const result = await verifyRequiredCommands(
      [{ cmd: "dangerous-cmd", expectExit: 0 }],
      process.cwd(),
      mockExecFn,
    );

    expect(result.passed).toBe(false);
    expect(result.detail).toContain("expected exit code 0, got 1");
  });
});
