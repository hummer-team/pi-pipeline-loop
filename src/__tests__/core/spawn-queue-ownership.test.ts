/**
 * 218 Phase 1 (T1.2): the spawn-queue ownership gate (`core/spawn-queue-gate.ts`
 * installed as tool-guard 3f).
 *
 * Plan case table (spawn-queue-ownership.test.ts):
 * 1.  no `pendingSpawns` → pass (existing 3c/3d/3e order untouched).
 * 2.  entry agentName differs from `subagent_type` → pass (no cross-agent block).
 * 2b. entry `pipelineId` belongs to another pipeline → pass (residue ≠ ownership).
 * 3.  entry exists, no `stalledAt` → block + `spawn_queued_blocked` + NO
 *     `pipeline_violation` (not counted).
 * 4.  `stalledAt` set, `dispatchConsumedAt` absent → authorize and write
 *     `dispatchConsumedAt`; second call → block.
 * 5.  child session → never enters 3f (children are routed by 3b).
 * 6.  `suppressDuplicateSpawn:false` does NOT disable the queue gate (F.1).
 * 7.  authorized entry (`dispatchConsumedAt`) is dropped by consumePendingSpawns
 *     WITHOUT calling spawnStageSubagent (twin regression).
 * 8.  takeover stage (clarify): `stalledAt` + 3d hit → only
 *     `spawn_takeover_blocked`, NO `spawn_queue_authorization_consumed`,
 *     NO authorized notify.
 * 9.  authorization write uses the LATEST table (concurrent other-stage enqueue
 *     survives).
 * 10. same-target re-enqueue does not wipe the authorization fields; 3f still
 *     authorizes exactly once.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolGuard } from "../../core/tool-guard";
import { consumePendingSpawns, enqueuePendingSpawn, setOwnerWakeOnceHook } from "../../utils/subagent-rpc";
import { __resetOwnerDeliveryRegistry } from "../../core/owner-delivery-registry";
import { initAuditLog, __resetAuditDirPath, __resetAuditRoutingState } from "../../utils/auditLog";
import { __resetMemoryThrottle } from "../../utils/audit-throttle";
import { makeTestConfig, makeTestMeta, createMockCtx, createMockEventBus, deployDispatchAssets } from "../helpers";
import type { PendingSpawnEntry, PipelineConfig, SessionMeta } from "../../types";

/** Concatenate EVERY audit file under the case root (pipeline AND system). */
function readAllAudit(root: string): string {
  const base = join(root, ".pi", "audit");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(fs.readFileSync(p, "utf-8"));
    }
  };
  if (fs.existsSync(base)) walk(base);
  return out.join("\n");
}

let TMP: string;
let seq = 0;
const nextRoot = (): string =>
  join(TMP, `case-${Date.now()}-${++seq}`);

/** Fresh per-case config: stage agents deployed (mention = "test-agent"). */
function makeGateConfig(): PipelineConfig {
  const root = nextRoot();
  fs.mkdirSync(join(root, ".pi", "audit"), { recursive: true });
  const config = makeTestConfig({ projectRoot: root });
  deployDispatchAssets(config);
  return config;
}

/** Owner ctx with an Agent tool call for the current stage's executor. */
function makeGuardCtx(meta: SessionMeta, subagentType = "test-agent") {
  const ctx = createMockCtx(meta);
  ctx.toolCall = { name: "Agent", arguments: { subagent_type: subagentType } };
  return ctx;
}

async function runGuard(config: PipelineConfig, ctx: ReturnType<typeof makeGuardCtx>) {
  const hook = createToolGuard(config);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await hook.handler(ctx as any);
}

const queuedEntry = (over?: Partial<PendingSpawnEntry>): PendingSpawnEntry => ({
  agentName: "test-agent",
  requestedAt: Date.now(),
  attempts: 0,
  ...over,
});

beforeEach(async () => {
  TMP = join(tmpdir(), `pi-218-qgate-${Date.now()}`);
  await mkdir(TMP, { recursive: true });
  __resetMemoryThrottle();
});

afterEach(() => {
  __resetOwnerDeliveryRegistry();
  __resetAuditDirPath();
  __resetAuditRoutingState();
  setOwnerWakeOnceHook(null);
});

describe("218 T1.2: 3f queue ownership via tool-guard", () => {
  it("1) no pendingSpawns → pass, no new audit events", async () => {
    const config = makeGateConfig();
    await initAuditLog(config);
    const meta = makeTestMeta({ currentStage: "fix", flowState: "running" });
    const ctx = makeGuardCtx(meta);
    const result = await runGuard(config, ctx);
    expect(result).toBeUndefined();
    const audit = readAllAudit(config.projectRoot);
    expect(audit).not.toContain("spawn_queued_blocked");
    expect(audit).not.toContain("spawn_queue_authorization_consumed");
  });

  it("2) entry agentName differs from subagent_type → pass", async () => {
    const config = makeGateConfig();
    await initAuditLog(config);
    const meta = makeTestMeta({
      currentStage: "fix",
      flowState: "running",
      pendingSpawns: { fix: { agentName: "other-agent", requestedAt: Date.now(), attempts: 0 } },
    });
    const ctx = makeGuardCtx(meta);
    const result = await runGuard(config, ctx);
    expect(result).toBeUndefined();
    expect(readAllAudit(config.projectRoot)).not.toContain("spawn_queued_blocked");
  });

  it("2b) foreign-pipeline residue → pass (not ownership)", async () => {
    const config = makeGateConfig();
    await initAuditLog(config);
    const meta = makeTestMeta({
      currentStage: "fix",
      flowState: "running",
      pendingSpawns: { fix: { ...queuedEntry(), pipelineId: "pipe-SOME-OTHER-RUN", stalledAt: Date.now() } },
    });
    const ctx = makeGuardCtx(meta);
    const result = await runGuard(config, ctx);
    expect(result).toBeUndefined();
    const audit = readAllAudit(config.projectRoot);
    expect(audit).not.toContain("spawn_queued_blocked");
    expect(audit).not.toContain("spawn_queue_authorization_consumed");
  });

  it("3) queued entry, no stalledAt → block + spawn_queued_blocked, NO pipeline_violation", async () => {
    const config = makeGateConfig();
    await initAuditLog(config);
    const entry = queuedEntry();
    const meta = makeTestMeta({
      currentStage: "fix",
      flowState: "running",
      pendingSpawns: { fix: entry },
    });
    const ctx = makeGuardCtx(meta);
    const result = await runGuard(config, ctx);
    expect((result as any)?.block).toBe(true);
    expect((result as any)?.reason).toContain("Plugin queue owns the fix executor");
    const audit = readAllAudit(config.projectRoot);
    expect(audit).toContain("spawn_queued_blocked");
    expect(audit).toContain(`requestedAt=${entry.requestedAt}`);
    // Blocking is NOT a violation (F.1): no violation audit, no counter.
    expect(audit).not.toContain("pipeline_violation");
    expect((meta as { violations?: unknown }).violations).toBeUndefined();
  });

  it("4) stalledAt + unconsumed → authorize once (writes dispatchConsumedAt), second call blocks", async () => {
    const config = makeGateConfig();
    await initAuditLog(config);
    const meta = makeTestMeta({
      currentStage: "fix",
      flowState: "running",
      pendingSpawns: { fix: { ...queuedEntry(), stalledAt: Date.now() - 1000, dispatchAuthorizedAt: Date.now() - 1000 } },
    });
    const ctx = makeGuardCtx(meta);

    const first = await runGuard(config, ctx);
    expect(first).toBeUndefined(); // released — the manual dispatch proceeds
    expect(meta.pendingSpawns?.fix?.dispatchConsumedAt).toBeDefined();
    const auditAfterFirst = readAllAudit(config.projectRoot);
    expect(auditAfterFirst).toContain("spawn_queue_authorization_consumed");

    const second = await runGuard(config, ctx);
    expect((second as any)?.block).toBe(true); // authorization spent → back to block
    const audit = readAllAudit(config.projectRoot);
    expect(audit).toContain("spawn_queued_blocked");
    expect(ctx.notifications.some((n) => n.includes("One-shot manual dispatch authorized"))).toBe(true);
  });

  it("5) child session → never enters 3f", async () => {
    const config = makeGateConfig();
    await initAuditLog(config);
    const meta = makeTestMeta({
      currentStage: "fix",
      flowState: "running",
      // stalledAt set: as owner this WOULD authorize — the child must not touch it.
      pendingSpawns: { fix: { ...queuedEntry(), stalledAt: Date.now() } },
    });
    const ctx = createMockCtx(meta, { sessionHeader: { parentSession: "/sessions/owner.jsonl" } });
    ctx.toolCall = { name: "Agent", arguments: { subagent_type: "test-agent" } };
    await runGuard(config, ctx);
    const audit = readAllAudit(config.projectRoot);
    expect(audit).not.toContain("spawn_queued_blocked");
    expect(audit).not.toContain("spawn_queue_authorization_consumed");
    expect(meta.pendingSpawns?.fix?.dispatchConsumedAt).toBeUndefined();
  });

  it("6) suppressDuplicateSpawn:false does NOT disable the queue gate (F.1)", async () => {
    const config = makeGateConfig();
    await initAuditLog(config);
    config.stages.fix = { ...config.stages.fix, guard: { ...(config.stages.fix as { guard?: object }).guard, suppressDuplicateSpawn: false } };
    const meta = makeTestMeta({
      currentStage: "fix",
      flowState: "running",
      pendingSpawns: { fix: queuedEntry() },
    });
    const ctx = makeGuardCtx(meta);
    const result = await runGuard(config, ctx);
    expect((result as any)?.block).toBe(true);
    const audit = readAllAudit(config.projectRoot);
    expect(audit).toContain("spawn_queued_blocked");
    expect(audit).not.toContain("spawn_suppressed"); // 3c is off; 3f fired
  });

  it("8) takeover stage (clarify): 3d wins, no authorization, no authorized notify", async () => {
    const config = makeGateConfig();
    await initAuditLog(config);
    const meta = makeTestMeta({
      currentStage: "clarify",
      flowState: "running",
      pendingSpawns: { clarify: { ...queuedEntry(), stalledAt: Date.now() } },
    });
    const ctx = makeGuardCtx(meta);
    const result = await runGuard(config, ctx);
    expect((result as any)?.block).toBe(true);
    const audit = readAllAudit(config.projectRoot);
    expect(audit).toContain("spawn_takeover_blocked");
    expect(audit).not.toContain("spawn_queue_authorization_consumed");
    expect(audit).not.toContain("spawn_queued_blocked");
    expect(ctx.notifications.some((n) => n.includes("One-shot"))).toBe(false);
  });

  it("9) authorization write uses the LATEST table (other-stage enqueue survives)", async () => {
    const config = makeGateConfig();
    await initAuditLog(config);
    const store = makeTestMeta({
      currentStage: "fix",
      flowState: "running",
      pendingSpawns: { fix: { ...queuedEntry(), stalledAt: Date.now() } },
    });
    let getMetaCalls = 0;
    const ctx = makeGuardCtx(store);
    ctx.session.getMeta = () => {
      getMetaCalls++;
      const copy = structuredClone(store) as SessionMeta;
      if (getMetaCalls >= 2) {
        // A concurrent child enqueued another stage AFTER the hook-entry snapshot.
        copy.pendingSpawns = { ...copy.pendingSpawns, review: queuedEntry() };
      }
      return copy;
    };
    ctx.session.updateMeta = ((patch: Partial<SessionMeta>) => {
      Object.assign(store, patch);
      return store;
    }) as typeof ctx.session.updateMeta;

    await runGuard(config, ctx);
    expect(store.pendingSpawns?.fix?.dispatchConsumedAt).toBeDefined();
    expect(store.pendingSpawns?.review).toBeDefined(); // NOT erased by the write
  });

  it("10) same-target re-enqueue keeps authorization; 3f authorizes exactly once", async () => {
    const config = makeGateConfig();
    await initAuditLog(config);
    const stalledAt = Date.now() - 5000;
    const meta = makeTestMeta({
      currentStage: "fix",
      flowState: "running",
      pendingSpawns: { fix: { ...queuedEntry(), stalledAt, dispatchAuthorizedAt: stalledAt } },
    });
    const requestedAt = meta.pendingSpawns!.fix!.requestedAt;

    // Child settles again → SAME-target re-enqueue must carry the fields through.
    enqueuePendingSpawn(asSession(meta), "fix", "test-agent");
    expect(meta.pendingSpawns?.fix?.stalledAt).toBe(stalledAt);
    expect(meta.pendingSpawns?.fix?.dispatchAuthorizedAt).toBe(stalledAt);
    expect(meta.pendingSpawns?.fix?.requestedAt).toBe(requestedAt);

    const ctx = makeGuardCtx(meta);
    const first = await runGuard(config, ctx);
    expect(first).toBeUndefined(); // still authorizable after the re-enqueue
    expect(meta.pendingSpawns?.fix?.dispatchConsumedAt).toBeDefined();
    const second = await runGuard(config, ctx);
    expect((second as any)?.block).toBe(true); // and only ONCE
  });
});

/** Minimal SpawnSession view of a meta object (enqueue writes through it). */
function asSession(meta: SessionMeta) {
  return {
    getMeta: () => meta,
    updateMeta: (patch: Partial<SessionMeta>) => {
      Object.assign(meta, patch);
      return meta;
    },
  };
}

describe("218 T1.2: consume-side authorization respect", () => {
  it("7) dispatchConsumedAt entry dropped by consumePendingSpawns, no plugin spawn (twin regression)", async () => {
    const config = makeGateConfig();
    await initAuditLog(config);
    const stalledAt = Date.now() - 2000;
    const consumedAt = Date.now() - 1000;
    const meta = makeTestMeta({
      currentStage: "fix",
      flowState: "running",
      pendingSpawns: { fix: { ...queuedEntry(), stalledAt, dispatchAuthorizedAt: stalledAt, dispatchConsumedAt: consumedAt } },
    });
    const session = asSession(meta);
    const bus = createMockEventBus();
    const pi = { events: bus, sendUserMessage: () => {} };

    const consumed = await consumePendingSpawns(pi, config, meta, { session: session as any });

    expect(consumed).not.toContain("fix");
    expect(meta.pendingSpawns?.fix).toBeUndefined(); // dropped, not dispatched
    // No twin dispatch: the RPC spawn bus event never fires.
    expect(bus.emitted.some((e) => e.event === "subagents:rpc:spawn")).toBe(false);
    const audit = readAllAudit(config.projectRoot);
    expect(audit).toContain("pending_spawn_authorized_consumed");
    expect(audit).toContain(`stalledAt=${stalledAt}`);
    expect(audit).toContain(`consumedAt=${consumedAt}`);
  });
});
