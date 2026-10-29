/**
 * 218 Phase 4 (T4.2): ManagerRegistry fidelity contract.
 *
 * Incident 20261028 (R1/R2): the pre-218 unit tests installed a FAKE
 * registry exposing `listRecords` — an enumeration member the REAL
 * pi-subagents 0.22.0 registry never published (`dist/index.js:681-692`
 * holds exactly `waitForAll / hasRunning / spawn / getRecord`). Every
 * name-probe therefore ran constant-null in production while the suite
 * stayed green. This file pins the anti-fake contract on three levels:
 *
 *  1. shape: `makeRealisticManagerRegistry()` has EXACTLY the four real
 *     members and NO enumeration surface (`listRecords`/`listAgents`
 *     absent — own and inherited);
 *  2. behavior: every plugin probe runs under that shape — never throws,
 *     returns bounded live/settled/unknown results, and the read-only
 *     introspection never touches `spawn`/`waitForAll`;
 *  3. static sweep: no test source installs a registry literal that
 *     references `listRecords`/`listAgents` in CODE (TSDoc comments naming
 *     the removed members are explicitly allowed — they are the lesson).
 *
 * The double lives in `src/__tests__/helpers.ts` and replaces the scattered
 * hand-rolled fake managers across the suite.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  probeAgentState,
  anyTopLevelRunning,
  probeAgentSessionEvidence,
  toExecutorTerminalStatus,
} from "../../utils/subagents-introspect";
import { makeRealisticManagerRegistry } from "../helpers";

const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

type Registry = ReturnType<typeof makeRealisticManagerRegistry>;

function install(registry: Registry): void {
  (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = registry;
}

function uninstall(): void {
  delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
}

afterEach(() => {
  uninstall();
});

describe("218 T4.2: the double pins the real 0.22.0 registry surface", () => {
  it("exposes EXACTLY waitForAll/hasRunning/spawn/getRecord as functions", () => {
    const registry = makeRealisticManagerRegistry({ "a-1": "running" });
    expect(Object.keys(registry).sort()).toEqual([
      "getRecord",
      "hasRunning",
      "spawn",
      "waitForAll",
    ]);
    for (const key of ["getRecord", "hasRunning", "spawn", "waitForAll"] as const) {
      expect(typeof registry[key]).toBe("function");
    }
  });

  it("has NO enumeration surface — listRecords/listAgents are absent", () => {
    const registry = makeRealisticManagerRegistry();
    // The exact fake-contract leak that hid R1/R2: `in` covers own AND
    // inherited members, so a prototype smuggle fails too.
    expect("listRecords" in registry).toBe(false);
    expect("listAgents" in registry).toBe(false);
    expect("consumeResult" in registry).toBe(false);
    expect("abort" in registry).toBe(false);
  });

  it("spawn fails loudly — the plugin dispatches via the event bus, never the manager", async () => {
    const registry = makeRealisticManagerRegistry();
    await expect(registry.spawn({ type: "x" })).rejects.toThrow(/event bus/);
  });

  it("waitForAll resolves immediately (the double starts settled)", async () => {
    const registry = makeRealisticManagerRegistry({ "a-1": "running" });
    await expect(registry.waitForAll()).resolves.toBeUndefined();
  });
});

describe("218 T4.2: every probe works under the real shape", () => {
  it("probeAgentState returns the bounded tri-state without throwing", () => {
    install(
      makeRealisticManagerRegistry({
        "ag-running": "running",
        "ag-queued": "queued",
        "ag-steered": "steered",
        "ag-done": { status: "completed", sessionFile: "/tmp/ag-done.jsonl" },
        "ag-nostatus": {},
      }),
    );

    expect(probeAgentState("ag-running")).toBe("live");
    expect(probeAgentState("ag-queued")).toBe("live");
    expect(probeAgentState("ag-steered")).toBe("live");
    expect(probeAgentState("ag-done")).toBe("settled");
    // Record exists but carries no status → never invent liveness.
    expect(probeAgentState("ag-nostatus")).toBe("settled");
    // Unknown id = evicted/never-registered → settled, NOT unknown.
    expect(probeAgentState("ag-absent")).toBe("settled");
  });

  it("anyTopLevelRunning reflects hasRunning under the real shape", () => {
    install(makeRealisticManagerRegistry({ "ag-live": "running" }));
    expect(anyTopLevelRunning()).toBe(true);

    install(makeRealisticManagerRegistry({ "ag-done": "completed" }));
    expect(anyTopLevelRunning()).toBe(false);
  });

  it("hasRunning override models the top-level-only real semantics", () => {
    // Legitimate drift the real registry can show: the probed ledger id is
    // settled while an UNRELATED agent is active (or vice versa) — the
    // double keeps `getRecord` per-id while `hasRunning` is forced.
    install(
      makeRealisticManagerRegistry(
        { "ag-done": "completed" },
        { hasRunning: true },
      ),
    );
    expect(anyTopLevelRunning()).toBe(true);
    expect(probeAgentState("ag-done")).toBe("settled");
  });

  it("a Map input keeps live mutations visible, like the real mutable store", () => {
    const store = new Map<string, { status: string }>();
    install(makeRealisticManagerRegistry(store));
    expect(probeAgentState("ag-x")).toBe("settled");
    store.set("ag-x", { status: "running" });
    expect(probeAgentState("ag-x")).toBe("live");
    expect(anyTopLevelRunning()).toBe(true);
  });

  it("probeAgentSessionEvidence maps records exactly and never enumerates", () => {
    install(
      makeRealisticManagerRegistry({
        "ag-live": { status: "running", sessionFile: "/tmp/ag-live.jsonl" },
        "ag-done": { status: "completed" },
        "ag-nostatus": {},
      }),
    );

    const live = probeAgentSessionEvidence("ag-live");
    expect(live.found).toBe(true);
    expect(live.status).toBe("live");
    expect(live.recordStatus).toBe("running");
    expect(live.sessionFile).toBe("/tmp/ag-live.jsonl");
    expect(live.ambiguous).toBe(false);

    expect(probeAgentSessionEvidence("ag-done").status).toBe("settled");
    // No status on the record → found but unknown status (never invented).
    const bare = probeAgentSessionEvidence("ag-nostatus");
    expect(bare.found).toBe(true);
    expect(bare.status).toBe("unknown");
    expect(bare.recordStatus).toBeUndefined();

    const absent = probeAgentSessionEvidence("ag-absent");
    expect(absent.found).toBe(false);
    expect(absent.status).toBe("unknown");
  });

  it("toExecutorTerminalStatus maps real registry statuses", () => {
    const registry = makeRealisticManagerRegistry({ "ag-live": "running" });
    expect(toExecutorTerminalStatus(registry.getRecord("ag-live")?.status)).toBe("running");
    expect(toExecutorTerminalStatus(undefined)).toBe("unknown");
  });

  it("read-only introspection NEVER touches spawn/waitForAll", () => {
    const registry = makeRealisticManagerRegistry({ "ag-live": "running" });
    let spawnCalls = 0;
    let waitForAllCalls = 0;
    registry.spawn = () => {
      spawnCalls++;
      return Promise.reject(new Error("unreachable")) as Promise<never>;
    };
    registry.waitForAll = async () => {
      waitForAllCalls++;
    };
    install(registry);

    probeAgentState("ag-live");
    probeAgentState("ag-absent");
    anyTopLevelRunning();
    probeAgentSessionEvidence("ag-live");
    expect(spawnCalls).toBe(0);
    expect(waitForAllCalls).toBe(0);
  });

  it("no registry at all converges on unknown/null (fail-open baseline)", () => {
    uninstall();
    expect(probeAgentState("any-id")).toBe("unknown");
    expect(anyTopLevelRunning()).toBe(null);
    expect(probeAgentSessionEvidence("any-id").status).toBe("unknown");
  });
});

describe("218 T4.2: static sweep — the fake enumeration cannot flow back in", () => {
  /** Recursively collect every test-source .ts file. */
  function collectTestSources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...collectTestSources(p));
      else if (name.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  /**
   * Keep CODE lines only. TSDoc/comments may legitimately NAME the removed
   * fake members (the incident lesson lives in the comments); an occurrence
   * in code means a registry double with an enumeration surface is back.
   */
  function codeLines(text: string): string {
    return text
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return (
          !t.startsWith("//") &&
          !t.startsWith("*") &&
          !t.startsWith("/*") &&
          !t.startsWith("*/")
        );
      })
      .join("\n");
  }

  it("no test source references listRecords/listAgents outside comments", () => {
    const root = join(process.cwd(), "src", "__tests__");
    const sources = collectTestSources(root);
    // Sanity: the sweep actually sees the suite (guards against a wrong cwd
    // silently scanning zero files — the very fidelity failure this file
    // exists to prevent).
    expect(sources.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of sources) {
      // This scan pins the rule with the forbidden words in CODE itself.
      if (file.endsWith("manager-registry-fidelity.test.ts")) continue;
      if (/\blist(?:Records|Agents)\b/.test(codeLines(readFileSync(file, "utf-8")))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
