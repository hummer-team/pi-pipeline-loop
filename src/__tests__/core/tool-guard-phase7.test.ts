/**
 * @module tool-guard-phase7.test
 * Phase 7 (195_Bug): guardSource assignment at tool-guard call sites and
 * bash_destructive freeze decoupling.
 *
 * Every trigger in this file was verified empirically against the live
 * guard pipeline (no conditional "if violation happened" assertions —
 * each test asserts the violation IS recorded, unconditionally):
 * - write tool outside the stage write whitelist     -> read_only_path
 * - write tool on a gitignore-protected path         -> git_policy
 * - bash destructive command on a system path        -> bash_destructive
 * - dynamic_write_scope is covered end-to-end in
 *   tool-guard-design-review-scope.test.ts (guardSource assertion added
 *   there; re-deriving the design-review lifecycle harness here would
 *   duplicate an existing deterministic trigger).
 */

import { describe, it, expect, afterEach } from "bun:test";
import { createToolGuard } from "../../core/tool-guard";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog, getDateAuditFileName, __resetAuditDirPath } from "../../utils/auditLog";
import type { SessionMeta } from "../../types";
import { DEFAULT_MAX_VIOLATIONS, DEFAULT_BASH_DESTRUCTIVE_PROMPT_MAX } from "../../constants";
import { auditLogFileFor } from "../helpers";

/** Fresh project root per test so audit files never accumulate across tests. */
async function freshRoot(tag: string): Promise<string> {
  const root = join(tmpdir(), `pi-tg-phase7-${tag}-${Date.now()}`);
  await mkdir(join(root, "src"), { recursive: true });
  return root;
}

async function readAuditLines(root: string): Promise<string[]> {
  const log = await readFile(auditLogFileFor(join(root, ".pi", "audit")), "utf-8");
  return log.trim().split("\n");
}

function violationSources(meta: SessionMeta): Array<[string, string | undefined]> {
  return (meta.violations ?? []).map((v) => [v.type, v.guardSource]);
}

afterEach(() => {
  __resetAuditDirPath();
});

describe("Phase 7: guardSource assignment (empirical triggers)", () => {
  it("write outside stage write whitelist records read_only_path", async () => {
    const root = await freshRoot("wl");
    const config = makeTestConfig({ projectRoot: root });
    // 218: pin the PRE-218 deny behaviour — whitelist-miss now defaults to the merged ask
    config.protect = { ...config.protect, whitelistMiss: "deny" };
    config.stages["develop"] = {
      ...config.stages["develop"],
      allowedWritePaths: ["docs/"],
    };
    await initAuditLog(config);

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);
    ctx.toolCall = { name: "write", arguments: { file_path: join(root, "src", "app.ts") } };

    const result = await createToolGuard(config).handler(ctx as any);
    expect((result as { block?: boolean })?.block).toBe(true);

    const recorded = ctx.session.getMeta() as SessionMeta;
    expect(violationSources(recorded)).toEqual([["write_protected", "read_only_path"]]);

    const lines = await readAuditLines(root);
    const vLine = lines.find((l) => l.includes("pipeline_violation"));
    expect(vLine).toBeDefined();
    expect(vLine).toContain("guardSource=read_only_path");
    expect(vLine).toContain("bucketCount=1");
    expect(vLine).toContain(`bucketLimit=${DEFAULT_MAX_VIOLATIONS}`);
  });

  it("write on gitignore-protected path records git_policy", async () => {
    const root = await freshRoot("git");
    await writeFile(join(root, ".gitignore"), "secret.txt\n");
    const config = makeTestConfig({ projectRoot: root });
    await initAuditLog(config);

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);
    ctx.toolCall = { name: "write", arguments: { file_path: join(root, "secret.txt") } };

    const result = await createToolGuard(config).handler(ctx as any);
    expect((result as { block?: boolean })?.block).toBe(true);

    const recorded = ctx.session.getMeta() as SessionMeta;
    expect(violationSources(recorded)).toEqual([["write_protected", "git_policy"]]);

    const lines = await readAuditLines(root);
    const vLine = lines.find((l) => l.includes("pipeline_violation"));
    expect(vLine).toContain("guardSource=git_policy");
    expect(vLine).toContain("bucketCount=1");
    expect(vLine).toContain(`bucketLimit=${DEFAULT_MAX_VIOLATIONS}`);
  });

  it("bash destructive command on system path records bash_destructive", async () => {
    const root = await freshRoot("rm");
    const config = makeTestConfig({ projectRoot: root });
    await initAuditLog(config);

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);
    ctx.toolCall = { name: "bash", arguments: { command: "rm -rf /" } };

    const result = await createToolGuard(config).handler(ctx as any);
    expect((result as { block?: boolean })?.block).toBe(true);

    const recorded = ctx.session.getMeta() as SessionMeta;
    expect(violationSources(recorded)).toEqual([["bash_destructive", "bash_destructive"]]);

    const lines = await readAuditLines(root);
    const vLine = lines.find((l) => l.includes("pipeline_violation"));
    expect(vLine).toContain("guardSource=bash_destructive");
    expect(vLine).toContain("bucketCount=1");
    expect(vLine).toContain(`bucketLimit=${DEFAULT_BASH_DESTRUCTIVE_PROMPT_MAX}`);
  });

  it("one blocked tool call records exactly one violation (no double count)", async () => {
    // The guard returns on the first blocking validator, so an action that
    // would match multiple policy classes can still only record once.
    // `rm -rf /` hits both the destructive-prompt path and the system-path
    // safety net region — only a single item must reach meta.violations.
    const root = await freshRoot("dedup");
    const config = makeTestConfig({ projectRoot: root });
    await initAuditLog(config);

    const meta = makeTestMeta({ currentStage: "develop" });
    const ctx = createMockCtx(meta);
    ctx.toolCall = { name: "bash", arguments: { command: "rm -rf /" } };

    await createToolGuard(config).handler(ctx as any);

    const recorded = ctx.session.getMeta() as SessionMeta;
    expect(recorded.violations?.length).toBe(1);
  });
});

describe("Phase 7: bash_destructive never freezes the pipeline", () => {
  it("exceeding DEFAULT_BASH_DESTRUCTIVE_PROMPT_MAX does not block or freeze", async () => {
    const root = await freshRoot("nofreeze");
    const config = makeTestConfig({ projectRoot: root });
    await initAuditLog(config);

    const meta = makeTestMeta({ currentStage: "develop" });
    const iterations = DEFAULT_BASH_DESTRUCTIVE_PROMPT_MAX + 5;
    for (let i = 0; i < iterations; i++) {
      const ctx = createMockCtx(meta);
      ctx.toolCall = { name: "bash", arguments: { command: "rm -rf /" } };
      await createToolGuard(config).handler(ctx as any);
    }

    // Every iteration recorded its item (advisory stream is visible)...
    expect(meta.violations?.length).toBe(iterations);
    // ...but the bash_destructive bucket must never take the pipeline down.
    expect(meta.flowState).not.toBe("blocked");
    expect(meta.blockedReason).not.toBe("violation_overflow");

    const lines = await readAuditLines(root);
    expect(lines.some((l) => l.includes("pipeline_blocked"))).toBe(false);
  });
});
