/**
 * 218 Phase 0 (T0.9): the three-source activeSpawns ledger.
 *
 * Cases (plan §Phase 0 test table):
 * 1. `started` hitting a stage executor writes the ledger (source:"event");
 *    two stages sharing one name take the FIRST exact match and do NOT audit
 *    `spawn_type_fallback_detected`.
 * 2. A second event for the SAME agentId creates no second stage entry and
 *    never migrates the stage (R11 attribution protection).
 * 3. `created` (isBackground) is enrichment only — never overwrites an
 *    existing agentId.
 * 4. The terminal observer clears by exact agentId; a same-stage entry with a
 *    DIFFERENT agentId is never deleted (192 conditional-cleanup regression).
 * 5. `reconcileActiveSpawns`: live kept / settled deleted / unknown beyond
 *    TTL deleted — with an injected `now` (no timers).
 * 6. Missing config/session accessors → every writer is a silent no-op.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeTestConfig, makeTestMeta, makeStageConfig, createMockEventBus, auditLogFileFor } from "../helpers";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import { readFileSync } from "node:fs";
import { ACTIVE_SPAWN_TTL_MS } from "../../constants";
import {
  setSpawnLedgerConfig,
  setSpawnLedgerSession,
  stageOfExecutorName,
  recordSpawnFromEvent,
  clearSpawnByAgentId,
  reconcileActiveSpawns,
  registerSpawnLedgerObserver,
  __resetSpawnLedger,
} from "../../utils/spawn-ledger";
import {
  wireSubagentLifecycleListeners,
  setOwnerMetaAccessor,
  __resetLifecycleRegistry,
} from "../../utils/subagent-lifecycle-registry";
import type { PipelineConfig, SessionMeta } from "../../types";

const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");
const TMP = join(tmpdir(), "pi-spawn-ledger-" + Date.now());

/** Read the day's audit file for one pipeline segment ("" when unwritten). */
function auditText(pipelineId: string): string {
  const path = auditLogFileFor(join(TMP, ".pi", "audit"), pipelineId);
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** Await the fire-and-forget audit writes (flush, not a behavioral timer). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Session writer pair over a plain meta object (updateMeta = Object.assign). */
function sessionFor(meta: SessionMeta) {
  return {
    getMeta: () => meta,
    updateMeta: (patch: Record<string, unknown>) => Object.assign(meta, patch) as SessionMeta,
  };
}

/**
 * Config whose develop+review stages BOTH resolve to "twin-agent" (in that
 * insertion order), so `stageOfExecutorName` must take the first exact match.
 */
function makeTwinConfig(): PipelineConfig {
  mkdirSync(join(TMP, "agents"), { recursive: true });
  writeFileSync(join(TMP, "agents", "twin-develop.md"), "---\nname: twin-agent\n---\n# D\n");
  writeFileSync(join(TMP, "agents", "twin-review.md"), "---\nname: twin-agent\n---\n# R\n");
  writeFileSync(join(TMP, "agents", "solo.md"), "---\nname: solo-agent\n---\n# S\n");
  const config = makeTestConfig({
    projectRoot: TMP,
    stages: {
      ...makeTestConfig().stages,
      develop: makeStageConfig({ agentPath: "agents/twin-develop.md", nextStage: "review" }),
      review: makeStageConfig({ agentPath: "agents/twin-review.md", nextStage: "fix" }),
      fix: makeStageConfig({ agentPath: "agents/solo.md", nextStage: null }),
    },
  } as never);
  initAuditLog(config);
  return config;
}

/** Fake pi exposing the event bus (on/trigger) the lifecycle wire needs. */
function makePi(bus: ReturnType<typeof createMockEventBus>) {
  return { events: bus };
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
  __resetLifecycleRegistry();
  setOwnerMetaAccessor(null);
  __resetSpawnLedger();
  __resetAuditDirPath();
});

describe("218 P0 spawn-ledger: three-source writes and boundaries", () => {
  it("case 1: started on a dual-stage shared name writes the FIRST matching stage with source=event, no type-fallback audit", async () => {
    const config = makeTwinConfig();
    const meta = makeTestMeta({ currentStage: "plan", pipelineId: "pipe-ledger-1" });
    setSpawnLedgerConfig(config);
    setSpawnLedgerSession(sessionFor(meta) as never);
    setOwnerMetaAccessor(() => meta);

    const bus = createMockEventBus();
    const off = wireSubagentLifecycleListeners(makePi(bus));
    // Name resolution: "twin-agent" owns develop FIRST (stage iteration order).
    expect(stageOfExecutorName("twin-agent")).toBe("develop");

    bus.trigger("subagents:started", { id: "a1", type: "twin-agent" });
    await flush();

    const ledger = meta.activeSpawns!;
    expect(ledger.develop).toMatchObject({ agentId: "a1", agentName: "twin-agent", source: "event" });
    expect(ledger.review).toBeUndefined();
    const text = auditText("pipe-ledger-1");
    expect(text).toContain("spawn_ledger_event_written");
    expect(text).not.toContain("spawn_type_fallback_detected");
    off();
  });

  it("case 2: a second event for the same agentId never creates a second stage entry and never migrates the stage", async () => {
    const config = makeTwinConfig();
    const meta = makeTestMeta({ currentStage: "plan", pipelineId: "pipe-ledger-2" });
    setSpawnLedgerConfig(config);
    setSpawnLedgerSession(sessionFor(meta) as never);
    setOwnerMetaAccessor(() => meta);

    const bus = createMockEventBus();
    const off = wireSubagentLifecycleListeners(makePi(bus));

    bus.trigger("subagents:started", { id: "a2", type: "twin-agent" });
    // Second event for the SAME id (e.g. a duplicate started / queue→running
    // replay). Identity-first: refresh only — the stage key never migrates.
    bus.trigger("subagents:started", { id: "a2", type: "twin-agent" });
    await flush();

    const ledger = meta.activeSpawns!;
    expect(ledger.develop?.agentId).toBe("a2");
    expect(ledger.review).toBeUndefined();
    expect(Object.keys(ledger)).toEqual(["develop"]);
    off();
  });

  it("case 3: created(isBackground) enriches only — an existing agentId is never overwritten", async () => {
    const config = makeTwinConfig();
    const meta = makeTestMeta({ currentStage: "plan", pipelineId: "pipe-ledger-3" });
    setSpawnLedgerConfig(config);
    setSpawnLedgerSession(sessionFor(meta) as never);
    setOwnerMetaAccessor(() => meta);

    const bus = createMockEventBus();
    const off = wireSubagentLifecycleListeners(makePi(bus));

    bus.trigger("subagents:started", { id: "a3", type: "solo-agent" });
    // Same identity via `created` — enrichment (isBackground rides the audit),
    // the entry keeps its agentId/stage/source.
    bus.trigger("subagents:created", { id: "a3", type: "solo-agent", isBackground: true });
    // A DIFFERENT id claiming the same stage must never overwrite the ledger.
    bus.trigger("subagents:created", { id: "intruder-3", type: "solo-agent", isBackground: true });
    await flush();

    const ledger = meta.activeSpawns!;
    expect(ledger.fix?.agentId).toBe("a3");
    expect(ledger.fix?.source).toBe("event");
    expect(Object.keys(ledger)).toEqual(["fix"]);
    const text = auditText("pipe-ledger-3");
    expect(text).toContain("isBackground=true");
    // The intruder never owns a ledger write (refresh/identity guard): no
    // `spawn_ledger_event_written` line carries its id.
    expect(text).not.toMatch(/spawn_ledger_event_written[^\n]*agentId=intruder-3/);
    off();
  });

  it("case 4: terminal clears by exact agentId — a same-stage entry with a DIFFERENT id survives (192 regression)", async () => {
    const config = makeTwinConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-ledger-4",
      // Pre-seeded RPC-style ledger entry (writeGuard shape, no `source`).
      activeSpawns: {
        develop: { agentName: "twin-agent", agentId: "d1", startedAt: Date.now() },
      },
    });
    setSpawnLedgerConfig(config);
    setSpawnLedgerSession(sessionFor(meta) as never);
    setOwnerMetaAccessor(() => meta);

    const bus = createMockEventBus();
    const off = wireSubagentLifecycleListeners(makePi(bus));
    const offObserver = registerSpawnLedgerObserver();

    // Terminal for an UNRELATED id — the d1 entry must stay untouched.
    bus.trigger("subagents:completed", { id: "other-9", reason: "completed" });
    expect(meta.activeSpawns?.develop?.agentId).toBe("d1");

    // Terminal for the EXACT id — cleared, and audited.
    bus.trigger("subagents:completed", { id: "d1", reason: "completed" });
    await flush();
    expect(meta.activeSpawns?.develop).toBeUndefined();
    const text = auditText("pipe-ledger-4");
    expect(text).toContain("spawn_ledger_cleared");
    expect(text).toContain("agentId=d1");
    off();
    offObserver();
  });

  it("case 5: reconcileActiveSpawns keeps live, drops settled immediately, TTL-bounds unknown ids (injected now)", async () => {
    const config = makeTwinConfig();
    const seeded = Date.now();
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-ledger-5",
      activeSpawns: {
        develop: { agentName: "twin-agent", agentId: "live-1", startedAt: seeded },
        review: { agentName: "twin-agent", agentId: "settled-1", startedAt: seeded },
        fix: { agentName: "solo-agent", agentId: "ghost-1", startedAt: seeded },
      },
    });
    setSpawnLedgerSession(sessionFor(meta) as never);
    // live-1 → running (live), settled-1 → completed (settled, authoritative
    // delete), ghost-1 → registry throws (unknown: TTL-bounded only).
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: (id: string) => {
        if (id === "ghost-1") throw new Error("registry evicted the id");
        return id === "live-1" ? { status: "running" } : { status: "completed" };
      },
      hasRunning: () => true,
    };

    // Inside the TTL window: live kept, settled dropped (authoritative),
    // unknown kept (age only).
    reconcileActiveSpawns(seeded + ACTIVE_SPAWN_TTL_MS - 1);
    expect(meta.activeSpawns?.develop?.agentId).toBe("live-1");
    expect(meta.activeSpawns?.review).toBeUndefined();
    expect(meta.activeSpawns?.fix?.agentId).toBe("ghost-1");

    // Past the TTL: the unknown id can no longer hold the ledger hostage.
    reconcileActiveSpawns(seeded + ACTIVE_SPAWN_TTL_MS + 1);
    expect(meta.activeSpawns?.fix).toBeUndefined();
    expect(meta.activeSpawns?.develop?.agentId).toBe("live-1");

    // T0.3 audit contract: every sweep reports kept/cleared/total
    // (sweep 1: live+ghost kept, settled cleared; sweep 2: ghost TTL-cleared).
    // Fire-and-forget appends may interleave, so match LINES, not order.
    await flush();
    const sweeps = auditText("pipe-ledger-5")
      .split("\n")
      .filter((l) => l.includes("spawn_ledger_reconciled"));
    expect(sweeps).toHaveLength(2);
    expect(sweeps.some((l) => l.includes("kept=2") && l.includes("cleared=1") && l.includes("total=3"))).toBe(true);
    expect(sweeps.some((l) => l.includes("kept=1") && l.includes("cleared=1") && l.includes("total=2"))).toBe(true);
  });

  it("case 6: no config / no session accessor → every writer no-ops without throwing", () => {
    __resetSpawnLedger(); // accessors absent (cold start / non-owner hook)
    expect(() => recordSpawnFromEvent({ id: "x", type: "solo-agent" }, "started")).not.toThrow();
    expect(() => recordSpawnFromEvent({ id: "x", type: "solo-agent" }, "created")).not.toThrow();
    expect(() => clearSpawnByAgentId("x")).not.toThrow();
    expect(() => reconcileActiveSpawns()).not.toThrow();
    expect(() => stageOfExecutorName("solo-agent")).not.toThrow();
    expect(stageOfExecutorName("solo-agent")).toBeNull();
  });
});
