import { describe, it, expect } from "bun:test";
import { verifyRequiredGit } from "../../../core/verifiers/git-verifier";
import type { ExecFn } from "../../../types";

describe("verifyRequiredGit", () => {
  // These tests run within the pi-pipeline-loop git repo
  const projectRoot = process.cwd();

  it("passes with undefined rules", async () => {
    const result = await verifyRequiredGit(undefined, projectRoot);
    expect(result.passed).toBe(true);
  });

  it("passes when rules object is empty (no checks needed)", async () => {
    const result = await verifyRequiredGit({}, projectRoot);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain("All git rules satisfied");
  });

  it("fails when branch does not match (mock execFn)", async () => {
    const mockExecFn: ExecFn = async (_cmd, args) => {
      if (args[0] === "rev-parse") {
        return { stdout: "main\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await verifyRequiredGit(
      { branch: "nonexistent-branch-xyz-123" },
      projectRoot,
      mockExecFn,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("Expected branch");
  });

  it("passes lastCommitWithin with large window (mock execFn)", async () => {
    const nowTimestamp = Math.floor(Date.now() / 1000).toString();
    const mockExecFn: ExecFn = async (_cmd, args) => {
      if (args[0] === "log") {
        return { stdout: nowTimestamp + "\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await verifyRequiredGit(
      { lastCommitWithin: "365d" },
      projectRoot,
      mockExecFn,
    );
    expect(result.passed).toBe(true);
  });

  it("fails lastCommitWithin with tiny window (mock execFn)", async () => {
    // Use a timestamp from 1 hour ago
    const oldTimestamp = Math.floor(Date.now() / 1000 - 3600).toString();
    const mockExecFn: ExecFn = async (_cmd, args) => {
      if (args[0] === "log") {
        return { stdout: oldTimestamp + "\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await verifyRequiredGit(
      { lastCommitWithin: "1s" },
      projectRoot,
      mockExecFn,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("Last commit was");
  });

  it("fails on invalid time window format (mock execFn)", async () => {
    const mockExecFn: ExecFn = async () => ({
      stdout: "",
      stderr: "",
      code: 0,
    });

    const result = await verifyRequiredGit(
      { lastCommitWithin: "invalid" },
      projectRoot,
      mockExecFn,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("Invalid time window");
  });

  it("reports cleanWorkingTree correctly (mock execFn)", async () => {
    const mockExecFn: ExecFn = async (_cmd, args) => {
      if (args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await verifyRequiredGit(
      { cleanWorkingTree: true },
      projectRoot,
      mockExecFn,
    );
    expect(result.passed).toBe(true);
  });

  // ── Phase 3: mock execFn tests ──────────────────────────────────────────────

  it("uses execFn — valid git log output → time window check passes", async () => {
    const nowTimestamp = Math.floor(Date.now() / 1000).toString();
    const mockExecFn: ExecFn = async (_cmd, args) => {
      if (args[0] === "log") {
        return { stdout: nowTimestamp + "\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await verifyRequiredGit(
      { lastCommitWithin: "10min" },
      projectRoot,
      mockExecFn,
    );

    expect(result.passed).toBe(true);
    expect(result.detail).toContain("All git rules satisfied");
  });

  it("uses execFn — clean working tree → passes", async () => {
    const mockExecFn: ExecFn = async (_cmd, args) => {
      if (args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await verifyRequiredGit(
      { cleanWorkingTree: true },
      projectRoot,
      mockExecFn,
    );

    expect(result.passed).toBe(true);
  });

  it("uses execFn — throws exception → verification fails", async () => {
    const mockExecFn: ExecFn = async () => {
      throw new Error("sandbox execution failed");
    };

    const result = await verifyRequiredGit(
      { lastCommitWithin: "10min" },
      projectRoot,
      mockExecFn,
    );

    expect(result.passed).toBe(false);
    expect(result.detail).toContain("Failed to read git log");
  });

  // ── Phase 1: fail-closed when execFn unavailable ──

  it("fails when execFn is not provided but rules exist (fail-closed)", async () => {
    const result = await verifyRequiredGit(
      { branch: "main" },
      projectRoot,
      // execFn intentionally omitted
    );

    expect(result.passed).toBe(false);
    expect(result.detail).toContain("pi.exec unavailable");
  });

  // ── Phase 1: logError called on git command throw ──

  it("calls logError when git command throws (last_commit check)", async () => {
    const mockExecFn: ExecFn = async () => {
      throw new Error("git not available");
    };
    const logCalls: { stage: string; msg: Record<string, string> }[] = [];
    const logError = async (stage: string, msg?: Record<string, string>) => {
      logCalls.push({ stage, msg: msg ?? {} });
    };

    const result = await verifyRequiredGit(
      { lastCommitWithin: "10min" },
      projectRoot,
      mockExecFn,
      logError,
    );

    expect(result.passed).toBe(false);
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0].stage).toBe("verify_error");
    expect(logCalls[0].msg.ruleType).toBe("requiredGit");
    expect(logCalls[0].msg.check).toBe("last_commit");
    expect(logCalls[0].msg.error).toContain("git not available");
  });

  it("calls logError when git command throws (branch check)", async () => {
    const mockExecFn: ExecFn = async () => {
      throw new Error("sandbox error");
    };
    const logCalls: { stage: string; msg: Record<string, string> }[] = [];
    const logError = async (stage: string, msg?: Record<string, string>) => {
      logCalls.push({ stage, msg: msg ?? {} });
    };

    const result = await verifyRequiredGit(
      { branch: "main" },
      projectRoot,
      mockExecFn,
      logError,
    );

    expect(result.passed).toBe(false);
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0].msg.check).toBe("branch");
  });

  it("calls logError when git command throws (working_tree check)", async () => {
    const mockExecFn: ExecFn = async () => {
      throw new Error("sandbox error");
    };
    const logCalls: { stage: string; msg: Record<string, string> }[] = [];
    const logError = async (stage: string, msg?: Record<string, string>) => {
      logCalls.push({ stage, msg: msg ?? {} });
    };

    const result = await verifyRequiredGit(
      { cleanWorkingTree: true },
      projectRoot,
      mockExecFn,
      logError,
    );

    expect(result.passed).toBe(false);
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0].msg.check).toBe("working_tree");
  });
});
