/**
 * 225 Phase 4 (T3): git write block-reason SOURCE attribution.
 *
 * Three config provenances, one contract:
 * - stage-level `protect.gitModify` → names `stages.<stage>.protect.gitModify`;
 * - global `protect.gitModify` → names `protect.gitModify` (+ /reload hint);
 * - ACTIVE auto-job overlay → "Policy comes from the active auto job
 *   (writePolicy.gitModify); editing pipeline_loop.json will not change it"
 *   and the stale /reload hint must NOT appear.
 */

import { describe, it, expect } from "bun:test";
import { createToolGuard } from "../../core/tool-guard";
import { applyOverlay, restoreOverlay, __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { auditAutoDecision } from "../../core/auto-pipeline/auto-audit";
import type { PipelineConfig, SessionMeta } from "../../types";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function developCtx(config: PipelineConfig, command: string) {
  const root = config.projectRoot;
  fs.mkdirSync(join(root, "agents"), { recursive: true });
  fs.writeFileSync(join(root, "agents", "dev.md"), "---\nname: dev-agent\n---\n# dev\n");
  config.stages.develop = {
    ...(config.stages.develop ?? {}),
    agentPath: "agents/dev.md",
    skillPath: "dev/SKILL.md",
    nextStage: null,
    requireDomain: false,
  } as PipelineConfig["stages"]["develop"];
  const meta: SessionMeta = makeTestMeta({ currentStage: "develop" });
  const ctx = createMockCtx(meta);
  ctx.toolCall = { name: "bash", arguments: { command } };
  return { ctx, meta };
}

describe("git write block reason — source attribution", () => {
  it("stage-level source names the stage key (overwrite branch)", async () => {
    const root = join(tmpdir(), "git-src-stage-" + Date.now());
    fs.mkdirSync(root, { recursive: true });
    try {
      const config = makeTestConfig({ projectRoot: root });
      (config.protect as Record<string, unknown>).gitModify = "block";
      (config.stages as Record<string, unknown>).develop = {
        ...((config.stages as Record<string, unknown>).develop as object),
        protect: { gitModify: "block" },
      };
      const { ctx } = developCtx(config, "git push origin main");
      const result = (await createToolGuard(config).handler(ctx as never)) as { block?: boolean; reason?: string };
      expect(result.block).toBe(true);
      expect(result.reason).toContain("stages.develop.protect.gitModify");
      fs.rmSync(root, { recursive: true, force: true });
    } finally {
      __resetAutoJobLockForTests();
    }
  });

  it("overlay-owned source explains the ACTIVE auto job and drops /reload", async () => {
    const root = join(tmpdir(), "git-src-overlay-" + Date.now());
    fs.mkdirSync(root, { recursive: true });
    try {
      __resetAutoJobLockForTests();
      const config = makeTestConfig({ projectRoot: root });
      (config.protect as Record<string, unknown>).gitModify = "block";
      // Attribute the value to the ACTIVE auto job (as applyOverlay does —
      // direct mutation here keeps the unit focused on the message contract).
      config.configOverlayKeys = ["protect.gitModify"];
      const { ctx } = developCtx(config, "git push origin main");
      const result = (await createToolGuard(config).handler(ctx as never)) as { block?: boolean; reason?: string };
      expect(result.block).toBe(true);
      expect(result.reason).toContain("Policy comes from the active auto job (writePolicy.gitModify)");
      expect(result.reason).toContain("editing pipeline_loop.json will not change it");
      expect(result.reason).not.toContain("/reload");
      fs.rmSync(root, { recursive: true, force: true });
    } finally {
      __resetAutoJobLockForTests();
    }
  });

  it("applyOverlay records the overlay keys; restore clears them back to pristine", () => {
    __resetAutoJobLockForTests();
    const root = join(tmpdir(), "git-src-apply-" + Date.now());
    fs.mkdirSync(root, { recursive: true });
    try {
      const config = makeTestConfig({ projectRoot: root, maxLoops: 3 });
      const baseJson = {
        stages: {
          plan: { nextStage: "develop" },
          review: { nextStage: "fix" },
        },
        protect: { gitModify: "allow" },
      } as never;
      const job = {
        writePolicy: { gitModify: "block" },
        configured: { gitModify: true },
        jobHash: "h-unit-225",
      } as never;
      const before = JSON.stringify(config);
      const jobIdLock = acquireForTest(root);
      const snapshot = applyOverlay(config, baseJson, job);
      expect(config.configOverlayKeys).toContain("protect.gitModify");
      expect(config.protect?.gitModify).toBe("block");
      restoreOverlay(config, snapshot);
      expect(config.configOverlayKeys).toBeUndefined();
      releaseForTest(root, jobIdLock);
      void before;
    } finally {
      __resetAutoJobLockForTests();
    }
  });
});

function acquireForTest(root: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("../../core/auto-pipeline/config-overlay") as {
    acquireJobLock(input: { projectRoot: string; jobId: string }): { ok: boolean; token?: string };
  };
  const got = mod.acquireJobLock({ projectRoot: root, jobId: "unit_225_overlay" });
  if (!got.ok || !got.token) throw new Error("lock acquire failed");
  return got.token;
}

function releaseForTest(root: string, token: string): void {
  const mod = require("../../core/auto-pipeline/config-overlay") as {
    releaseJobLock(input: { projectRoot: string; token: string }): unknown;
  };
  mod.releaseJobLock({ projectRoot: root, token });
}
