import { describe, it, expect } from "bun:test";
import { verifyRequiredCommands } from "../../../core/verifiers/command-verifier";
import type { ExecFn } from "../../../types";

describe("verifyRequiredCommands", () => {
  // ── Mock execFn-based tests (fail-closed: execFn required) ──

  it("passes when command exits with expected code", async () => {
    const mockExecFn: ExecFn = async (cmd, args) => {
      if (cmd === "echo" && args[0] === "hello") {
        return { stdout: "hello\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "unknown command", code: 1 };
    };

    const result = await verifyRequiredCommands(
      [{ cmd: "echo hello", expectExit: 0 }],
      process.cwd(),
      mockExecFn,
    );
    expect(result.passed).toBe(true);
    expect(result.detail).toContain("1 required commands passed");
  });

  it("passes when output contains expected substring", async () => {
    const mockExecFn: ExecFn = async (cmd, args) => {
      if (cmd === "echo") {
        return { stdout: "hello world\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "unknown", code: 1 };
    };

    const result = await verifyRequiredCommands(
      [{ cmd: "echo hello world", expectExit: 0, expectOutput: "hello" }],
      process.cwd(),
      mockExecFn,
    );
    expect(result.passed).toBe(true);
  });

  it("fails when output does not contain expected substring", async () => {
    const mockExecFn: ExecFn = async () => ({
      stdout: "hello\n",
      stderr: "",
      code: 0,
    });

    const result = await verifyRequiredCommands(
      [{ cmd: "echo hello", expectExit: 0, expectOutput: "goodbye" }],
      process.cwd(),
      mockExecFn,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("expected output containing");
  });

  it("fails when exit code does not match", async () => {
    const mockExecFn: ExecFn = async () => ({
      stdout: "",
      stderr: "error",
      code: 1,
    });

    const result = await verifyRequiredCommands(
      [{ cmd: "some-cmd", expectExit: 0 }],
      process.cwd(),
      mockExecFn,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("expected exit code 0, got 1");
  });

  it("passes with undefined or empty rules", async () => {
    expect((await verifyRequiredCommands(undefined, process.cwd())).passed).toBe(true);
    expect((await verifyRequiredCommands([], process.cwd())).passed).toBe(true);
  });

  it("defaults expectExit to 0 when not specified", async () => {
    const mockExecFn: ExecFn = async () => ({
      stdout: "ok\n",
      stderr: "",
      code: 0,
    });

    const result = await verifyRequiredCommands(
      [{ cmd: "echo ok" }],
      process.cwd(),
      mockExecFn,
    );
    expect(result.passed).toBe(true);
  });

  // ── Fail-closed: no execFn + rules present → immediate failure ──

  it("fails when execFn is not provided but rules exist (fail-closed)", async () => {
    const result = await verifyRequiredCommands(
      [{ cmd: "echo hello", expectExit: 0 }],
      process.cwd(),
      // execFn intentionally omitted
    );

    expect(result.passed).toBe(false);
    expect(result.detail).toContain("pi.exec unavailable");
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

  // ── Phase 2: shell operator fail-fast tests ──

  it("fails on && operator in cmd (shell operators not supported)", async () => {
    const mockExecFn: ExecFn = async () => ({
      stdout: "",
      stderr: "",
      code: 0,
    });

    const result = await verifyRequiredCommands(
      [{ cmd: "npm test && npm run build", expectExit: 0 }],
      process.cwd(),
      mockExecFn,
    );

    expect(result.passed).toBe(false);
    expect(result.detail).toContain("shell operators");
  });

  it("fails on > redirect operator in cmd", async () => {
    const mockExecFn: ExecFn = async () => ({
      stdout: "",
      stderr: "",
      code: 0,
    });

    const result = await verifyRequiredCommands(
      [{ cmd: 'echo "x" > file', expectExit: 0 }],
      process.cwd(),
      mockExecFn,
    );

    expect(result.passed).toBe(false);
    expect(result.detail).toContain("shell operators");
  });

  it("calls logError when execFn throws (real error path)", async () => {
    const mockExecFn: ExecFn = async () => {
      throw new Error("sandbox crashed");
    };
    const logCalls: { stage: string; msg: Record<string, string> }[] = [];
    const logError = async (stage: string, msg?: Record<string, string>) => {
      logCalls.push({ stage, msg: msg ?? {} });
    };

    const result = await verifyRequiredCommands(
      [{ cmd: "dangerous-cmd", expectExit: 0 }],
      process.cwd(),
      mockExecFn,
      logError,
    );

    expect(result.passed).toBe(false);
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0].stage).toBe("verify_error");
    expect(logCalls[0].msg.ruleType).toBe("requiredCommands");
    expect(logCalls[0].msg.cmd).toBe("dangerous-cmd");
    expect(logCalls[0].msg.error).toContain("sandbox crashed");
  });

  it("simple command passes without shell operator false positive", async () => {
    const mockExecFn: ExecFn = async (cmd, args) => {
      if (cmd === "echo" && args[0] === "hello") {
        return { stdout: "hello\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "unknown", code: 1 };
    };

    const result = await verifyRequiredCommands(
      [{ cmd: "echo hello", expectExit: 0 }],
      process.cwd(),
      mockExecFn,
    );

    expect(result.passed).toBe(true);
  });
});
