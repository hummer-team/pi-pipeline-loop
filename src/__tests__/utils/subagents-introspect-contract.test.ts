import { describe, it, expect, afterEach } from "bun:test";
import * as introspectModule from "../../utils/subagents-introspect";
import { probeAgentState, anyTopLevelRunning } from "../../utils/subagents-introspect";

/**
 * 218 P0 (T0.2): contract tests for `subagents-introspect`.
 *
 * The pi-subagents manager reachable from the plugin exposes ONLY
 * `getRecord(id)` and `hasRunning()` in 0.22.0 (docs/rpc.md §The manager
 * registry). `listRecords`/`listAgents` do NOT exist — the old fake contract
 * made every name-probe constant-null (incident 20261028 / R1). These tests
 * pin the REAL shape, the fail-open behavior, and the removal of
 * `findLiveAgentByName` so the fake contract can never flow back in.
 */

const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

function clearMockManager(): void {
  delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
}

/** Registry in the REAL 0.22.0 shape — no listRecords, no listAgents. */
function installRealisticManager(records: Map<string, { status?: string }>): void {
  (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
    getRecord: (id: string) => records.get(id),
    hasRunning: () => Array.from(records.values()).some(
      (r) => r.status === "queued" || r.status === "running" || r.status === "steered",
    ),
  };
}

afterEach(() => {
  clearMockManager();
});

describe("probeAgentState — real 0.22.0 contract shape (218 T0.2)", () => {
  it("tri-state over the real registry: live / settled / unknown", () => {
    const records = new Map<string, { status?: string }>([
      ["live-1", { status: "running" }],
      ["queued-1", { status: "queued" }],
      ["done-1", { status: "completed" }],
    ]);
    installRealisticManager(records);
    expect(probeAgentState("live-1")).toBe("live");
    expect(probeAgentState("queued-1")).toBe("live");
    expect(probeAgentState("done-1")).toBe("settled");
    // Unknown id → registry says no record → settled (evicted), NOT unknown
    expect(probeAgentState("absent-1")).toBe("settled");
  });

  it("missing registry → unknown (fail-open)", () => {
    clearMockManager();
    expect(probeAgentState("any-id")).toBe("unknown");
  });

  it("getRecord throwing → unknown (fail-open)", () => {
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: () => {
        throw new Error("registry drift");
      },
      hasRunning: () => {
        throw new Error("registry drift");
      },
    };
    expect(probeAgentState("any-id")).toBe("unknown");
    expect(anyTopLevelRunning()).toBe(null);
  });

  it("registry without getRecord (API drift) → unknown", () => {
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = { hasRunning: () => true };
    expect(probeAgentState("any-id")).toBe("unknown");
    expect(anyTopLevelRunning()).toBe(true);
  });
});

describe("findLiveAgentByName is GONE (218 Q19-B anti-regression)", () => {
  it("the module must NOT export findLiveAgentByName", () => {
    expect("findLiveAgentByName" in introspectModule).toBe(false);
  });

  it("the module keeps only the real-contract probes", () => {
    // Sanity: the surviving public surface is exactly the reachable API.
    expect(typeof introspectModule.probeAgentState).toBe("function");
    expect(typeof introspectModule.anyTopLevelRunning).toBe("function");
    expect(typeof introspectModule.probeAgentSessionEvidence).toBe("function");
    expect(typeof introspectModule.toExecutorTerminalStatus).toBe("function");
  });
});

describe("probeAgentSessionEvidence — no enumeration needed (218 T0.2)", () => {
  it("found/status reported from getRecord alone; ambiguous is always false", () => {
    const records = new Map<string, { status?: string; sessionFile?: string }>([
      ["a1", { status: "running", sessionFile: "/tmp/s.jsonl" }],
    ]);
    installRealisticManager(records as Map<string, { status?: string }>);
    const ev = introspectModule.probeAgentSessionEvidence("a1");
    expect(ev.found).toBe(true);
    expect(ev.status).toBe("live");
    expect(ev.ambiguous).toBe(false);
    expect(ev.sessionFile).toBe("/tmp/s.jsonl");
    // Ids without a record: absent evidence, never a trusted terminal.
    const missing = introspectModule.probeAgentSessionEvidence("nope");
    expect(missing.found).toBe(false);
    expect(missing.status).toBe("unknown");
    expect(missing.ambiguous).toBe(false);
  });
});
