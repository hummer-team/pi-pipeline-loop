/**
 * @module review2-m3-resume-session
 * Tests for review#2 M3: dispatchAfterResume session passthrough.
 *
 * review#3 H2 fix: Added full-chain integration test that exercises
 * aborted→resume→dispatchAfterResume→RPC spawn→activeSpawns write.
 * Deleting the session shim in dispatchAfterResume must turn this test red.
 *
 * review#3 H3 fix: Replaced the empty buildResumeMeta direct test with an
 * updateMeta-merge integration test that correctly detects removal of the
 * activeSpawns clearing implementation.
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

/** Write an agent definition file so resolveAgentMention returns a name. */
async function writeAgentFile(
  projectRoot: string,
  agentPath: string,
  name: string,
): Promise<void> {
  const fullPath = path.join(projectRoot, agentPath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(fullPath, `---\nname: ${name}\n---\n# Agent\n`);
}

/**
 * Build a mock pi EventBus that auto-responds to ping+spawn RPCs.
 */
function createMockEventBus(spawnId: string) {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const capturedEmits: Array<{ event: string; payload: Record<string, unknown> }> = [];

  const bus = {
    emit(event: string, payload: Record<string, unknown>) {
      capturedEmits.push({ event, payload });
      if (event === "subagents:rpc:ping") {
        setTimeout(
          () =>
            (handlers.get(`subagents:rpc:ping:reply:${payload.requestId}`) ?? [])
              .forEach((h) => h({ success: true })),
          5,
        );
      } else if (event === "subagents:rpc:spawn") {
        setTimeout(
          () =>
            (handlers.get(`subagents:rpc:spawn:reply:${payload.requestId}`) ?? [])
              .forEach((h) => h({ success: true, data: { id: spawnId } })),
          5,
        );
      }
    },
    on(event: string, handler: (payload: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    off(event: string, handler: (payload: unknown) => void) {
      const list = handlers.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    },
  };

  return { bus, capturedEmits };
}

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

  // H3 fix: rewrite the empty buildResumeMeta direct test to go through
  // updateMeta merge semantics. The previous version asserted newMeta.activeSpawns
  // directly, which was structurally empty (buildResumeMeta constructs a new object
  // without spreading old values, so activeSpawns is always absent regardless of
  // whether the clearing implementation exists). By routing through updateMeta merge,
  // we simulate the real flow: old meta has activeSpawns → buildResumeMeta output is
  // applied via updateMeta → merged result must not carry stale activeSpawns.
  // Removing the `activeSpawns: undefined` line from buildResumeMeta → test red.
  it("buildResumeMeta clears stale activeSpawns via updateMeta merge (not direct inspection)", () => {
    const config = makeTestConfig();
    const staleSpawn = {
      agentName: "feat-design-plan-agent",
      agentId: "stale-id",
      startedAt: Date.now() - 60_000,
    };
    const meta = makeTestMeta({
      currentStage: "plan",
      flowState: "aborted",
      activeSpawns: { plan: staleSpawn },
      spawnedStages: { plan: Date.now() - 60_000 },
    });

    // Simulate the real flow: buildResumeMeta → updateMeta (merge semantics)
    const ctx = createMockCtx(meta);
    const newMeta = buildResumeMeta(meta, config);
    ctx.session.updateMeta(newMeta);

    // After merge, activeSpawns and spawnedStages must be cleared
    expect(ctx.session.getMeta().activeSpawns).toBeUndefined();
    expect(ctx.session.getMeta().spawnedStages).toBeUndefined();
    // Preserved fields remain intact
    expect(ctx.session.getMeta().pipelineId).toBe(meta.pipelineId);
    expect(ctx.session.getMeta().flowState).toBe("running");
  });

  // Existing confirm-mode integration test (has real judgment power per review#3)
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

  // H2 fix: full-chain integration test for resume-dispatch → activeSpawns write.
  // This test exercises: aborted plan → auto-resume → dispatchAfterResume →
  // spawnStageSubagent (RPC path) → writeGuard → activeSpawns[plan] written.
  // Deleting the session shim in dispatchAfterResume must turn this test red
  // (without session, spawnStageSubagent skips the activeSpawns write).
  it("H2: aborted plan → auto-resume → dispatchAfterResume → RPC spawn writes activeSpawns[plan].agentId", async () => {
    await fsp.mkdir(path.join(TMP, "docs"), { recursive: true });
    await fsp.writeFile(path.join(TMP, "docs", "req.md"), "# Req\n", "utf-8");

    const config = makeTestConfig({
      projectRoot: TMP,
      startStageMode: "auto",
    });
    // Write agent file for plan stage so resolveAgentMention returns a name
    await writeAgentFile(TMP, config.stages["plan"].agentPath!, "feat-design-plan-agent");

    const cmd = createPipelineStartCommand(config);
    const originalId = "pipe-resume-spawn-001";
    const meta = makeTestMeta({
      pipelineId: originalId,
      currentStage: "plan",
      flowState: "aborted",
      requirementDoc: "docs/req.md",
      terminateReason: "session_quit",
      activeSpawns: {
        plan: {
          agentName: "feat-design-plan-agent",
          agentId: "stale-from-prev-run",
          startedAt: Date.now() - 100_000,
        },
      },
    });
    const ctx = createMockCtx(meta, {
      sessionFile: "main-session",
    });

    // Attach mock pi with EventBus that responds to ping+spawn
    const spawnId = "subagent-resume-h2-xyz";
    const { bus } = createMockEventBus(spawnId);
    (ctx as any).pi = { events: bus };

    // Execute: same doc → resume-eligible → auto-resume → dispatchAfterResume
    const result: any = await cmd.execute({ file: "docs/req.md" }, ctx as any);

    expect(result.success).toBe(true);
    expect(result.pipelineId).toBe(originalId);
    expect(result.currentStage).toBe("plan");

    // H2 key assertion: activeSpawns[plan] must be written with the RPC-returned agentId.
    // This proves that:
    // 1. buildResumeMeta cleared stale activeSpawns (old "stale-from-prev-run" gone)
    // 2. dispatchAfterResume passed session shim to spawnStageSubagent
    // 3. spawnStageSubagent RPC path succeeded and writeGuard wrote activeSpawns
    // Deleting the session shim in dispatchAfterResume → spawnStageSubagent has no
    // session → writeGuard is skipped → activeSpawns stays undefined → test turns red.
    const finalMeta = ctx.session.getMeta();
    expect(finalMeta.activeSpawns).toBeDefined();
    expect(finalMeta.activeSpawns?.plan).toBeDefined();
    expect(finalMeta.activeSpawns?.plan?.agentId).toBe(spawnId);
    expect(finalMeta.activeSpawns?.plan?.agentName).toBe("feat-design-plan-agent");
  });

  // H2 variant: confirm-mode resume → dispatch → RPC spawn writes activeSpawns.
  // Tests the confirm-resume path (not auto) to ensure dispatchAfterResume works
  // regardless of the resume trigger.
  it("H2-variant: confirm-resume → dispatchAfterResume → RPC spawn writes activeSpawns[develop].agentId", async () => {
    await fsp.mkdir(path.join(TMP, "docs"), { recursive: true });
    await fsp.writeFile(path.join(TMP, "docs", "req.md"), "# Req\n", "utf-8");

    const config = makeTestConfig({
      projectRoot: TMP,
      startStageMode: "confirm",
    });
    // Write agent file for develop stage
    await writeAgentFile(TMP, config.stages["develop"].agentPath!, "develop-agent");

    const cmd = createPipelineStartCommand(config);
    const originalId = "pipe-confirm-spawn-001";
    const meta = makeTestMeta({
      pipelineId: originalId,
      currentStage: "develop",
      flowState: "aborted",
      requirementDoc: "docs/req.md",
      terminateReason: "session_quit",
    });
    const ctx = createMockCtx(meta, {
      sessionFile: "main-session",
      confirmReturn: true,
    });

    const spawnId = "subagent-confirm-h2-xyz";
    const { bus } = createMockEventBus(spawnId);
    (ctx as any).pi = { events: bus };

    const result: any = await cmd.execute({ file: "docs/req.md" }, ctx as any);

    expect(result.success).toBe(true);
    expect(result.pipelineId).toBe(originalId);
    expect(result.currentStage).toBe("develop");

    // activeSpawns[develop] must be written via the confirm-resume → dispatch chain
    const finalMeta = ctx.session.getMeta();
    expect(finalMeta.activeSpawns?.develop).toBeDefined();
    expect(finalMeta.activeSpawns?.develop?.agentId).toBe(spawnId);
  });

  // H2 lifecycle: after resume-dispatch spawn, a subagent:completed event
  // clears the activeSpawns entry. This tests the full lifecycle on the
  // resume path (not just the direct spawnStageSubagent path as in E1).
  it("H2-lifecycle: after resume-dispatch spawn, subagent:completed clears activeSpawns[plan]", async () => {
    await fsp.mkdir(path.join(TMP, "docs"), { recursive: true });
    await fsp.writeFile(path.join(TMP, "docs", "req.md"), "# Req\n", "utf-8");

    const config = makeTestConfig({
      projectRoot: TMP,
      startStageMode: "auto",
    });
    await writeAgentFile(TMP, config.stages["plan"].agentPath!, "feat-design-plan-agent");

    const cmd = createPipelineStartCommand(config);
    const meta = makeTestMeta({
      pipelineId: "pipe-lifecycle-h2",
      currentStage: "plan",
      flowState: "aborted",
      requirementDoc: "docs/req.md",
      terminateReason: "session_quit",
    });
    const ctx = createMockCtx(meta, { sessionFile: "main-session" });

    const spawnId = "subagent-lifecycle-h2";
    const handlers = new Map<string, Array<(payload: unknown) => void>>();
    const bus = {
      emit(event: string, payload: Record<string, unknown>) {
        if (event === "subagents:rpc:ping") {
          setTimeout(
            () => (handlers.get(`subagents:rpc:ping:reply:${payload.requestId}`) ?? [])
              .forEach((h) => h({ success: true })),
            5,
          );
        } else if (event === "subagents:rpc:spawn") {
          setTimeout(
            () => (handlers.get(`subagents:rpc:spawn:reply:${payload.requestId}`) ?? [])
              .forEach((h) => h({ success: true, data: { id: spawnId } })),
            5,
          );
        }
      },
      on(event: string, handler: (payload: unknown) => void) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      off(event: string, handler: (payload: unknown) => void) {
        const list = handlers.get(event);
        if (list) {
          const idx = list.indexOf(handler);
          if (idx >= 0) list.splice(idx, 1);
        }
      },
    };
    (ctx as any).pi = { events: bus };

    await cmd.execute({ file: "docs/req.md" }, ctx as any);

    // After resume-dispatch, activeSpawns[plan] should be written
    expect(ctx.session.getMeta().activeSpawns?.plan?.agentId).toBe(spawnId);

    // Simulate subagent:completed lifecycle event
    const completedHandlers = handlers.get("subagents:completed") ?? [];
    expect(completedHandlers.length).toBeGreaterThan(0);
    // Fire the completed event with matching id
    completedHandlers.forEach((h) => h({ id: spawnId }));

    // After lifecycle settle, activeSpawns[plan] must be cleared
    const afterSettle = ctx.session.getMeta();
    expect(afterSettle.activeSpawns?.plan).toBeUndefined();
  });
});
