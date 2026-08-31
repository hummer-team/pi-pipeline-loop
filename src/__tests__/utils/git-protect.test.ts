import { describe, it, expect } from "bun:test";
import { checkGitAdd, checkGitCommit, hasGitCommitAllFlag } from "../../utils/git-protect";
import type { ProtectState } from "../../utils/protect";
import type { ExecFn } from "../../types";

/**
 * Build a minimal ProtectState for testing.
 * Uses hardcoded protection for .pi/ and .git/, plus optional gitignore.
 */
function makeTestProtectState(opts?: {
  hardcoded?: string[];
}): ProtectState {
  return {
    hardcoded: opts?.hardcoded ?? [".pi", ".git"],
    allow: [],
    gitignore: null,
  };
}

describe("hasGitCommitAllFlag", () => {
  it("detects -a flag", () => {
    expect(hasGitCommitAllFlag("git commit -a -m 'msg'")).toBe(true);
  });

  it("detects -A flag", () => {
    expect(hasGitCommitAllFlag("git commit -A -m 'msg'")).toBe(true);
  });

  it("detects --all flag", () => {
    expect(hasGitCommitAllFlag("git commit --all -m 'msg'")).toBe(true);
  });

  it("detects combined -am flag", () => {
    expect(hasGitCommitAllFlag("git commit -am 'msg'")).toBe(true);
  });

  it("returns false for plain commit", () => {
    expect(hasGitCommitAllFlag("git commit -m 'msg'")).toBe(false);
  });
});

describe("checkGitAdd", () => {
  it("blocks when dry-run positively confirms .pi/ path", async () => {
    const state = makeTestProtectState();
    const mockExecFn: ExecFn = async () => ({
      stdout: "add '.pi/config.json'\n",
      stderr: "",
      code: 0,
    });
    const result = await checkGitAdd("git add .pi/config.json", state, "/tmp", mockExecFn);
    expect(result.block).toBe(true);
    expect(result.reason).toContain(".pi/config.json");
  });

  it("does not block for safe paths", async () => {
    const state = makeTestProtectState();
    const mockExecFn: ExecFn = async () => ({
      stdout: "add 'src/index.ts'\n",
      stderr: "",
      code: 0,
    });
    const result = await checkGitAdd("git add src/index.ts", state, "/tmp", mockExecFn);
    expect(result.block).toBe(false);
    expect(result.warn).toBeUndefined();
  });

  it("warns (not blocks) on unknown switch / non-zero exit", async () => {
    const state = makeTestProtectState();
    const mockExecFn: ExecFn = async () => ({
      stdout: "",
      stderr: "error: unknown switch `q'",
      code: 129,
    });
    // Simulates: git add file && git commit -q — only "git add file" is passed
    // but in isolation the dry-run might fail for other reasons
    const result = await checkGitAdd("git add --unknown-flag", state, "/tmp", mockExecFn);
    expect(result.block).toBe(false);
    expect(result.warn).toBeDefined();
  });

  it("warns (not blocks) when pathspec does not match", async () => {
    const state = makeTestProtectState();
    const mockExecFn: ExecFn = async () => ({
      stdout: "",
      stderr: "fatal: pathspec 'nonexistent' did not match any files",
      code: 128,
    });
    const result = await checkGitAdd("git add nonexistent", state, "/tmp", mockExecFn);
    expect(result.block).toBe(false);
    expect(result.warn).toBeDefined();
    expect(result.warn).toContain("did not match");
  });

  it("warns (not blocks) on exec exception", async () => {
    const state = makeTestProtectState();
    const mockExecFn: ExecFn = async () => { throw new Error("exec unavailable"); };
    const result = await checkGitAdd("git add .", state, "/tmp", mockExecFn);
    expect(result.block).toBe(false);
    expect(result.warn).toBeDefined();
    expect(result.warn).toContain("execution error");
  });

  it("warns (not blocks) when execFn is not provided", async () => {
    const state = makeTestProtectState();
    const result = await checkGitAdd("git add .", state, "/tmp");
    expect(result.block).toBe(false);
    expect(result.warn).toBeDefined();
    expect(result.warn).toContain("execFn not available");
  });

  it("blocks when gitignored path is positively confirmed via hardcoded protection", async () => {
    const state = makeTestProtectState();
    const mockExecFn: ExecFn = async () => ({
      stdout: "add '.git/config'\n",
      stderr: "",
      code: 0,
    });
    const result = await checkGitAdd("git add .git/config", state, "/tmp", mockExecFn);
    expect(result.block).toBe(true);
    expect(result.reason).toContain(".git/config");
  });

  it("uses tokenize to extract pathspec (no -q contamination)", async () => {
    const state = makeTestProtectState();
    let capturedArgs: string[] = [];
    const mockExecFn: ExecFn = async (_cmd, args, _cwd) => {
      capturedArgs = args;
      return { stdout: "add 'src/index.ts'\n", stderr: "", code: 0 };
    };
    // Even if command is passed as single segment, tokenize extracts only pathspec
    await checkGitAdd("git add src/index.ts", state, "/tmp", mockExecFn);
    // Verify dry-run args don't contain extra noise
    expect(capturedArgs[0]).toBe("add");
    expect(capturedArgs[1]).toBe("--dry-run");
    expect(capturedArgs).toContain("src/index.ts");
    expect(capturedArgs).not.toContain("-q");
  });
});

describe("checkGitCommit", () => {
  it("blocks when staged files include .pi/ path", async () => {
    const state = makeTestProtectState();
    const mockExecFn: ExecFn = async (_cmd, args, _cwd) => {
      if (args[0] === "diff" && args[1] === "--cached") {
        return { stdout: ".pi/config.json\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 1 };
    };
    const result = await checkGitCommit("git commit -m 'msg'", state, "/tmp", mockExecFn);
    expect(result.block).toBe(true);
    expect(result.reason).toContain(".pi/config.json");
  });

  it("blocks with -a flag when unstaged files include protected path", async () => {
    const state = makeTestProtectState();
    const mockExecFn: ExecFn = async (_cmd, args, _cwd) => {
      if (args[0] === "diff" && args[1] === "--cached") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "diff" && args[1] === "--name-only") {
        return { stdout: ".git/HEAD\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 1 };
    };
    const result = await checkGitCommit("git commit -am 'msg'", state, "/tmp", mockExecFn);
    expect(result.block).toBe(true);
    expect(result.reason).toContain(".git/HEAD");
  });

  it("does not block for safe staged files", async () => {
    const state = makeTestProtectState();
    const mockExecFn: ExecFn = async (_cmd, args, _cwd) => {
      if (args[0] === "diff" && args[1] === "--cached") {
        return { stdout: "src/index.ts\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 1 };
    };
    const result = await checkGitCommit("git commit -m 'msg'", state, "/tmp", mockExecFn);
    expect(result.block).toBe(false);
  });

  it("warns (not blocks) when git diff --cached fails", async () => {
    const state = makeTestProtectState();
    const mockExecFn: ExecFn = async () => ({
      stdout: "",
      stderr: "fatal: not a git repository",
      code: 128,
    });
    const result = await checkGitCommit("git commit -m 'msg'", state, "/tmp", mockExecFn);
    expect(result.block).toBe(false);
    expect(result.warn).toBeDefined();
  });

  it("warns (not blocks) on exec exception", async () => {
    const state = makeTestProtectState();
    const mockExecFn: ExecFn = async () => { throw new Error("exec timeout"); };
    const result = await checkGitCommit("git commit -m 'msg'", state, "/tmp", mockExecFn);
    expect(result.block).toBe(false);
    expect(result.warn).toBeDefined();
    expect(result.warn).toContain("execution error");
  });

  it("warns (not blocks) when execFn is not provided", async () => {
    const state = makeTestProtectState();
    const result = await checkGitCommit("git commit -m 'msg'", state, "/tmp");
    expect(result.block).toBe(false);
    expect(result.warn).toBeDefined();
  });
});
