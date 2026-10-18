/**
 * 203_Bug Phase 2 (RC3b): `git add` pathspec extraction must strip shell
 * fd-to-fd redirections (`2>&1`, `1>&2`, `>&2`). Before the fix the redirect
 * token was passed to `git add --dry-run`, which rejected it and degraded the
 * protection check into a noisy `git_protect` warn.
 */
import { describe, expect, it } from "bun:test";
import { checkGitAdd } from "../../utils/git-protect";
import type { ProtectState } from "../../utils/protect";
import type { ExecFn } from "../../types";

function makeProtectState(): ProtectState {
  return {
    hardcoded: [".pi", ".git"],
    allow: [],
    gitignore: null,
  };
}

/** Captures the argv of the final dry-run invocation. */
function makeRecorder(reply: { stdout?: string; stderr?: string; code?: number }): {
  exec: ExecFn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: ExecFn = async (_cmd, args) => {
    calls.push(args);
    return { stdout: reply.stdout ?? "", stderr: reply.stderr ?? "", code: reply.code ?? 0 };
  };
  return { exec, calls };
}

describe("checkGitAdd fd-redirect stripping", () => {
  it("strips 2>&1 before the dry-run", async () => {
    const state = makeProtectState();
    const { exec, calls } = makeRecorder({ stdout: "add 'docs/design/x.md'\n" });
    const result = await checkGitAdd("git add docs/design/x.md 2>&1", state, "/repo", exec);

    expect(result.block).toBe(false);
    expect(result.warn).toBeUndefined();
    expect(calls).toEqual([["add", "--dry-run", "docs/design/x.md"]]);
  });

  it("strips 1>&2 before the dry-run", async () => {
    const state = makeProtectState();
    const { exec, calls } = makeRecorder({ stdout: "add 'docs/design/x.md'\n" });
    await checkGitAdd("git add docs/design/x.md 1>&2", state, "/repo", exec);
    expect(calls[0]).toEqual(["add", "--dry-run", "docs/design/x.md"]);
  });

  it("strips bare >&2 before the dry-run", async () => {
    const state = makeProtectState();
    const { exec, calls } = makeRecorder({ stdout: "add 'docs/design/x.md'\n" });
    await checkGitAdd("git add docs/design/x.md >&2", state, "/repo", exec);
    expect(calls[0]).toEqual(["add", "--dry-run", "docs/design/x.md"]);
  });

  it("still blocks a protected path when a redirect is present", async () => {
    const state = makeProtectState();
    const { exec, calls } = makeRecorder({ stdout: "add '.pi/config.json'\n" });
    const result = await checkGitAdd("git add .pi/config.json 2>&1", state, "/repo", exec);

    expect(result.block).toBe(true);
    expect(result.reason).toContain(".pi/config.json");
    expect(calls[0]).toEqual(["add", "--dry-run", ".pi/config.json"]);
  });

  it("keeps real pathspec tokens untouched", async () => {
    const state = makeProtectState();
    const { exec, calls } = makeRecorder({ stdout: "add 'src/a.ts'\n" });
    await checkGitAdd("git add src/a.ts src/b.ts 2>&1", state, "/repo", exec);
    expect(calls[0]).toEqual(["add", "--dry-run", "src/a.ts", "src/b.ts"]);
  });
});
