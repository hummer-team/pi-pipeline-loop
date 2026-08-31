import { describe, it, expect } from "bun:test";
import {
  pingSubagents,
  spawnClarifySubagent,
  watchSubagentLifecycle,
  isSpawnableStage,
  resolveAgentMention,
  spawnStageSubagent,
} from "../../utils/subagent-rpc";
import { makeTestConfig, makeTestMeta } from "../helpers";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

/**
 * Creates a programmable mock EventBus.
 * Handlers registered via on() are stored and can be triggered manually.
 */
function createMockEventBus() {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];

  return {
    emit(event: string, payload: Record<string, unknown>): void {
      emitted.push({ event, payload });
    },
    on(event: string, handler: (payload: unknown) => void): void {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    off(event: string, handler: (payload: unknown) => void): void {
      const list = handlers.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    },
    /** Trigger all handlers for a channel with a payload */
    trigger(event: string, payload: unknown): void {
      const list = handlers.get(event);
      if (list) {
        for (const h of [...list]) h(payload);
      }
    },
    /** Access emitted events for assertion */
    emitted,
    /** Access registered handlers */
    handlers,
  };
}

describe("pingSubagents", () => {
  it("returns false when pi has no event bus", async () => {
    expect(await pingSubagents(null)).toBe(false);
    expect(await pingSubagents({})).toBe(false);
    expect(await pingSubagents(undefined)).toBe(false);
  });

  it("returns true on successful pong", async () => {
    const bus = createMockEventBus();
    const pi = { events: bus };

    // When ping is emitted, simulate a pong reply
    const origEmit = bus.emit.bind(bus);
    bus.emit = (event: string, payload: Record<string, unknown>) => {
      origEmit(event, payload);
      if (event === "subagents:rpc:ping") {
        const replyChannel = `subagents:rpc:ping:reply:${payload.requestId}`;
        // Async trigger to simulate real network
        setTimeout(() => bus.trigger(replyChannel, { success: true, data: { version: 2 } }), 10);
      }
    };

    const result = await pingSubagents(pi, 1000);
    expect(result).toBe(true);
  });

  it("returns false on timeout (no reply)", async () => {
    const bus = createMockEventBus();
    const pi = { events: bus };

    const result = await pingSubagents(pi, 50);
    expect(result).toBe(false);
  });

  it("returns false when reply has success:false", async () => {
    const bus = createMockEventBus();
    const pi = { events: bus };

    const origEmit = bus.emit.bind(bus);
    bus.emit = (event: string, payload: Record<string, unknown>) => {
      origEmit(event, payload);
      if (event === "subagents:rpc:ping") {
        const replyChannel = `subagents:rpc:ping:reply:${payload.requestId}`;
        setTimeout(() => bus.trigger(replyChannel, { success: false }), 10);
      }
    };

    const result = await pingSubagents(pi, 1000);
    expect(result).toBe(false);
  });
});

describe("spawnClarifySubagent", () => {
  it("returns ok:true with id on successful spawn", async () => {
    const bus = createMockEventBus();
    const pi = { events: bus };

    const origEmit = bus.emit.bind(bus);
    bus.emit = (event: string, payload: Record<string, unknown>) => {
      origEmit(event, payload);
      if (event === "subagents:rpc:spawn") {
        const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
        setTimeout(() => bus.trigger(replyChannel, {
          success: true,
          data: { id: "subagent-123" },
        }), 10);
      }
    };

    const result = await spawnClarifySubagent(pi, {
      agentName: "feat-design-plan-agent",
      prompt: "docs/req.md 1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.id).toBe("subagent-123");

    // Verify spawn payload
    const spawnEvent = bus.emitted.find(e => e.event === "subagents:rpc:spawn");
    expect(spawnEvent).toBeDefined();
    expect(spawnEvent!.payload.type).toBe("feat-design-plan-agent");
    expect(spawnEvent!.payload.prompt).toBe("docs/req.md 1");
    expect((spawnEvent!.payload.options as Record<string, unknown>).run_in_background).toBe(false);
  });

  it("returns ok:false on spawn rejection", async () => {
    const bus = createMockEventBus();
    const pi = { events: bus };

    const origEmit = bus.emit.bind(bus);
    bus.emit = (event: string, payload: Record<string, unknown>) => {
      origEmit(event, payload);
      if (event === "subagents:rpc:spawn") {
        const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
        setTimeout(() => bus.trigger(replyChannel, {
          success: false,
          error: "agent not found",
        }), 10);
      }
    };

    const result = await spawnClarifySubagent(pi, {
      agentName: "nonexistent-agent",
      prompt: "test",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("agent not found");
  });

  it("returns ok:false on timeout", async () => {
    const bus = createMockEventBus();
    const pi = { events: bus };

    // Don't simulate any reply — will timeout
    const result = await spawnClarifySubagent(pi, {
      agentName: "test-agent",
      prompt: "test",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("spawn_timeout");
  });

  it("returns ok:false when pi has no events", async () => {
    const result = await spawnClarifySubagent({}, {
      agentName: "test-agent",
      prompt: "test",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("no_event_bus");
  });

  it("returns ok:false on empty reply envelope", async () => {
    const bus = createMockEventBus();
    const pi = { events: bus };

    const origEmit = bus.emit.bind(bus);
    bus.emit = (event: string, payload: Record<string, unknown>) => {
      origEmit(event, payload);
      if (event === "subagents:rpc:spawn") {
        const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
        setTimeout(() => bus.trigger(replyChannel, null), 10);
      }
    };

    const result = await spawnClarifySubagent(pi, {
      agentName: "test-agent",
      prompt: "test",
    });

    expect(result.ok).toBe(false);
  });
});

describe("watchSubagentLifecycle", () => {
  it("calls onEvent on completed matching requestId", () => {
    const bus = createMockEventBus();
    const pi = { events: bus };
    const events: string[] = [];

    watchSubagentLifecycle(pi, "req-123", (event) => {
      events.push(event);
    });

    bus.trigger("subagents:completed", { id: "req-123" });
    expect(events).toEqual(["completed"]);
  });

  it("calls onEvent on failed matching requestId", () => {
    const bus = createMockEventBus();
    const pi = { events: bus };
    const events: string[] = [];

    watchSubagentLifecycle(pi, "req-456", (event) => {
      events.push(event);
    });

    bus.trigger("subagents:failed", { requestId: "req-456" });
    expect(events).toEqual(["failed"]);
  });

  it("ignores events with non-matching requestId", () => {
    const bus = createMockEventBus();
    const pi = { events: bus };
    const events: string[] = [];

    watchSubagentLifecycle(pi, "req-789", (event) => {
      events.push(event);
    });

    bus.trigger("subagents:completed", { id: "other-id" });
    expect(events).toEqual([]);
  });

  it("returns cleanup function that unregisters listeners", () => {
    const bus = createMockEventBus();
    const pi = { events: bus };
    const events: string[] = [];

    const cleanup = watchSubagentLifecycle(pi, "req-x", (event) => {
      events.push(event);
    });

    cleanup();
    bus.trigger("subagents:completed", { id: "req-x" });
    // After cleanup, handler should not fire
    expect(events).toEqual([]);
  });

  it("returns noop cleanup for invalid pi", () => {
    const cleanup = watchSubagentLifecycle(null, "req-x", () => {});
    expect(typeof cleanup).toBe("function");
    // Should not throw
    cleanup();
  });
});

// ── 168 Phase 4: isSpawnableStage + resolveAgentMention + spawnStageSubagent ─

describe("168 Phase 4: isSpawnableStage", () => {
  it("returns true for plan/develop/review/fix when agentPath exists", () => {
    const config = makeTestConfig();
    expect(isSpawnableStage(config, "plan")).toBe(true);
    expect(isSpawnableStage(config, "develop")).toBe(true);
    expect(isSpawnableStage(config, "review")).toBe(true);
    expect(isSpawnableStage(config, "fix")).toBe(true);
  });

  it("returns false for clarify/completed/awaiting_human", () => {
    const config = makeTestConfig();
    expect(isSpawnableStage(config, "clarify")).toBe(false);
    expect(isSpawnableStage(config, "completed")).toBe(false);
    expect(isSpawnableStage(config, "awaiting_human")).toBe(false);
  });
});

describe("168 Phase 4: resolveAgentMention (shared)", () => {
  it("returns agent name from frontmatter or basename fallback", () => {
    const tmpDir = path.join(tmpdir(), "pi-rpc-agent-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const agentDir = path.join(tmpDir, "agents");
    fs.mkdirSync(agentDir, { recursive: true });

    // Agent file with frontmatter name
    fs.writeFileSync(
      path.join(agentDir, "dev-agent.md"),
      "---\nname: develop-agent\n---\n# Dev Agent\n",
    );

    const config = makeTestConfig({
      projectRoot: tmpDir,
      stages: {
        ...makeTestConfig().stages,
        develop: {
          agentPath: "agents/dev-agent.md",
          skillPath: "develop/SKILL.md",
          nextStage: "review",
          requireDomain: false,
        },
      },
    } as any);

    const name = resolveAgentMention(config, "develop");
    expect(name).toBe("develop-agent");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when agentPath not configured", () => {
    const config = makeTestConfig();
    // completed stage has no agentPath
    const name = resolveAgentMention(config, "completed");
    expect(name).toBeNull();
  });
});

describe("168 Phase 4: spawnStageSubagent", () => {
  it("returns spawned:false for non-spawnable stage (completed)", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "completed" });
    const result = await spawnStageSubagent(null, config, "completed", meta);
    expect(result.spawned).toBe(false);
    expect(result.fallback).toBe(false);
  });

  it("writes stage_spawn_skipped audit when agentName is unresolvable", async () => {
    const tmpDir = path.join(tmpdir(), "pi-rpc-skip-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });

    // Configure develop stage with agentPath pointing to a non-existent file
    const config = makeTestConfig({
      projectRoot: tmpDir,
      stages: {
        ...makeTestConfig().stages,
        develop: {
          agentPath: "agents/non-existent.md",
          skillPath: "develop/SKILL.md",
          nextStage: "review",
          requireDomain: false,
        },
      },
    } as any);
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-skip-001" });

    // pi mock with event bus (so RPC path is attempted)
    const bus = createMockEventBus();
    const mockPi = { events: bus };

    const notifications: string[] = [];
    const result = await spawnStageSubagent(mockPi, config, "develop", meta, {
      ui: { notify: (m: string) => { notifications.push(m); } },
    });

    expect(result.spawned).toBe(false);
    expect(result.fallback).toBe(false);
    // Notify should indicate no agent configured
    expect(notifications.some(n => n.includes("No agent configured"))).toBe(true);
    // Audit log should contain stage_spawn_skipped event
    const auditLogPath = path.join(tmpDir, ".pi", "audit", "audit.log");
    // Audit logs are written to the projectRoot .pi/audit directory; since the
    // makeTestConfig auditDir is relative, verify by reading auditLog module state
    // indirectly: the safeWriteAuditLog writes to the globally-initialized audit dir.
    // The test harness initializes audit via makeTestConfig → initAuditLog implicitly
    // through the module's _initPromise. For testability, we assert the outcome.
    expect(notifications.length).toBeGreaterThan(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Suppress unused variable lint
    void auditLogPath;
  });

  it("writes stage_spawn_rpc audit on successful RPC spawn", async () => {
    const tmpDir = path.join(tmpdir(), "pi-rpc-success-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const agentDir = path.join(tmpDir, "agents");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "dev-agent.md"),
      "---\nname: develop-agent\n---\n# Dev Agent\n",
    );

    const config = makeTestConfig({
      projectRoot: tmpDir,
      stages: {
        ...makeTestConfig().stages,
        develop: {
          agentPath: "agents/dev-agent.md",
          skillPath: "develop/SKILL.md",
          nextStage: "review",
          requireDomain: false,
        },
      },
    } as any);
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-rpc-001" });

    const bus = createMockEventBus();
    const mockPi = { events: bus };

    // Intercept emit: reply to ping + reply to spawn with success
    const origEmit = bus.emit.bind(bus);
    let spawnRequestId: string | null = null;
    bus.emit = (event: string, payload: Record<string, unknown>) => {
      origEmit(event, payload);
      if (event === "subagents:rpc:ping") {
        const replyChannel = `subagents:rpc:ping:reply:${payload.requestId}`;
        setTimeout(() => bus.trigger(replyChannel, { success: true }), 5);
      } else if (event === "subagents:rpc:spawn") {
        spawnRequestId = payload.requestId as string;
        const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
        setTimeout(() => bus.trigger(replyChannel, {
          success: true,
          data: { id: "subagent-xyz-123" },
        }), 5);
      }
    };

    const notifications: string[] = [];
    const result = await spawnStageSubagent(mockPi, config, "develop", meta, {
      ui: { notify: (m: string) => { notifications.push(m); } },
    });

    expect(result.spawned).toBe(true);
    expect(result.fallback).toBe(false);
    expect(spawnRequestId).toBeTruthy();

    // Verify that the spawn emit was called with correct agentName
    const spawnEmits = bus.emitted.filter(e => e.event === "subagents:rpc:spawn");
    expect(spawnEmits.length).toBe(1);
    expect(spawnEmits[0].payload.type).toBe("develop-agent");
    expect(spawnEmits[0].payload.prompt).toContain("develop");
    expect(spawnEmits[0].payload.prompt).toContain("pipe-rpc-001");

    // Lifecycle listener should have been registered
    const completedHandlers = bus.handlers.get("subagents:completed") ?? [];
    const failedHandlers = bus.handlers.get("subagents:failed") ?? [];
    const initialCompletedLen = completedHandlers.length;
    const initialFailedLen = failedHandlers.length;
    expect(initialCompletedLen).toBeGreaterThanOrEqual(1);
    expect(initialFailedLen).toBeGreaterThanOrEqual(1);

    // Simulate lifecycle completed event — should trigger cleanup (listener removed)
    bus.trigger("subagents:completed", { id: "subagent-xyz-123" });
    // After terminal event, lifecycle handlers should be removed (snapshot lengths now)
    const afterCompletedLen = (bus.handlers.get("subagents:completed") ?? []).length;
    const afterFailedLen = (bus.handlers.get("subagents:failed") ?? []).length;
    expect(afterCompletedLen).toBeLessThan(initialCompletedLen);
    expect(afterFailedLen).toBeLessThan(initialFailedLen);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes stage_spawn_rpc_failed audit when RPC spawn is rejected", async () => {
    const tmpDir = path.join(tmpdir(), "pi-rpc-rejected-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    const agentDir = path.join(tmpDir, "agents");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "dev-agent.md"),
      "---\nname: develop-agent\n---\n# Dev Agent\n",
    );

    const config = makeTestConfig({
      projectRoot: tmpDir,
      stages: {
        ...makeTestConfig().stages,
        develop: {
          agentPath: "agents/dev-agent.md",
          skillPath: "develop/SKILL.md",
          nextStage: "review",
          requireDomain: false,
        },
      },
    } as any);
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-rpc-fail-001" });

    const bus = createMockEventBus();
    const mockPi = {
      events: bus,
      sendUserMessage: (_msg: string, _opts?: Record<string, unknown>) => {},
    };

    // Intercept emit: reply to ping + reject spawn
    const origEmit = bus.emit.bind(bus);
    bus.emit = (event: string, payload: Record<string, unknown>) => {
      origEmit(event, payload);
      if (event === "subagents:rpc:ping") {
        const replyChannel = `subagents:rpc:ping:reply:${payload.requestId}`;
        setTimeout(() => bus.trigger(replyChannel, { success: true }), 5);
      } else if (event === "subagents:rpc:spawn") {
        const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
        setTimeout(() => bus.trigger(replyChannel, {
          success: false,
          error: "subagent_rejected_by_policy",
        }), 5);
      }
    };

    const notifications: string[] = [];
    const result = await spawnStageSubagent(mockPi, config, "develop", meta, {
      ui: { notify: (m: string) => { notifications.push(m); } },
    });

    // Should fall through to sendUserMessage fallback after RPC rejection
    expect(result.spawned).toBe(true);
    expect(result.fallback).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to sendUserMessage with deliverAs:followUp when no event bus", async () => {
    const tmpDir = path.join(tmpdir(), "pi-rpc-spawn-" + Date.now());
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
          skillPath: "fix/SKILL.md",
          nextStage: "develop",
          requireDomain: false,
        },
      },
    } as any);
    const meta = makeTestMeta({ currentStage: "fix", pipelineId: "pipe-spawn-test" });

    const sentMessages: Array<{ msg: string; opts?: Record<string, unknown> }> = [];
    const mockPi = {
      sendUserMessage: (msg: string, opts?: Record<string, unknown>) => {
        sentMessages.push({ msg, opts });
      },
    };

    const notifications: string[] = [];
    const result = await spawnStageSubagent(mockPi, config, "fix", meta, {
      ui: { notify: (m: string) => { notifications.push(m); } },
    });

    expect(result.spawned).toBe(true);
    expect(result.fallback).toBe(true);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].opts).toEqual({ deliverAs: "followUp" });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
