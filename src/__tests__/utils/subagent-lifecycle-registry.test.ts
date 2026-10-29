/**
 * Unit tests for subagent-lifecycle-registry module.
 * Phase 0 / 200_Bug (G2-1, G2-2): In-memory subagent lifecycle registry.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { setSpawnLedgerConfig, __resetSpawnLedger } from "../../utils/spawn-ledger";
import { makeTestConfig, makeStageConfig } from "../helpers";
import type { PipelineConfig } from "../../types";

const LEDGER_TMP = join(tmpdir(), "pi-lifecycle-ledger-" + Date.now());

/**
 * Ledger config whose `develop` stage resolves to `develop-agent` (218 review
 * #1: stage attribution now comes ONLY from the executor name — the listeners
 * need `stageOfExecutorName` to be backed by a real config + agent file).
 */
function makeLedgerConfig(): PipelineConfig {
  mkdirSync(join(LEDGER_TMP, "agents"), { recursive: true });
  writeFileSync(join(LEDGER_TMP, "agents", "dev.md"), "---\nname: develop-agent\n---\n# D\n");
  return makeTestConfig({
    projectRoot: LEDGER_TMP,
    stages: {
      ...makeTestConfig().stages,
      develop: makeStageConfig({ agentPath: "agents/dev.md", nextStage: "review" }),
    },
  } as never);
}

describe("subagent-lifecycle-registry", () => {
  beforeEach(() => {
    __resetLifecycleRegistry();
    __resetSpawnLedger();
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
    it("never backfills stage onto a stage-less dispatch snapshot (218 review #1)", () => {
      // Non-executor dispatch snapshot (stage undefined by design) + terminal
      // carrying the owner's CURRENT stage: backfill would fabricate exactly
      // the snapshot wake predicate 2 trusts.
      registerStarted("explore", "helper-9", undefined, "pipe-1");
      registerTerminal("explore", "helper-9", "terminal", "completed", "develop", "pipe-1");

      const entry = findTerminal("helper-9");
      expect(entry).toBeDefined();
      expect(entry?.status).toBe("terminal");
      expect(entry?.stage).toBeUndefined();
      expect(entry?.pipelineId).toBe("pipe-1");
    });

    it("still backfills stage for late-arriving terminal-stamped entries", () => {
      // Orphan terminal (never registered at dispatch): stage rides along —
      // unchanged behavior for entries without a dispatch snapshot.
      registerTerminal("develop-agent", "orphan-1", "terminal", "completed", "develop", "pipe-1");
      const entry = findTerminal("orphan-1");
      expect(entry?.stage).toBe("develop");
    });

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
      setSpawnLedgerConfig(makeLedgerConfig());
      
      wireSubagentLifecycleListeners(mockPi);
      
      // Trigger created event
      handlers["subagents:created"][0]({ id: "agent-123", type: "develop-agent" });
      
      const all = snapshotAll();
      expect(all).toHaveLength(1);
      expect(all[0].agentId).toBe("agent-123");
      expect(all[0].agentType).toBe("develop-agent");
      // 218 review #1: resolved from the EXECUTOR NAME (config), not from the
      // removed `meta.currentStage` fallback.
      expect(all[0].stage).toBe("develop");
      expect(all[0].pipelineId).toBe("pipe-123");
    });

    it("non-executor created event stays stage-less even with an owner stage (218 review #1)", () => {
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
      setSpawnLedgerConfig(makeLedgerConfig());

      wireSubagentLifecycleListeners(mockPi);

      // `explore` is not a configured stage executor: the dispatch snapshot
      // must NOT inherit the owner's currentStage (wake predicate 2 keeps
      // skipping such entries instead of firing false owner_wake_on_terminal).
      handlers["subagents:created"][0]({ id: "helper-1", type: "explore" });

      const all = snapshotAll();
      expect(all).toHaveLength(1);
      expect(all[0].agentId).toBe("helper-1");
      expect(all[0].stage).toBeUndefined();
      expect(all[0].stageAt).toBe("dispatch");
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
