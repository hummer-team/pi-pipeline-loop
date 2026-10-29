/**
 * 218 Phase 0 (T0.6 / Q16-B): Tier-2.5 — the defer-only ledger supplement.
 *
 * A same-name entry WITHOUT a probeable agentId means a dispatch is in flight
 * whose RPC reply has not arrived. When the manager has NOT authoritatively
 * confirmed "nothing is running" (`anyTopLevelRunning() !== false`), the new
 * dispatch must DEFER rather than race a twin. With no such entry, or with an
 * authoritatively idle registry, the miss fails open (no defer).
 *
 * Tier 1/2 (probed-live ledger hits) already have dedicated cases in
 * subagent-rpc.test.ts; this file only covers the Tier-2.5 supplement.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  spawnStageSubagent,
  __resetActiveDeferredSpawns,
  __setDeferredSpawnPollMs,
  __resetDeferredSpawnPollMs,
} from "../../utils/subagent-rpc";
import { markSubagentsReady, __resetSubagentsReady } from "../../utils/subagent-availability";
import { initAuditLog } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, createMockEventBus, auditLogFileFor } from "../helpers";
import * as fs from "node:fs";
import * as path from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

function makeDevelopConfig() {
  const tmpDir = path.join(tmpdir(), "pi-218-tier25-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(path.join(tmpDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "agents", "dev-agent.md"), "---\nname: develop-agent\n---\n# Dev Agent\n");
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
  } as never);
  return { config, tmpDir };
}

/**
 * 0.22.0-exact manager: per-id `getRecord` + `hasRunning` only (no
 * enumeration). `running` decides `anyTopLevelRunning()`; `records` decides
 * per-id probes (empty ⇒ every agentId the ledger knows probes settled).
 */
function setManager220(running: boolean, records: Record<string, string> = {}): void {
  (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
    getRecord: (id: string) => (records[id] !== undefined ? { status: records[id] } : undefined),
    hasRunning: () => running,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeSpawnPi(bus: ReturnType<typeof createMockEventBus>, replyId: string) {
  const origEmit = bus.emit.bind(bus);
  bus.emit = (event: string, payload: Record<string, unknown>) => {
    origEmit(event, payload);
    if (event === "subagents:rpc:spawn") {
      const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
      setTimeout(() => bus.trigger(replyChannel, { success: true, data: { id: replyId } }), 5);
    }
  };
  return { events: bus, sendUserMessage: () => {} };
}

beforeEach(() => {
  markSubagentsReady();
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
  __resetSubagentsReady();
  __resetActiveDeferredSpawns();
  __resetDeferredSpawnPollMs();
});

describe("218 P0 Tier-2.5: id-less in-flight ledger entry defers (defer-only)", () => {
  it("registry NOT confirmed idle + same-name id-less entry → defer (no twin spawn)", async () => {
    // Evidence carries no agentId ⇒ no lifecycle watcher; the poll drives the
    // bounded re-defer loop. The short wait window makes the escalation
    // deterministic inside the test.
    __setDeferredSpawnPollMs(5);
    const { config, tmpDir } = makeDevelopConfig();
    config.spawnWaitTimeoutMs = 80;
    await initAuditLog(config);
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-218-tier25-defer",
      // In-flight RPC dispatch: entry exists, reply (agentId) has not landed.
      activeSpawns: {
        develop: { agentName: "develop-agent", startedAt: Date.now() },
      },
    });
    setManager220(true);
    const bus = createMockEventBus();
    const mockPi = makeSpawnPi(bus, "sa-tier25-1");
    const session = {
      getMeta: () => meta,
      updateMeta: (patch: Record<string, unknown>) => Object.assign(meta, patch),
    };

    const result = await spawnStageSubagent(mockPi, config, "develop", meta, {
      ui: { notify: () => {} },
      session: session as never,
    });

    expect(result.spawned).toBe(false);
    expect(result.deferred).toBe(true);
    expect(meta.pendingSpawns?.develop?.agentName).toBe("develop-agent");
    expect(bus.emitted.some((e) => e.event === "subagents:rpc:spawn")).toBe(false);

    const logContent = fs.readFileSync(auditLogFileFor(join(tmpDir, ".pi", "audit")), "utf-8");
    expect(logContent).toContain("stage_spawn_deferred");
    expect(logContent).toContain("evidenceStage=develop");

    // Q16-B boundedness: each poll's consume re-encounters the SAME id-less
    // evidence and defers again (defer-only — a twin never races out). The
    // wait stays anchored to `requestedAt`, so it escalates to manual within
    // `spawnWaitTimeoutMs` and the queue drains with ZERO rpc:spawn emitted.
    await sleep(250);
    expect(bus.emitted.filter((e) => e.event === "subagents:rpc:spawn").length).toBe(0);
    expect(meta.pendingSpawns?.develop).toBeUndefined();
    // NOTE: `pending_spawn_wait_timeout` carries no pipelineId (179 behavior)
    // → it lands in the "system" audit segment.
    const afterEscalate = fs.readFileSync(
      auditLogFileFor(join(tmpDir, ".pi", "audit"), "system"),
      "utf-8",
    );
    expect(afterEscalate).toContain("pending_spawn_wait_timeout");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registry authoritatively idle → the miss fails open (normal spawn, no defer)", async () => {
    const { config, tmpDir } = makeDevelopConfig();
    await initAuditLog(config);
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-218-tier25-failopen",
      activeSpawns: {
        develop: { agentName: "develop-agent", startedAt: Date.now() },
      },
    });
    setManager220(false);
    const bus = createMockEventBus();
    const mockPi = makeSpawnPi(bus, "sa-tier25-2");
    const session = {
      getMeta: () => meta,
      updateMeta: (patch: Record<string, unknown>) => Object.assign(meta, patch),
    };

    const result = await spawnStageSubagent(mockPi, config, "develop", meta, {
      ui: { notify: () => {} },
      session: session as never,
    });

    expect(result.deferred).toBeFalsy();
    expect(result.spawned).toBe(true);
    expect(bus.emitted.filter((e) => e.event === "subagents:rpc:spawn").length).toBe(1);
    expect(meta.pendingSpawns?.develop).toBeUndefined();

    const logContent = fs.readFileSync(auditLogFileFor(join(tmpDir, ".pi", "audit")), "utf-8");
    expect(logContent).not.toContain("stage_spawn_deferred");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("no id-less same-name entry → no defer even when the registry is busy", async () => {
    const { config, tmpDir } = makeDevelopConfig();
    await initAuditLog(config);
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: "pipe-218-tier25-nocand",
      // Same name BUT the entry carries an agentId → Tier-2.5 candidate rule
      // (id-less entry) does not match; nothing else in the ledger is live.
      activeSpawns: {
        develop: { agentName: "develop-agent", agentId: "gone-1", startedAt: Date.now() },
      },
    });
    // "gone-1" is not in the records ⇒ settled; registry itself busy with an
    // unrelated agent.
    setManager220(true);
    const bus = createMockEventBus();
    const mockPi = makeSpawnPi(bus, "sa-tier25-3");
    const session = {
      getMeta: () => meta,
      updateMeta: (patch: Record<string, unknown>) => Object.assign(meta, patch),
    };

    const result = await spawnStageSubagent(mockPi, config, "develop", meta, {
      ui: { notify: () => {} },
      session: session as never,
    });

    expect(result.deferred).toBeFalsy();
    expect(result.spawned).toBe(true);
    expect(meta.pendingSpawns?.develop).toBeUndefined();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
