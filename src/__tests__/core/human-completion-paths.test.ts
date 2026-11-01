/**
 * 221 Phase 2: every terminal entry point performs the SAME one-shot human
 * completion release.
 *
 * Paths (plan task 4):
 * - tool advance (`stage_advance`) reaching `completed`;
 * - hook auto-advance (`autoAdvanceAfterVerify`) reaching `completed`;
 * - settle fallback (`agent_settled`) — the safety net for the flow-state
 *   skip/choose_stage paths that emit no advance event.
 *
 * The one-shot meta stamp makes the fallback a no-op after any earlier path.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createStageAdvancer } from "../../core/stage-advancer";
import { autoAdvanceAfterVerify } from "../../core/verify-advance";
import { createAgentSettled } from "../../core/agent-settled";
import { createPipelineUI } from "../../core/pipeline-ui";
import { __resetAutoJobLockForTests } from "../../core/auto-pipeline/config-overlay";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import { createMockCtx, makeTestConfig, makeTestMeta } from "../helpers";
import type { PipelineConfig, SessionMeta } from "../../types";

const PASS_RESULT = {
  structuredResult: { failures: [] },
  ruleMissing: [],
  verifyResult: { structured: { passed: true }, llm: null as unknown, overallPassed: true },
};

let TMP: string;
let config: PipelineConfig;

beforeEach(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-221-completion-paths-"));
  __resetAutoJobLockForTests();
  config = makeTestConfig({ projectRoot: TMP });
  await initAuditLog(config);
});

afterEach(() => {
  __resetAuditDirPath();
  __resetAutoJobLockForTests();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function terminalMeta(): SessionMeta {
  return makeTestMeta({
    currentStage: "review",
    stageVisitOrder: ["clarify", "plan", "develop", "review"],
    sessionAllowedCommands: ["git status"],
    verifyAttempts: 2,
  });
}

const completionHint = (notifications: string[]): string[] =>
  notifications.filter((message) => message.includes("/pipeline-start <doc>"));

describe("human completion paths", () => {
  it("tool advance to completed releases once", async () => {
    config.stages["review"] = { ...config.stages["review"]!, nextStage: "completed" };
    const meta = terminalMeta();
    const ctx = createMockCtx(meta);

    const result = (await createStageAdvancer(config).execute({}, ctx as never)) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(meta.currentStage).toBe("completed");
    expect(meta.terminalCleanupAt).toBeGreaterThan(0);
    expect(meta.sessionAllowedCommands).toEqual([]);
    expect(completionHint(ctx.notifications)).toHaveLength(1);
  });

  it("hook auto-advance to completed releases once", async () => {
    const meta = terminalMeta();
    const ctx = createMockCtx(meta);
    meta.currentStage = "review";

    await autoAdvanceAfterVerify(
      config,
      ctx as never,
      meta,
      "review",
      "completed",
      PASS_RESULT as never,
      createPipelineUI(config),
      { caller: "auto_advance" },
    );

    expect(meta.terminalCleanupAt).toBeGreaterThan(0);
    expect(meta.sessionAllowedCommands).toEqual([]);
    expect(completionHint(ctx.notifications)).toHaveLength(1);
  });

  it("settle fallback releases once on a completed session", async () => {
    const meta = makeTestMeta({
      currentStage: "completed",
      sessionAllowedCommands: ["git status"],
    });
    const ctx = createMockCtx(meta);
    const hook = createAgentSettled(config);

    await hook.handler(ctx as never);
    expect(meta.terminalCleanupAt).toBeGreaterThan(0);

    // A second settle must not release or hint again.
    await hook.handler(ctx as never);
    expect(completionHint(ctx.notifications)).toHaveLength(1);
  });

  it("the settle fallback is a no-op after a tool advance already cleaned up", async () => {
    config.stages["review"] = { ...config.stages["review"]!, nextStage: "completed" };
    const meta = terminalMeta();
    const ctx = createMockCtx(meta);

    await createStageAdvancer(config).execute({}, ctx as never);
    const stamp = meta.terminalCleanupAt;

    await createAgentSettled(config).handler(ctx as never);

    expect(meta.terminalCleanupAt).toBe(stamp);
    expect(completionHint(ctx.notifications)).toHaveLength(1);
  });
});
