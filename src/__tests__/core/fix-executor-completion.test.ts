import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  handleFixExecutorCompleted,
  type FixExecutorCompletedCtx,
} from "../../core/fix-executor-completion";
import {
  setFixExecutorCompletedHandler,
  spawnStageSubagent,
} from "../../utils/subagent-rpc";
import {
  markSubagentsReady,
  __resetSubagentsReady,
} from "../../utils/subagent-availability";
import {
  initAuditLog,
  getDateAuditFileName,
  __resetAuditDirPath,
} from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, createMockEventBus } from "../helpers";
import type { PipelineConfig, SessionMeta } from "../../types";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for fix-executor-completion handler (Phase 0 / 189).
 *
 * Covers:
 * - Event-bus-driven tests (A-F): migrate from subagent-rpc.test.ts
 * - Direct-call unit tests: precondition guards, error handling
 */

beforeEach(() => {
  markSubagentsReady();
  // Register handler for event-bus-driven tests
  setFixExecutorCompletedHandler(handleFixExecutorCompleted);
});

afterEach(() => {
  __resetSubagentsReady();
  __resetAuditDirPath();
  // Clear handler to prevent cross-file leakage
  setFixExecutorCompletedHandler(null);
});

function makeFixConfig() {
  const tmpDir = path.join(tmpdir(), "pi-phase3-fix-" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const agentDir = path.join(tmpDir, "agents");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "fix-agent.md"),
    "---\nname: fix-agent\n---\n# Fix Agent\n",
  );

  const config = makeTestConfig({
    projectRoot: tmpDir,
    stages: {
      ...makeTestConfig().stages,
      fix: {
        agentPath: "agents/fix-agent.md",
        nextStage: "review",
        requireDomain: false,
      },
      review: {
        agentPath: "agents/fix-agent.md", // reuse for simplicity
        nextStage: "fix",
        requireDomain: false,
      },
    },
  } as any);
  return { config, tmpDir };
}

// ─── Event-bus-driven tests (migrated from subagent-rpc.test.ts) ────────────

describe("Phase 3 (189): Fix-complete auto-unfreeze", () => {
  it("A. blocked(max_loop_cycles) + fix completed → unfreeze + advance to review + review spawned; audit fix_completed_auto_unfreeze", async () => {
    const { config, tmpDir } = makeFixConfig();
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "fix",
      pipelineId: "pipe-phase3-a",
      flowState: "blocked",
      blockedReason: "max_loop_cycles",
      loopCount: 5,
    });

    const bus = createMockEventBus();
    const origEmit = bus.emit.bind(bus);
    bus.emit = (event: string, payload: Record<string, unknown>) => {
      origEmit(event, payload);
      if (event === "subagents:rpc:spawn") {
        const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
        setTimeout(() => bus.trigger(replyChannel, { success: true, data: { id: "sa-fix-completed" } }), 5);
      }
    };
    const mockPi = { events: bus, sendUserMessage: () => {} };
    const session = {
      getMeta: () => meta,
      updateMeta: (patch: Record<string, unknown>) => Object.assign(meta, patch),
    };

    // Spawn fix executor
    const result = await spawnStageSubagent(mockPi, config, "fix", meta, {
      ui: { notify: () => {} },
      session: session as any,
    });

    expect(result.spawned).toBe(true);
    expect(result.fallback).toBe(false);

    // Simulate fix executor completion
    bus.trigger("subagents:completed", { id: "sa-fix-completed" });

    // Wait for async processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify unfreeze
    expect(meta.flowState).toBe("running");
    expect(meta.blockedReason).toBeUndefined();
    expect(meta.loopCount).toBe(0);

    // Verify advance to review (currentStage should be review after autoAdvanceAfterVerify)
    expect(meta.currentStage).toBe("review");

    // Verify audit log
    const logContent = fs.readFileSync(
      path.join(tmpDir, ".pi", "audit", getDateAuditFileName()),
      "utf-8",
    );
    expect(logContent).toContain("fix_completed_auto_unfreeze");
    expect(logContent).toContain("pipelineId=pipe-phase3-a");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("B. blocked(loop_overflow) + fix completed → no unfreeze (reason-exact guard)", async () => {
    const { config, tmpDir } = makeFixConfig();
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "fix",
      pipelineId: "pipe-phase3-b",
      flowState: "blocked",
      blockedReason: "loop_overflow",
      loopCount: 10,
    });

    const bus = createMockEventBus();
    const origEmit = bus.emit.bind(bus);
    bus.emit = (event: string, payload: Record<string, unknown>) => {
      origEmit(event, payload);
      if (event === "subagents:rpc:spawn") {
        const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
        setTimeout(() => bus.trigger(replyChannel, { success: true, data: { id: "sa-fix-loop-overflow" } }), 5);
      }
    };
    const mockPi = { events: bus, sendUserMessage: () => {} };
    const session = {
      getMeta: () => meta,
      updateMeta: (patch: Record<string, unknown>) => Object.assign(meta, patch),
    };

    await spawnStageSubagent(mockPi, config, "fix", meta, {
      ui: { notify: () => {} },
      session: session as any,
    });

    // Simulate completion
    bus.trigger("subagents:completed", { id: "sa-fix-loop-overflow" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify NO unfreeze (blockedReason remains loop_overflow)
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("loop_overflow");
    expect(meta.loopCount).toBe(10);
    expect(meta.currentStage).toBe("fix");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("C. blocked(max_loop_cycles) + develop completed → untouched", async () => {
    const { config, tmpDir } = makeFixConfig();
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-phase3-c",
      flowState: "blocked",
      blockedReason: "max_loop_cycles",
      loopCount: 5,
    });

    const bus = createMockEventBus();
    const origEmit = bus.emit.bind(bus);
    bus.emit = (event: string, payload: Record<string, unknown>) => {
      origEmit(event, payload);
      if (event === "subagents:rpc:spawn") {
        const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
        setTimeout(() => bus.trigger(replyChannel, { success: true, data: { id: "sa-develop-completed" } }), 5);
      }
    };
    const mockPi = { events: bus, sendUserMessage: () => {} };
    const session = {
      getMeta: () => meta,
      updateMeta: (patch: Record<string, unknown>) => Object.assign(meta, patch),
    };

    await spawnStageSubagent(mockPi, config, "develop", meta, {
      ui: { notify: () => {} },
      session: session as any,
    });

    // Simulate completion
    bus.trigger("subagents:completed", { id: "sa-develop-completed" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify NO unfreeze (stage is develop, not fix)
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("max_loop_cycles");
    expect(meta.currentStage).toBe("develop");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("D. fix completed while flowState === running → only clearActiveSpawn (regression)", async () => {
    const { config, tmpDir } = makeFixConfig();
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "fix",
      pipelineId: "pipe-phase3-d",
      flowState: "running",
      blockedReason: undefined,
      loopCount: 0,
    });

    const bus = createMockEventBus();
    const origEmit = bus.emit.bind(bus);
    bus.emit = (event: string, payload: Record<string, unknown>) => {
      origEmit(event, payload);
      if (event === "subagents:rpc:spawn") {
        const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
        setTimeout(() => bus.trigger(replyChannel, { success: true, data: { id: "sa-fix-running" } }), 5);
      }
    };
    const mockPi = { events: bus, sendUserMessage: () => {} };
    const session = {
      getMeta: () => meta,
      updateMeta: (patch: Record<string, unknown>) => Object.assign(meta, patch),
    };

    await spawnStageSubagent(mockPi, config, "fix", meta, {
      ui: { notify: () => {} },
      session: session as any,
    });

    // Simulate completion
    bus.trigger("subagents:completed", { id: "sa-fix-running" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify no unfreeze (already running, no blockedReason)
    expect(meta.flowState).toBe("running");
    expect(meta.blockedReason).toBeUndefined();
    expect(meta.currentStage).toBe("fix");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("E. subagents:failed for fix while blocked → no unfreeze", async () => {
    const { config, tmpDir } = makeFixConfig();
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "fix",
      pipelineId: "pipe-phase3-e",
      flowState: "blocked",
      blockedReason: "max_loop_cycles",
      loopCount: 5,
    });

    const bus = createMockEventBus();
    const origEmit = bus.emit.bind(bus);
    bus.emit = (event: string, payload: Record<string, unknown>) => {
      origEmit(event, payload);
      if (event === "subagents:rpc:spawn") {
        const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
        setTimeout(() => bus.trigger(replyChannel, { success: true, data: { id: "sa-fix-failed" } }), 5);
      }
    };
    const mockPi = { events: bus, sendUserMessage: () => {} };
    const session = {
      getMeta: () => meta,
      updateMeta: (patch: Record<string, unknown>) => Object.assign(meta, patch),
    };

    await spawnStageSubagent(mockPi, config, "fix", meta, {
      ui: { notify: () => {} },
      session: session as any,
    });

    // Simulate failure (not completion)
    bus.trigger("subagents:failed", { id: "sa-fix-failed" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify NO unfreeze (only "completed" triggers unfreeze)
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("max_loop_cycles");
    expect(meta.currentStage).toBe("fix");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("F. helper throws (mock session unavailable) → error audit + frozen state unchanged", async () => {
    const { config, tmpDir } = makeFixConfig();
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "fix",
      pipelineId: "pipe-phase3-f",
      flowState: "blocked",
      blockedReason: "max_loop_cycles",
      loopCount: 5,
    });

    const bus = createMockEventBus();
    const origEmit = bus.emit.bind(bus);
    bus.emit = (event: string, payload: Record<string, unknown>) => {
      origEmit(event, payload);
      if (event === "subagents:rpc:spawn") {
        const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
        setTimeout(() => bus.trigger(replyChannel, { success: true, data: { id: "sa-fix-error" } }), 5);
      }
    };
    const mockPi = { events: bus, sendUserMessage: () => {} };

    // Mock session that throws only when handleFixExecutorCompleted tries to unfreeze
    const session = {
      getMeta: () => meta,
      updateMeta: (patch: Record<string, unknown>) => {
        // Throw only when trying to set flowState to "running" (the unfreeze action)
        if (patch.flowState === "running") {
          throw new Error("Session unavailable");
        }
        return Object.assign(meta, patch);
      },
    };

    await spawnStageSubagent(mockPi, config, "fix", meta, {
      ui: { notify: () => {} },
      session: session as any,
    });

    // Simulate completion
    bus.trigger("subagents:completed", { id: "sa-fix-error" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify frozen state unchanged (error caught)
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("max_loop_cycles");
    expect(meta.currentStage).toBe("fix");

    // Verify error audit
    const logContent = fs.readFileSync(
      path.join(tmpDir, ".pi", "audit", getDateAuditFileName()),
      "utf-8",
    );
    expect(logContent).toContain("fix_unfreeze_error");
    expect(logContent).toContain("Session unavailable");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── Direct-call unit tests ──────────────────────────────────────────────────

describe("handleFixExecutorCompleted: direct-call preconditions", () => {
  it("stage !== 'fix' → no-op", async () => {
    const { config, tmpDir } = makeFixConfig();
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "develop", // not fix
      pipelineId: "pipe-direct-1",
      flowState: "blocked",
      blockedReason: "max_loop_cycles",
      loopCount: 5,
    });

    const ctx: FixExecutorCompletedCtx = {
      ui: { notify: () => {} },
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
      },
    };

    await handleFixExecutorCompleted({}, config, ctx);

    // Should remain unchanged
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("max_loop_cycles");
    expect(meta.currentStage).toBe("develop");
    expect(meta.loopCount).toBe(5);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("flowState !== 'blocked' → no-op", async () => {
    const { config, tmpDir } = makeFixConfig();
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "fix",
      pipelineId: "pipe-direct-2",
      flowState: "running", // not blocked
      blockedReason: "max_loop_cycles",
      loopCount: 5,
    });

    const ctx: FixExecutorCompletedCtx = {
      ui: { notify: () => {} },
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
      },
    };

    await handleFixExecutorCompleted({}, config, ctx);

    // Should remain unchanged
    expect(meta.flowState).toBe("running");
    expect(meta.currentStage).toBe("fix");
    expect(meta.loopCount).toBe(5);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("blockedReason !== 'max_loop_cycles' → no-op", async () => {
    const { config, tmpDir } = makeFixConfig();
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "fix",
      pipelineId: "pipe-direct-3",
      flowState: "blocked",
      blockedReason: "loop_overflow", // not max_loop_cycles
      loopCount: 10,
    });

    const ctx: FixExecutorCompletedCtx = {
      ui: { notify: () => {} },
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<SessionMeta>) => Object.assign(meta, patch),
      },
    };

    await handleFixExecutorCompleted({}, config, ctx);

    // Should remain unchanged
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("loop_overflow");
    expect(meta.loopCount).toBe(10);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ctx.session missing → no-op", async () => {
    const { config, tmpDir } = makeFixConfig();
    await initAuditLog(config);

    const ctx: FixExecutorCompletedCtx = {
      ui: { notify: () => {} },
      session: undefined,
    };

    // Should not throw
    await handleFixExecutorCompleted({}, config, ctx);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updateMeta throws → fail-open with fix_unfreeze_error audit", async () => {
    const { config, tmpDir } = makeFixConfig();
    await initAuditLog(config);

    const meta = makeTestMeta({
      currentStage: "fix",
      pipelineId: "pipe-direct-5",
      flowState: "blocked",
      blockedReason: "max_loop_cycles",
      loopCount: 5,
    });

    const ctx: FixExecutorCompletedCtx = {
      ui: { notify: () => {} },
      session: {
        getMeta: () => meta,
        updateMeta: (_patch: Partial<SessionMeta>) => {
          throw new Error("Session write failed");
        },
      },
    };

    await handleFixExecutorCompleted({}, config, ctx);

    // State should remain frozen (fail-open)
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("max_loop_cycles");

    // Verify error audit
    const logContent = fs.readFileSync(
      path.join(tmpDir, ".pi", "audit", getDateAuditFileName()),
      "utf-8",
    );
    expect(logContent).toContain("fix_unfreeze_error");
    expect(logContent).toContain("Session write failed");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
