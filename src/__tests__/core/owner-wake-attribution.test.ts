/**
 * 218 Phase 0 (T0.8 / plan test table): wake attribution — dispatch-time
 * ledger first, dispatch-time SNAPSHOT second, never a guessed stage.
 *
 * All cases build state through REAL event sequences (never hand-craft
 * lifecycle entries): `subagents:started` registers the dispatch snapshot,
 * `subagents:completed` drives `registerTerminal` + the observer chain.
 *
 * Case 4 pins the registration ORDER contract: terminal observers run in
 * insertion order, so `registerOwnerWakeObserver()` MUST precede
 * `registerSpawnLedgerObserver()` (the counter-case shows the wake loss a
 * future swap would cause).
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionMeta, PipelineConfig } from "../../types";
import { makeTestConfig, makeTestMeta, makeStageConfig, createMockEventBus } from "../helpers";
import { initAuditLog, __resetAuditDirPath } from "../../utils/auditLog";
import {
  registerOwnerWakeObserver,
  setOwnerWakeDeps,
  type OwnerWakeDeps,
} from "../../core/owner-wake";
import {
  wireSubagentLifecycleListeners,
  setOwnerMetaAccessor,
  __resetLifecycleRegistry,
} from "../../utils/subagent-lifecycle-registry";
import {
  setSpawnLedgerConfig,
  setSpawnLedgerSession,
  registerSpawnLedgerObserver,
  __resetSpawnLedger,
} from "../../utils/spawn-ledger";

const TMP = join(tmpdir(), "pi-wake-attribution-" + Date.now());

function makeConfig(): PipelineConfig {
  mkdirSync(join(TMP, "agents"), { recursive: true });
  writeFileSync(join(TMP, "agents", "dev.md"), "---\nname: develop-agent\n---\n# D\n");
  writeFileSync(join(TMP, "agents", "rev.md"), "---\nname: review-agent\n---\n# R\n");
  const config = makeTestConfig({
    projectRoot: TMP,
    stages: {
      ...makeTestConfig().stages,
      develop: makeStageConfig({ agentPath: "agents/dev.md", nextStage: "review" }),
      review: makeStageConfig({ agentPath: "agents/rev.md", nextStage: "fix" }),
    },
  } as never);
  initAuditLog(config);
  return config;
}

/** Production event surface + wake deps over one owner meta. */
function bootstrap(meta: SessionMeta, config: PipelineConfig) {
  const wakeSends: string[] = [];
  const wakeAudits: Array<{ event: string; payload: Record<string, unknown> }> = [];
  setOwnerMetaAccessor(() => meta);
  setSpawnLedgerConfig(config);
  setSpawnLedgerSession({
    getMeta: () => meta,
    updateMeta: (patch: Record<string, unknown>) => Object.assign(meta, patch) as SessionMeta,
  } as never);
  const deps: OwnerWakeDeps = {
    getMeta: () => meta,
    updateMeta: (patch) => { Object.assign(meta, patch); },
    sendFollowUp: (summary) => { wakeSends.push(summary); },
    audit: (event, payload) => { wakeAudits.push({ event, payload }); },
    syncStatusBar: () => {},
  };
  setOwnerWakeDeps(deps);
  const bus = createMockEventBus();
  const offWire = wireSubagentLifecycleListeners({ events: bus });
  return {
    bus,
    wakeSends,
    wakeAudits,
    cleanup: () => { offWire(); },
  };
}

afterEach(() => {
  setOwnerWakeDeps(null);
  setOwnerMetaAccessor(null);
  __resetLifecycleRegistry();
  __resetSpawnLedger();
  __resetAuditDirPath();
});

describe("218 P0 T0.8: wake attribution from ledger / dispatch snapshot", () => {
  it("case 1: executor advanced its own stage → wake still attributed to the LEDGER stage (dispatch-time)", () => {
    const config = makeConfig();
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-wake-1" });
    const h = bootstrap(meta, config);
    const offWake = registerOwnerWakeObserver();

    h.bus.trigger("subagents:started", { id: "w1", type: "develop-agent" });
    expect(meta.activeSpawns?.develop?.agentId).toBe("w1");

    // The executor advanced: the OWNER session moved on, the ledger still
    // points at the dispatch stage.
    meta.currentStage = "review";
    h.bus.trigger("subagents:completed", { id: "w1", reason: "completed" });

    expect(h.wakeSends).toHaveLength(1);
    const fired = h.wakeAudits.find((a) => a.event === "owner_wake_on_terminal");
    expect(fired?.payload.stage).toBe("develop");
    expect(h.wakeAudits.some((a) => a.payload?.reason === "not_stage_executor")).toBe(false);
    offWake();
    h.cleanup();
  });

  it("case 2: RPC dispatch (started only) + ledger already cleared → wake from the dispatch snapshot", () => {
    const config = makeConfig();
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-wake-2" });
    const h = bootstrap(meta, config);
    const offWake = registerOwnerWakeObserver();

    h.bus.trigger("subagents:started", { id: "w2", type: "develop-agent" });
    // Simulate the T0.5 terminal sweep having already cleared the ledger
    // (session-restore shape: the meta lost the entry before this terminal).
    meta.activeSpawns = {};

    h.bus.trigger("subagents:completed", { id: "w2", reason: "completed" });

    expect(h.wakeSends).toHaveLength(1);
    const fired = h.wakeAudits.find((a) => a.event === "owner_wake_on_terminal");
    expect(fired?.payload.stage).toBe("develop"); // dispatch-time, not "review"-era
    expect(meta.currentStage).toBe("develop");
    offWake();
    h.cleanup();
  });

  it("case 3: ledger miss AND no dispatch snapshot → still skipped (fail-safe, never guess)", () => {
    const config = makeConfig();
    const meta = makeTestMeta({ currentStage: "develop", pipelineId: "pipe-wake-3" });
    const h = bootstrap(meta, config);
    const offWake = registerOwnerWakeObserver();

    // No `started` ever arrived; the terminal creates an ORPHAN entry whose
    // stage is the terminal-time currentStage — NOT trustworthy attribution.
    meta.currentStage = "review";
    h.bus.trigger("subagents:completed", { id: "w3", reason: "completed" });

    expect(h.wakeSends).toHaveLength(0);
    const skipped = h.wakeAudits.find((a) => a.event === "owner_wake_skipped");
    expect(skipped?.payload.reason).toBe("not_stage_executor");
    offWake();
    h.cleanup();
  });

  it("case 4: registration ORDER is a contract — wake-before-clear attributes via ledger; swapped order loses the wake", () => {
    const config = makeConfig();

    // ── Production order: owner wake FIRST, ledger clear SECOND ──
    const metaOk = makeTestMeta({
      currentStage: "review", // session-restore: owner moved on
      pipelineId: "pipe-wake-order",
      // Re-seeded RPC-style ledger entry (writeGuard shape) — the in-memory
      // lifecycle registry was lost, so only the ledger knows the dispatch.
      activeSpawns: {
        develop: { agentName: "develop-agent", agentId: "w4", startedAt: Date.now() },
      },
    });
    const h1 = bootstrap(metaOk, config);
    const offWake = registerOwnerWakeObserver();
    const offLedger = registerSpawnLedgerObserver();
    h1.bus.trigger("subagents:completed", { id: "w4", reason: "completed" });
    expect(h1.wakeSends).toHaveLength(1); // wake evaluated while the ledger was alive
    expect(metaOk.activeSpawns?.develop).toBeUndefined(); // then cleared
    offWake();
    offLedger();
    h1.cleanup();

    // ── Counter-case: clear FIRST → the same sequence loses the wake ──
    __resetLifecycleRegistry();
    __resetSpawnLedger();
    const metaBad = makeTestMeta({
      currentStage: "review",
      pipelineId: "pipe-wake-order-bad",
      activeSpawns: {
        develop: { agentName: "develop-agent", agentId: "w5", startedAt: Date.now() },
      },
    });
    const h2 = bootstrap(metaBad, config);
    const offLedger2 = registerSpawnLedgerObserver();
    const offWake2 = registerOwnerWakeObserver();
    h2.bus.trigger("subagents:completed", { id: "w5", reason: "completed" });
    expect(h2.wakeSends).toHaveLength(0); // ledger gone, orphan snapshot not trusted
    expect(h2.wakeAudits.find((a) => a.event === "owner_wake_skipped")?.payload.reason)
      .toBe("not_stage_executor");
    offLedger2();
    offWake2();
    h2.cleanup();
  });
});
