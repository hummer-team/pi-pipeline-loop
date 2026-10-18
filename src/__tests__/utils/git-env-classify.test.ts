/**
 * 203_Bug Phase 2 (RC3): Unit tests for the working-tree environmental
 * classifier. Covers the managed-path-only → environmental decision, the
 * unmanaged-path guard, git failure fail-closed semantics and porcelain
 * parsing edge cases.
 */
import { describe, expect, it } from "bun:test";
import {
  classifyWorkingTree,
  parsePorcelainPaths,
  DEFAULT_MANAGED_MATCHERS,
} from "../../utils/git-env-classify";
import { verifyRequiredGit } from "../../core/verifiers/git-verifier";
import type { ExecFn } from "../../types";

interface ExecReply {
  stdout?: string;
  stderr?: string;
  code?: number;
}

/**
 * Builds a fake ExecFn that answers `git status` and `git check-ignore`
 * from the supplied fixtures, recording every invocation.
 */
function makeExec(options: {
  status: string;
  ignored?: string[];
  failStatus?: boolean;
}): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const ignored = new Set(options.ignored ?? []);
  const exec: ExecFn = async (_cmd, args) => {
    calls.push(args);
    if (args[0] === "status") {
      if (options.failStatus) throw new Error("git status exploded");
      return { stdout: options.status, stderr: "", code: 0 };
    }
    if (args[0] === "check-ignore") {
      const path = args[args.length - 1];
      return ignored.has(path)
        ? { stdout: "", stderr: "", code: 0 }
        : { stdout: "", stderr: "", code: 1 };
    }
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
  return { exec, calls };
}

describe("classifyWorkingTree", () => {
  it("treats docs/-only changes as environmental", async () => {
    const { exec } = makeExec({
      status: " M docs/design/203_Bug_Plan.md\n?? docs/design/203_Bug.md\n",
    });
    const result = await classifyWorkingTree("/repo", exec);
    expect(result.environmental).toBe(true);
    expect(result.changedPaths).toEqual([
      "docs/design/203_Bug_Plan.md",
      "docs/design/203_Bug.md",
    ]);
    expect(result.guidance).toContain("pipeline-managed");
    expect(result.guidance).toContain("verify.md");
  });

  it("stays non-environmental when an unmanaged path is dirty", async () => {
    const { exec } = makeExec({
      status: " M docs/design/203_Bug_Plan.md\n M src/index.ts\n",
    });
    const result = await classifyWorkingTree("/repo", exec);
    expect(result.environmental).toBe(false);
    // Only unmanaged paths are surfaced for diagnostics.
    expect(result.changedPaths).toEqual(["src/index.ts"]);
  });

  it("treats git-ignored paths as managed", async () => {
    const { exec } = makeExec({
      status: "!! .pi/runtime/cache.bin\n",
      ignored: [".pi/runtime/cache.bin"],
    });
    const result = await classifyWorkingTree("/repo", exec);
    expect(result.environmental).toBe(true);
    expect(result.changedPaths).toEqual([".pi/runtime/cache.bin"]);
  });

  it("fails closed when git status throws", async () => {
    const { exec } = makeExec({ status: "", failStatus: true });
    const result = await classifyWorkingTree("/repo", exec);
    expect(result.environmental).toBe(false);
    expect(result.changedPaths).toEqual([]);
    expect(result.guidance).toBe("");
  });

  it("fails closed when no exec function is available", async () => {
    const result = await classifyWorkingTree("/repo", undefined);
    expect(result.environmental).toBe(false);
  });

  it("fails closed on a clean tree (caller should not have failed)", async () => {
    const { exec } = makeExec({ status: "" });
    const result = await classifyWorkingTree("/repo", exec);
    expect(result.environmental).toBe(false);
  });

  it("honours custom managed matchers", async () => {
    const { exec } = makeExec({ status: "?? artifacts/report.json\n" });
    const result = await classifyWorkingTree("/repo", exec, ["artifacts/"]);
    expect(result.environmental).toBe(true);
  });

  it("ships the default matchers for plan-stage docs and the .pi work dir", () => {
    expect(DEFAULT_MANAGED_MATCHERS).toContain("docs/");
    expect(DEFAULT_MANAGED_MATCHERS).toContain(".pi/");
  });
});

describe("verifyRequiredGit environmental marking", () => {
  it("marks managed-path-only dirt as non-countable", async () => {
    const { exec } = makeExec({ status: " M docs/design/203_Bug_Plan.md\n" });
    const result = await verifyRequiredGit(
      { cleanWorkingTree: true },
      "/repo",
      exec,
    );

    expect(result.passed).toBe(false);
    expect(result.nonCountable).toBe(true);
    expect(result.changedPaths).toEqual(["docs/design/203_Bug_Plan.md"]);
    expect(result.detail).toContain("pipeline-managed");
  });

  it("keeps mixed failures countable", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      if (args[0] === "rev-parse") {
        return { stdout: "feature/x\n", stderr: "", code: 0 };
      }
      if (args[0] === "status") {
        return { stdout: " M docs/design/203_Bug_Plan.md\n", stderr: "", code: 0 };
      }
      if (args[0] === "check-ignore") {
        return { stdout: "", stderr: "", code: 1 };
      }
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    };

    const result = await verifyRequiredGit(
      { branch: "main", cleanWorkingTree: true },
      "/repo",
      exec,
    );

    expect(result.passed).toBe(false);
    expect(result.nonCountable).toBeUndefined();
    expect(result.detail).toContain("Expected branch");
    expect(result.detail).toContain("not clean");
  });
});

describe("parsePorcelainPaths", () => {
  it("keeps the NEW path for renames", () => {
    expect(parsePorcelainPaths("R  docs/old.md -> docs/new.md\n")).toEqual([
      "docs/new.md",
    ]);
  });

  it("unquotes C-quoted paths", () => {
    expect(parsePorcelainPaths('?? "docs/space name.md"\n')).toEqual([
      "docs/space name.md",
    ]);
  });

  it("skips malformed / blank lines", () => {
    expect(parsePorcelainPaths("\n??\n M src/a.ts\n")).toEqual(["src/a.ts"]);
  });

  it("returns an empty list for empty input", () => {
    expect(parsePorcelainPaths("")).toEqual([]);
  });
});
