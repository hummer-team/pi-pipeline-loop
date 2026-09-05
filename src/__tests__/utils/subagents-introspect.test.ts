import { describe, it, expect, afterEach } from "bun:test";
import { probeAgentState, anyTopLevelRunning } from "../../utils/subagents-introspect";

const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

describe("subagents-introspect", () => {
  afterEach(() => {
    // Clean up any manager singleton set during tests
    delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
  });

  describe("probeAgentState", () => {
    it("returns 'unknown' when manager singleton is absent", () => {
      expect(probeAgentState("some-id")).toBe("unknown");
    });

    it("returns 'unknown' when manager has no getRecord method", () => {
      (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {};
      expect(probeAgentState("some-id")).toBe("unknown");
    });

    it("returns 'settled' when getRecord returns undefined (no record)", () => {
      (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
        getRecord: () => undefined,
      };
      expect(probeAgentState("some-id")).toBe("settled");
    });

    it("returns 'live' when record status is 'running'", () => {
      (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
        getRecord: () => ({ status: "running" }),
      };
      expect(probeAgentState("agent-1")).toBe("live");
    });

    it("returns 'live' when record status is 'queued'", () => {
      (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
        getRecord: () => ({ status: "queued" }),
      };
      expect(probeAgentState("agent-1")).toBe("live");
    });

    it("returns 'live' when record status is 'steered'", () => {
      (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
        getRecord: () => ({ status: "steered" }),
      };
      expect(probeAgentState("agent-1")).toBe("live");
    });

    it("returns 'settled' when record status is 'completed'", () => {
      (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
        getRecord: () => ({ status: "completed" }),
      };
      expect(probeAgentState("agent-1")).toBe("settled");
    });

    it("returns 'settled' when record status is 'aborted'", () => {
      (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
        getRecord: () => ({ status: "aborted" }),
      };
      expect(probeAgentState("agent-1")).toBe("settled");
    });

    it("returns 'unknown' when getRecord throws (fail-safe)", () => {
      (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
        getRecord: () => { throw new Error("API drift"); },
      };
      expect(probeAgentState("agent-1")).toBe("unknown");
    });
  });

  describe("anyTopLevelRunning", () => {
    it("returns null when manager singleton is absent", () => {
      expect(anyTopLevelRunning()).toBeNull();
    });

    it("returns null when hasRunning is not a function", () => {
      (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {};
      expect(anyTopLevelRunning()).toBeNull();
    });

    it("returns true when hasRunning() returns true", () => {
      (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
        hasRunning: () => true,
      };
      expect(anyTopLevelRunning()).toBe(true);
    });

    it("returns false when hasRunning() returns false", () => {
      (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
        hasRunning: () => false,
      };
      expect(anyTopLevelRunning()).toBe(false);
    });

    it("returns null when hasRunning throws (fail-safe)", () => {
      (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
        hasRunning: () => { throw new Error("drift"); },
      };
      expect(anyTopLevelRunning()).toBeNull();
    });
  });
});
