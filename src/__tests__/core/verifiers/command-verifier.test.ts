import { describe, it, expect } from "bun:test";
import { verifyRequiredCommands } from "../../../core/verifiers/command-verifier";

describe("verifyRequiredCommands", () => {
  it("passes when command exits with expected code", () => {
    const result = verifyRequiredCommands(
      [{ cmd: "echo hello", expectExit: 0 }],
      process.cwd(),
    );
    expect(result.passed).toBe(true);
    expect(result.detail).toContain("1 required commands passed");
  });

  it("passes when output contains expected substring", () => {
    const result = verifyRequiredCommands(
      [{ cmd: "echo hello world", expectExit: 0, expectOutput: "hello" }],
      process.cwd(),
    );
    expect(result.passed).toBe(true);
  });

  it("fails when output does not contain expected substring", () => {
    const result = verifyRequiredCommands(
      [{ cmd: "echo hello", expectExit: 0, expectOutput: "goodbye" }],
      process.cwd(),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("expected output containing");
  });

  it("fails when exit code does not match", () => {
    const result = verifyRequiredCommands(
      [{ cmd: "exit 1", expectExit: 0 }],
      process.cwd(),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("expected exit code 0, got 1");
  });

  it("passes with undefined or empty rules", () => {
    expect(verifyRequiredCommands(undefined, process.cwd()).passed).toBe(true);
    expect(verifyRequiredCommands([], process.cwd()).passed).toBe(true);
  });

  it("defaults expectExit to 0 when not specified", () => {
    const result = verifyRequiredCommands(
      [{ cmd: "echo ok" }],
      process.cwd(),
    );
    expect(result.passed).toBe(true);
  });
});
