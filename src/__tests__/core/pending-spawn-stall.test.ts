/**
 * 217 Phase 1 (T1.1): pending-spawn stall watchdog unit tests.
 * Boundary matrix from the plan:
 * - entry cleared (consumed) before the deadline → no audit/notify/deliver;
 * - entry replaced by a NEW requestedAt → the old deadline never misfires;
 * - `activeSpawns[stage]` agent is live → that is progress, not a stall;
 * - repeated arm for the same (pipelineId, stage, requestedAt) → ONE deadline,
 *   ONE audit;
 * - no owner handle in the registry → `fallbackNotify` is used, audit still
 *   written.
 *
 * Uses a tiny `spawnWaitTimeoutMs` window and real timers; entry replacement
 * semantics follow 216 R6-2 (`requestedAt` is the dedup key).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  armPendingSpawnStall,
  setPendingSpawnStallDeps,
  __resetPendingSpawnStall,
  type PendingSpawnStallDeps,
} from "../../core/pending-spawn-stall";
import { registerOwnerDelivery, __resetOwnerDeliveryRegistry, unregisterOwnerDelivery } from "../../core/owner-delivery-registry";
import { makeTestConfig, makeTestMeta } from "../helpers";
import type { SessionMeta } from "../../types";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("pending-spawn-stall (217 Phase 1 / T1.1)", () => {
  const STALL_WINDOW_MS = 25;
  let meta: SessionMeta;
  let audits: Array<{ event: string; payload: Record<string, unknown> }>;
  let delivered: string[];
  let fallbackNotified: string[];
  let deps: PendingSpawnStallDeps;

  beforeEach(() => {
    __resetPendingSpawnStall();
    __resetOwnerDeliveryRegistry();
    meta = makeTestMeta({
      pipelineId: "pipe-217-stall",
      currentStage: "fix",
      pendingSpawns: { fix: { agentName: "fix-agent", requestedAt: Date.now(), attempts: 0 } },
    });
    audits = [];
    delivered = [];
    fallbackNotified = [];
    // Every config the deps may read carries the tiny stall window.
    const config = { ...makeTestConfig(), spawnWaitTimeoutMs: STALL_WINDOW_MS };
    deps = {
      getMeta: () => meta,
      getConfig: () => config,
      deliver: (summary, m) => { delivered.push(`${m.pipelineId}:${summary}`); return { delivered: true, via: "deps_fallback" }; },
      fallbackNotify: (_stage, message) => { fallbackNotified.push(message); },
      audit: (event, payload) => { audits.push({ event, payload }); },
    };
    setPendingSpawnStallDeps(deps);
  });

  afterEach(() => {
    __resetPendingSpawnStall();
    __resetOwnerDeliveryRegistry();
    // Remove any pi-subagents manager stub installed by a live-probe test.
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
  });

  const armNow = (stage: "fix" = "fix"): number => {
    const requestedAt = meta.pendingSpawns?.fix?.requestedAt ?? Date.now();
    armPendingSpawnStall(meta.pipelineId ?? "pipe", stage, requestedAt);
    return requestedAt;
  };

  it("entry consumed before the deadline → zero audit, zero delivery, zero notify", async () => {
    armNow();
    // Simulate the owner settle consuming the entry before the window ends.
    meta.pendingSpawns = undefined;
    await sleep(STALL_WINDOW_MS + 30);

    expect(audits).toHaveLength(0);
    expect(delivered).toHaveLength(0);
    expect(fallbackNotified).toHaveLength(0);
  });

  it("entry replaced by a NEW requestedAt → the old deadline never misfires", async () => {
    const oldRequestedAt = meta.pendingSpawns!.fix!.requestedAt;
    armPendingSpawnStall(meta.pipelineId!, "fix", oldRequestedAt);

    // Replace the entry (212/216 replacement contract: new key replaces).
    const newer = oldRequestedAt + 10;
    meta.pendingSpawns = { fix: { agentName: "fix-agent", requestedAt: newer, attempts: 0 } };

    await sleep(STALL_WINDOW_MS + 30);
    expect(audits).toHaveLength(0);
    expect(delivered).toHaveLength(0);

    // The NEW deadline DOES fire for the replacement entry.
    armPendingSpawnStall(meta.pipelineId!, "fix", newer);
    await sleep(STALL_WINDOW_MS + 30);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.event).toBe("pending_spawn_stalled");
    expect(audits[0]?.payload.requestedAt).toBe(String(newer));
  });

  it("live executor for the stage → progress, not a stall", async () => {
    // probeAgentState reads the process-wide pi-subagents manager singleton
    // (src/utils/subagents-introspect.ts:44-53). Install the stub the same way
    // other suites do (e.g. agent-settled-confirm-review.test.ts) so the
    // `live` branch of pending-spawn-stall.ts:57 is actually exercised —
    // an unregistered id would return "unknown", not "live".
    const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: (id: string) => (id === "agent-live" ? { status: "running" } : undefined),
    };
    meta.activeSpawns = { fix: { agentId: "agent-live", agentName: "fix-agent", startedAt: Date.now() } };
    armNow();
    await sleep(STALL_WINDOW_MS + 30);

    expect(audits).toHaveLength(0);
    expect(delivered).toHaveLength(0);
    expect(fallbackNotified).toHaveLength(0);
  });

  it("live probe answers settled → the watchdog DOES report the stall", async () => {
    // Reverse case: a resolved-but-settled executor is NOT progress — the
    // guard at :57 must let the stall fire (proves the guard both ways).
    const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      getRecord: () => ({ status: "completed" }),
    };
    meta.activeSpawns = { fix: { agentId: "agent-settled", agentName: "fix-agent", startedAt: Date.now() } };
    armNow();
    await sleep(STALL_WINDOW_MS + 30);

    expect(audits).toHaveLength(1);
    expect(audits[0]?.event).toBe("pending_spawn_stalled");
    expect(delivered).toHaveLength(1);
  });

  it("same (pipelineId, stage, requestedAt) re-armed → one deadline, one audit", async () => {
    armNow();
    armNow();
    armNow();

    await sleep(STALL_WINDOW_MS + 40);

    expect(audits).toHaveLength(1);
    expect(audits[0]?.payload).toMatchObject({
      pipelineId: "pipe-217-stall",
      stage: "fix",
      agentName: "fix-agent",
      attempts: "0",
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("queued for");
  });

  it("no owner handle → fallbackNotify is used and the audit is still written", async () => {
    delete meta.stageExecutorRun; // no binding, no registration
    armNow();
    await sleep(STALL_WINDOW_MS + 40);

    expect(audits).toHaveLength(1);
    expect(fallbackNotified).toHaveLength(1);
    expect(fallbackNotified[0]).toContain("fix stage is queued but no executor was started");
    expect(delivered).toHaveLength(1);
  });

  it("registered owner handle receives the visible notify (registry wins)", async () => {
    const notifications: string[] = [];
    registerOwnerDelivery({
      sessionFile: "/sessions/owner.jsonl",
      isChild: false,
      getMeta: () => meta,
      sendFollowUp: () => false, // registry resolves the handle for NOTIFY only here
      notify: (message) => { notifications.push(message); },
      audit: () => {},
    });
    armNow();
    await sleep(STALL_WINDOW_MS + 40);

    expect(audits).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    expect(fallbackNotified).toHaveLength(0);
  });

  it("missing deps or meta at fire time → silent no-op, no crash", async () => {
    setPendingSpawnStallDeps(null);
    armNow(); // window bounded by the DEFAULT (deps null) — 120s, far in the future
    // Do NOT wait for the default 120s deadline; just assert no crash on re-arm.
    expect(() => { armNow(); }).not.toThrow();

    // Meta gone at fire time: re-install deps with getMeta → undefined.
    setPendingSpawnStallDeps({ ...deps, getMeta: () => undefined });
    armNow();
    await sleep(STALL_WINDOW_MS + 40);
    expect(audits).toHaveLength(0);
  });

  it("cleanup wipes every armed deadline and clears deps", async () => {
    armNow();
    __resetPendingSpawnStall(); // wipes timers; re-arming is required
    setPendingSpawnStallDeps(deps);
    armNow();
    await sleep(STALL_WINDOW_MS + 40);
    expect(audits).toHaveLength(1);
  });
});
