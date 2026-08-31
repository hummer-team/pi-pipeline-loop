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
  it("returns true for develop/review/fix when agentPath exists", () => {
    const config = makeTestConfig();
    expect(isSpawnableStage(config, "develop")).toBe(true);
    expect(isSpawnableStage(config, "review")).toBe(true);
    expect(isSpawnableStage(config, "fix")).toBe(true);
  });

  it("returns false for clarify/plan/completed/awaiting_human", () => {
    const config = makeTestConfig();
    expect(isSpawnableStage(config, "clarify")).toBe(false);
    expect(isSpawnableStage(config, "plan")).toBe(false);
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
