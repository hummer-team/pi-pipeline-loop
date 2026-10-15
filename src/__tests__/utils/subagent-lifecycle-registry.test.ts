/**
 * Unit tests for subagent-lifecycle-registry module.
 * Phase 0 / 200_Bug (G2-1, G2-2): In-memory subagent lifecycle registry.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import {
  registerStarted,
  registerTerminal,
  snapshotForStage,
  findTerminal,
  snapshotAll,
  wireSubagentLifecycleListeners,
  setOwnerMetaAccessor,
  __resetLifecycleRegistry,
} from "../../utils/subagent-lifecycle-registry";

describe("subagent-lifecycle-registry", () => {
  beforeEach(() => {
    __resetLifecycleRegistry();
  });

  describe("registerStarted", () => {
    it("should register a new subagent with active status", () => {
      registerStarted("develop-agent", "agent-123", "develop", "pipe-123");
      
      const all = snapshotAll();
      expect(all).toHaveLength(1);
      expect(all[0].agentId).toBe("agent-123");
      expect(all[0].agentType).toBe("develop-agent");
      expect(all[0].stage).toBe("develop");
      expect(all[0].pipelineId).toBe("pipe-123");
      expect(all[0].status).toBe("active");
      expect(all[0].startedAt).toBeDefined();
      expect(all[0].terminalAt).toBeUndefined();
    });

    it("should overwrite existing entry for same agentId", () => {
      registerStarted("develop-agent", "agent-123", "develop", "pipe-123");
      registerStarted("review-agent", "agent-123", "review", "pipe-456");
      
      const all = snapshotAll();
      expect(all).toHaveLength(1);
      expect(all[0].agentType).toBe("review-agent");
      expect(all[0].stage).toBe("review");
      expect(all[0].pipelineId).toBe("pipe-456");
    });

    it("should handle missing optional parameters", () => {
      registerStarted("develop-agent", "agent-123");
      
      const all = snapshotAll();
      expect(all).toHaveLength(1);
      expect(all[0].stage).toBeUndefined();
      expect(all[0].pipelineId).toBeUndefined();
    });
  });

  describe("registerTerminal", () => {
    it("should mark existing entry as terminal", () => {
      registerStarted("develop-agent", "agent-123", "develop", "pipe-123");
      registerTerminal("develop-agent", "agent-123", "terminal", "completed", "develop", "pipe-123");
      
      const all = snapshotAll();
      expect(all).toHaveLength(1);
      expect(all[0].status).toBe("terminal");
      expect(all[0].reason).toBe("completed");
      expect(all[0].terminalAt).toBeDefined();
    });

    it("should create new entry for orphaned terminal event", () => {
      registerTerminal("develop-agent", "agent-456", "terminal", "failed", "develop", "pipe-789");
      
      const all = snapshotAll();
      expect(all).toHaveLength(1);
      expect(all[0].agentId).toBe("agent-456");
      expect(all[0].status).toBe("terminal");
      expect(all[0].reason).toBe("failed");
      expect(all[0].startedAt).toBeDefined();
      expect(all[0].terminalAt).toBeDefined();
    });

    it("should fill in missing stage/pipelineId from existing entry", () => {
      registerStarted("develop-agent", "agent-123", "develop", "pipe-123");
      registerTerminal("develop-agent", "agent-123", "terminal", "completed");
      
      const all = snapshotAll();
      expect(all[0].stage).toBe("develop");
      expect(all[0].pipelineId).toBe("pipe-123");
    });
  });

  describe("snapshotForStage", () => {
    it("should return all entries for a given pipeline and stage", () => {
      registerStarted("develop-agent", "agent-1", "develop", "pipe-123");
      registerStarted("code-review-agent", "agent-2", "develop", "pipe-123");
      registerStarted("develop-agent", "agent-3", "review", "pipe-123");
      registerStarted("develop-agent", "agent-4", "develop", "pipe-456");
      
      const snapshot = snapshotForStage("pipe-123", "develop");
      expect(snapshot).toHaveLength(2);
      expect(snapshot.map(e => e.agentId).sort()).toEqual(["agent-1", "agent-2"].sort());
    });

    it("should return empty array when no entries match", () => {
      registerStarted("develop-agent", "agent-1", "develop", "pipe-123");
      
      const snapshot = snapshotForStage("pipe-999", "develop");
      expect(snapshot).toHaveLength(0);
    });
  });

  describe("findTerminal", () => {
    it("should return entry if terminal", () => {
      registerStarted("develop-agent", "agent-123", "develop", "pipe-123");
      registerTerminal("develop-agent", "agent-123", "terminal", "completed", "develop", "pipe-123");
      
      const entry = findTerminal("agent-123");
      expect(entry).toBeDefined();
      expect(entry?.status).toBe("terminal");
      expect(entry?.reason).toBe("completed");
    });

    it("should return undefined if not terminal", () => {
      registerStarted("develop-agent", "agent-123", "develop", "pipe-123");
      
      const entry = findTerminal("agent-123");
      expect(entry).toBeUndefined();
    });

    it("should return undefined if not found", () => {
      const entry = findTerminal("agent-999");
      expect(entry).toBeUndefined();
    });
  });

  describe("wireSubagentLifecycleListeners", () => {
    it("should register event listeners on the event bus", () => {
      const handlers: Record<string, Array<(payload: unknown) => void>> = {};
      const mockBus = {
        on: (event: string, handler: (payload: unknown) => void) => {
          if (!handlers[event]) handlers[event] = [];
          handlers[event].push(handler);
          return () => {
            handlers[event] = handlers[event].filter(h => h !== handler);
          };
        },
      };
      const mockPi = { events: mockBus };
      
      const cleanup = wireSubagentLifecycleListeners(mockPi);
      
      expect(handlers["subagents:created"]).toHaveLength(1);
      expect(handlers["subagents:completed"]).toHaveLength(1);
      expect(handlers["subagents:failed"]).toHaveLength(1);
      
      cleanup();
      
      expect(handlers["subagents:created"]).toHaveLength(0);
      expect(handlers["subagents:completed"]).toHaveLength(0);
      expect(handlers["subagents:failed"]).toHaveLength(0);
    });

    it("should register subagent on created event", () => {
      const handlers: Record<string, Array<(payload: unknown) => void>> = {};
      const mockBus = {
        on: (event: string, handler: (payload: unknown) => void) => {
          if (!handlers[event]) handlers[event] = [];
          handlers[event].push(handler);
          return () => {};
        },
      };
      const mockPi = { events: mockBus };
      
      setOwnerMetaAccessor(() => ({
        currentStage: "develop",
        pipelineId: "pipe-123",
      } as any));
      
      wireSubagentLifecycleListeners(mockPi);
      
      // Trigger created event
      handlers["subagents:created"][0]({ id: "agent-123", type: "develop-agent" });
      
      const all = snapshotAll();
      expect(all).toHaveLength(1);
      expect(all[0].agentId).toBe("agent-123");
      expect(all[0].agentType).toBe("develop-agent");
      expect(all[0].stage).toBe("develop");
      expect(all[0].pipelineId).toBe("pipe-123");
    });

    it("should register terminal on completed event", () => {
      const handlers: Record<string, Array<(payload: unknown) => void>> = {};
      const mockBus = {
        on: (event: string, handler: (payload: unknown) => void) => {
          if (!handlers[event]) handlers[event] = [];
          handlers[event].push(handler);
          return () => {};
        },
      };
      const mockPi = { events: mockBus };
      
      setOwnerMetaAccessor(() => ({
        currentStage: "develop",
        pipelineId: "pipe-123",
      } as any));
      
      wireSubagentLifecycleListeners(mockPi);
      
      // Trigger completed event
      handlers["subagents:completed"][0]({ id: "agent-123", type: "develop-agent" });
      
      const entry = findTerminal("agent-123");
      expect(entry).toBeDefined();
      expect(entry?.status).toBe("terminal");
      expect(entry?.reason).toBe("completed");
    });

    it("should register terminal on failed event", () => {
      const handlers: Record<string, Array<(payload: unknown) => void>> = {};
      const mockBus = {
        on: (event: string, handler: (payload: unknown) => void) => {
          if (!handlers[event]) handlers[event] = [];
          handlers[event].push(handler);
          return () => {};
        },
      };
      const mockPi = { events: mockBus };
      
      setOwnerMetaAccessor(() => ({
        currentStage: "develop",
        pipelineId: "pipe-123",
      } as any));
      
      wireSubagentLifecycleListeners(mockPi);
      
      // Trigger failed event
      handlers["subagents:failed"][0]({ id: "agent-123", type: "develop-agent" });
      
      const entry = findTerminal("agent-123");
      expect(entry).toBeDefined();
      expect(entry?.status).toBe("terminal");
      expect(entry?.reason).toBe("failed");
    });

    it("should handle failed event with requestId fallback", () => {
      const handlers: Record<string, Array<(payload: unknown) => void>> = {};
      const mockBus = {
        on: (event: string, handler: (payload: unknown) => void) => {
          if (!handlers[event]) handlers[event] = [];
          handlers[event].push(handler);
          return () => {};
        },
      };
      const mockPi = { events: mockBus };
      
      setOwnerMetaAccessor(() => ({
        currentStage: "develop",
        pipelineId: "pipe-123",
      } as any));
      
      wireSubagentLifecycleListeners(mockPi);
      
      // Trigger failed event with requestId instead of id
      handlers["subagents:failed"][0]({ requestId: "agent-456", type: "develop-agent" });
      
      const entry = findTerminal("agent-456");
      expect(entry).toBeDefined();
      expect(entry?.status).toBe("terminal");
    });

    it("should return no-op cleanup when event bus is unavailable", () => {
      const cleanup = wireSubagentLifecycleListeners({});
      expect(typeof cleanup).toBe("function");
      cleanup(); // Should not throw
    });
  });
});
