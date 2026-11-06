/**
 * 225 Phase 6 (T2): END-TO-END commit contract through the REAL tool chain.
 *
 * Shapes asserted against the REAL tool-guard (Phase 0 elevation intact):
 * - job `writePolicy.gitModify: block` + develop/fix `requiredGit` verify =>
 *   `git add`/`git commit` ALLOWED (content validation passing);
 * - `git add -f` still BLOCKED (hard blacklist outranks the capability);
 * - a gitignored `docs/` path cannot enter a commit;
 * - plan / review stages remain blocked (branch 1 of the elevation);
 * - `stages.develop.protect.gitModify` is NOT stripped by the job overlay
 *   (only `whitelistMiss` entries are stripped);
 * - allowed writes audit `git_write_allowed`; allowed `git push` adds
 *   `git_remote_write` (R3).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createToolGuard } from "../../core/tool-guard";
import { applyOverlay, restoreOverlay, acquireJobLock, releaseJobLock, __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { resolveGitModifyPolicy } from "../../utils/protect";
import { __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import type { ExecFn, PipelineConfig, PipelineJsonConfig, SessionMeta } from "../../types";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let ROOT: string;
const audits: { event: string; fields: Record<string, string | boolean> }[] = [];

beforeEach(() => {
  ROOT = join(tmpdir(), `e2e-contract-${Date.now()}`);
  fs.mkdirSync(ROOT, { recursive: true });
  __resetAutoJobLockForTests();
  audits.length = 0;
  __setSafeWriteAuditLogOverride((stage: string, payload?: Record<string, string | boolean>) => {
    audits.push({ event: stage, fields: (payload ?? {}) as Record<string, string | boolean> });
    return Promise.resolve();
  });
});

afterEach(() => {
  __setSafeWriteAuditLogOverride(null);
  __resetAutoJobLockForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** Job overlay on a base with a global block: the 225 acceptance shape. */
function jobOverlaidConfig(): PipelineConfig {
  const config = makeTestConfig({ projectRoot: ROOT });
  (config.protect as Record<string, unknown>).gitModify = "block";
  // Deploy the develop/fix commit-contract verify specs (requiredGit present).
  for (const stage of ["develop", "fix"] as const) {
    const specDir = join(ROOT, ".pi", "references", `${stage}_spec`);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(
      join(specDir, "verify.md"),
      "---\nrules:\n  path: \"{designDir}/*_Develop_Commit.md\"\n  groups:\n    - name: commit-ready\n      ruleMode: and\n      rules:\n        - type: requiredGit\n          cleanWorkingTree: true\n---\nbody",
      "utf-8",
    );
  }
  // Real job overlay applying writePolicy.gitModify=block globally.
  const baseJson: PipelineJsonConfig = {
    stages: { develop: {}, fix: {}, plan: {}, review: {}, clarify: {}, awaiting_human: {}, completed: {} },
    protect: { gitModify: "allow" },
  } as PipelineJsonConfig;
  const job = {
    writePolicy: { gitModify: "block" },
    configured: { gitModify: true },
    jobHash: "h-e2e-contract",
  } as never;
  const acquired = acquireJobLock({ projectRoot: ROOT, jobId: "e2e_loop" });
  if (!acquired.ok) throw new Error("lock acquire failed");
  const snapshot = applyOverlay(config, baseJson, job);
  expect(config.protect?.gitModify).toBe("block"); // the job owns it
  releaseJobLock({ projectRoot: ROOT, token: acquired.token });
  void snapshot;
  return config;
}

function guardHarness(stage: "develop" | "fix" | "plan" | "review", command: string, opts?: { execFn?: ExecFn }) {
  const meta: SessionMeta = makeTestMeta({ currentStage: stage });
  const ctx = createMockCtx(meta);
  ctx.toolCall = { name: "bash", arguments: { command } };
  return { ctx, meta };
}

describe("225 Phase 6 T2 — commit contract e2e", () => {
  it("elevated fix stage: git add/commit flow passes the guard; the write audits trail", async () => {
    const config = jobOverlaidConfig();
    // The PROMPT injection path performs the elevation; call it directly here
    // (the production owner path calls ensure... before every prompt).
    const { ensureCommitContractElevation } = await import("../../core/commit-contract");
    const ccFix = await ensureCommitContractElevation(config, "fix");
    expect(ccFix.elevated).toBe(true);
    const ccDev = await ensureCommitContractElevation(config, "develop");
    expect(ccDev.elevated).toBe(true);
    expect(resolveGitModifyPolicy(config, null, "fix")).toBe("allow");

    // `git add` of a safe path passes (execFn dry-run clean).
    const safeExec: ExecFn = async (_cmd, args) => {
      if (args[0] === "add" && args[1] === "--dry-run") return { stdout: "add 'src/a.ts'\n", stderr: "", code: 0 };
      if (args[0] === "diff" || args[0] === "diff --cached" || args[0] === "diff --name-only") return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    };
    const addHarness = guardHarness("fix", "git add src/a.ts");
    const addResult = (await createToolGuard(config, { execFn: safeExec }).handler(addHarness.ctx as never)) as { block?: boolean };
    expect(addResult?.block).toBeUndefined(); // allowed
    const commitHarness = guardHarness("fix", "git commit -m work");
    const commitResult = (await createToolGuard(config, { execFn: safeExec }).handler(commitHarness.ctx as never)) as { block?: boolean };
    expect(commitResult?.block).toBeUndefined(); // allowed
    // Positive audit recorded both times.
    expect(audits.filter((a) => a.event === "git_write_allowed").length).toBe(2);
  });

  it("`git add -f` of a gitignored path stays blocked in the elevated stage (content check wins)", async () => {
    const config = jobOverlaidConfig();
    const { ensureCommitContractElevation } = await import("../../core/commit-contract");
    await ensureCommitContractElevation(config, "fix");
    // gitignored asset: non-force dry-run must FAIL with the ignored hint.
    fs.mkdirSync(join(ROOT, "assets_gen"), { recursive: true });
    fs.writeFileSync(join(ROOT, ".gitignore"), "assets_gen\n", "utf-8");
    fs.writeFileSync(join(ROOT, "assets_gen", "a.bin"), "x", "utf-8");
    const execFn: ExecFn = async (_cmd, args) => {
      if (!args.includes("-f")) {
        return { stdout: "", stderr: "The following paths are ignored:\n  assets_gen/a.bin\nUse -f if you really want to add them.\n", code: 1 };
      }
      return { stdout: "add 'assets_gen/a.bin'\n", stderr: "", code: 0 };
    };
    const harness = guardHarness("fix", "git add -f assets_gen/a.bin");
    const result = (await createToolGuard(config, { execFn }).handler(harness.ctx as never)) as { block?: boolean; reason?: string };
    expect(result.block).toBe(true);
    expect(result.reason).toContain("force-stage gitignore-protected path");
  });

  it("plan / review stages remain git-blocked (elevation branch 1 untouched)", async () => {
    const config = jobOverlaidConfig();
    // Non-contract verify specs on the two stages (or absent → branch 1).
    const { ensureCommitContractElevation } = await import("../../core/commit-contract");
    await ensureCommitContractElevation(config, "plan");
    await ensureCommitContractElevation(config, "review");
    expect(resolveGitModifyPolicy(config, null, "plan")).toBe("block");
    expect(resolveGitModifyPolicy(config, null, "review")).toBe("block");
    const pushHarness = guardHarness("plan", "git push origin main");
    const result = (await createToolGuard(config).handler(pushHarness.ctx as never)) as { block?: boolean; reason?: string };
    expect(result.block).toBe(true);
  });

  it("job overlay writes `protect.gitModify` and does NOT strip stage keys on untouched blocks", async () => {
    const config = makeTestConfig({ projectRoot: ROOT });
    (config.stages as Record<string, unknown>).develop = {
      ...((config.stages as Record<string, unknown>).develop as object),
      protect: { gitModify: "allow" },
    };
    const baseJson: PipelineJsonConfig = {
      stages: { develop: { protect: { gitModify: "allow" } }, fix: {} },
      protect: { gitModify: "allow" },
    } as PipelineJsonConfig;
    const job = {
      writePolicy: { gitModify: "block" },
      configured: { gitModify: true },
      jobHash: "h-e2e-keys",
    } as never;
    const acquired = acquireJobLock({ projectRoot: ROOT, jobId: "e2e_loop" });
    const snapshot = applyOverlay(config, baseJson, job);
    // Global value flipped; the stage-level `develop` key SURVIVES (Tier-1).
    expect(config.protect?.gitModify).toBe("block");
    expect(config.stages.develop.protect?.gitModify).toBe("allow");
    // ...but Tier-1 means develop still resolves allow until elevation
    // (which here is a no-op because it is already allow).
    expect(resolveGitModifyPolicy(config, null, "develop")).toBe("allow");
    if (!acquired.ok) throw new Error("lock acquire failed");
    releaseJobLock({ projectRoot: ROOT, token: acquired.token });
    void snapshot;
  });

  it("gitRemoteWrite: an allowed `git push` writes git_remote_write with subcommand+args", async () => {
    const config = jobOverlaidConfig();
    const { ensureCommitContractElevation } = await import("../../core/commit-contract");
    await ensureCommitContractElevation(config, "fix");
    const pushHarness = guardHarness("fix", "git push origin main");
    const push = (await createToolGuard(config).handler(pushHarness.ctx as never)) as { block?: boolean };
    expect(push?.block).toBeUndefined(); // push allowed after elevation
    const remote = audits.filter((a) => a.event === "git_remote_write");
    expect(remote.length).toBe(1);
    expect(remote[0].fields.subcommand).toBe("push");
    expect(remote[0].fields.policy).toBe("allow");
  });
});
