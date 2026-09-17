import { describe, it, expect, afterEach } from "bun:test";
import { findLiveAgentByName } from "../../utils/subagents-introspect";

/**
 * Phase 0 (182): findLiveAgentByName tests.
 *
 * Verifies the name-based agent lookup from the manager registry.
 * Uses globalThis symbol injection to simulate the pi-subagents manager.
 */

const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

function installMockManager(records: Array<{ id?: string; name?: string; status?: string }>): void {
  (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
    listRecords: () => records,
    getRecord: (id: string) => records.find(r => r.id === id),
  };
}

function clearMockManager(): void {
  delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
}

afterEach(() => {
  clearMockManager();
});

describe("findLiveAgentByName (Phase 0 / 182)", () => {
  it("returns null when listRecords is not available", () => {
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: () => undefined,
      // No listRecords
    };
    expect(findLiveAgentByName("test-agent")).toBeNull();
  });

  it("returns null when manager is unavailable", () => {
    clearMockManager();
    expect(findLiveAgentByName("test-agent")).toBeNull();
  });

  it("returns first live matching record", () => {
    installMockManager([
      { id: "agent-1", name: "review-agent", status: "running" },
      { id: "agent-2", name: "develop-agent", status: "queued" },
      { id: "agent-3", name: "review-agent", status: "settled" },
    ]);
    const result = findLiveAgentByName("review-agent");
    expect(result).toEqual({ agentId: "agent-1" });
  });

  it("returns null when all matching records are settled", () => {
    installMockManager([
      { id: "agent-1", name: "review-agent", status: "settled" },
      { id: "agent-2", name: "review-agent", status: "completed" },
    ]);
    expect(findLiveAgentByName("review-agent")).toBeNull();
  });

  it("returns null when no name match", () => {
    installMockManager([
      { id: "agent-1", name: "develop-agent", status: "running" },
    ]);
    expect(findLiveAgentByName("review-agent")).toBeNull();
  });

  it("returns null on exception (fail-open)", () => {
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      listRecords: () => { throw new Error("registry error"); },
    };
    expect(findLiveAgentByName("test-agent")).toBeNull();
  });
});
