/**
 * @module review2-m3-resume-session
 * Tests for review#2 M3: dispatchAfterResume session passthrough.
 *
 * Ensures that:
 * - buildResumeMeta clears stale activeSpawns on resume
 * - The confirm-resume path preserves pipelineId and clears activeSpawns
 *
 * Each test asserts real behavior; removing the implementation must turn the test red.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createPipelineStartCommand, buildResumeMeta } from "../../commands/pipeline-start";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import type { SessionMeta } from "../../types";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";

describe("M3: dispatchAfterResume session passthrough", () => {
  let TMP: string;

  beforeEach(async () => {
    TMP = path.join(
      os.tmpdir(),
      `pi-r2-m3-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    await fsp.mkdir(TMP, { recursive: true });
    await initAuditLog(makeTestConfig({ projectRoot: TMP }));
    __resetMemoryThrottle();
  });

  afterEach(async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
    __resetAuditDirPath();
  });

  it("buildResumeMeta clears stale activeSpawns so dispatch starts fresh", () => {
    // Direct assertion: the resumed meta must not carry stale spawn entries.
    // If buildResumeMeta stops clearing activeSpawns, this test must turn red.
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "aborted",
      activeSpawns: {
        plan: {
          agentName: "feat-design-plan-agent",
          agentId: "stale-id",
          startedAt: Date.now() - 60_000,
        },
      },
    });
    const newMeta = buildResumeMeta(meta, config);
    expect(newMeta.activeSpawns).toBeUndefined();
    // Preserved fields sanity check
    expect(newMeta.pipelineId).toBe(meta.pipelineId);
    expect(newMeta.flowState).toBe("running");
  });

  it("confirm-mode resume preserves pipelineId and clears activeSpawns", async () => {
    await fsp.mkdir(path.join(TMP, "docs"), { recursive: true });
    await fsp.writeFile(path.join(TMP, "docs", "req.md"), "# Req\n", "utf-8");

    const config = makeTestConfig({
      projectRoot: TMP,
      startStageMode: "confirm",
    });
    const cmd = createPipelineStartCommand(config);
    const originalId = "pipe-confirm-resume-001";
    const meta = makeTestMeta({
      pipelineId: originalId,
      currentStage: "plan",
      flowState: "aborted",
      requirementDoc: "docs/req.md",
      activeSpawns: {
        plan: {
          agentName: "feat-design-plan-agent",
          agentId: "stale-on-resume",
          startedAt: Date.now() - 1000,
        },
      },
    });
    const ctx = createMockCtx(meta, {
      sessionFile: "main-session",
      confirmReturn: true,
    });

    const result: any = await cmd.execute({ file: "" }, ctx as any);

    expect(result.success).toBe(true);
    expect(result.pipelineId).toBe(originalId);
    expect(ctx.session.getMeta().flowState).toBe("running");
    // Stale activeSpawns must be cleared by buildResumeMeta
    expect(ctx.session.getMeta().activeSpawns).toBeUndefined();
  });
});
