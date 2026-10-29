/**
 * 218 Phase 1 (T1.3): owner-wake dedupe entry (`core/owner-wake-dedupe.ts`).
 *
 * Plan case table (owner-wake-dedupe.test.ts):
 * 1. same `pipelineId:stage:ownerTurnSeq` second delivery → `owner_wake_deduped`
 *    + exactly ONE delivery.
 * 2. `ownerTurnSeq` changes (next owner turn) → second delivery succeeds
 *    (NO time window anymore — D3).
 * 3. failed delivery → no `ownerWakeStamp`, next hook inside the SAME turn may
 *    retry; `owner_wake_undeliverable` written.
 * 4. stage changes → key changes, delivery allowed immediately.
 * 5. hook not registered: `stage_spawn_routed_to_owner` still succeeds, writes
 *    `pending_spawn_wake_unavailable via=hook_unregistered`, never throws
 *    (fail-open).
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverOwnerWakeOnce } from "../../core/owner-wake-dedupe";
import { spawnStageSubagent, setOwnerWakeOnceHook } from "../../utils/subagent-rpc";
import { __resetOwnerDeliveryRegistry } from "../../core/owner-delivery-registry";
import { initAuditLog, __resetAuditDirPath, __resetAuditRoutingState } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, createMockEventBus, deployDispatchAssets } from "../helpers";
import type { PipelineConfig, PipelineStage, SessionMeta } from "../../types";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let seq = 0;
const nextPid = (): string => `pipe-218-wakeded-${Date.now()}-${++seq}`;

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

function countEvents(content: string, event: string): number {
  const re = new RegExp(`\\] ${event} \\|`);
  return content.split("\n").filter((l) => re.test(l)).length;
}

interface DedupeHarness {
  root: string;
  config: PipelineConfig;
  meta: SessionMeta;
  session: { getMeta: () => SessionMeta | undefined; updateMeta: (patch: Partial<SessionMeta>) => unknown };
}

/** Fresh tmp projectRoot + initialized audit routing + wake-free registry state. */
async function makeDedupeHarness(metaOver?: Partial<SessionMeta>): Promise<DedupeHarness> {
  const root = join(tmpdir(), `pi-218-wakeded-${Date.now()}-${seq}`);
  await mkdir(join(root, ".pi", "audit"), { recursive: true });
  const config = makeTestConfig({ projectRoot: root });
  await initAuditLog(config);
  seq++;
  const meta = makeTestMeta({
    pipelineId: nextPid(),
    currentStage: "fix",
    ownerTurnSeq: 5,
    ...(metaOver ?? {}),
  });
  const session = {
    getMeta: () => meta,
    updateMeta: (patch: Partial<SessionMeta>) => {
      Object.assign(meta, patch);
      return meta;
    },
  };
  return { root, config, meta, session };
}

afterEach(() => {
  __resetOwnerDeliveryRegistry();
  __resetAuditDirPath();
  __resetAuditRoutingState();
  setOwnerWakeOnceHook(null);
});

describe("218 T1.3: deliverOwnerWakeOnce turn-keyed dedupe", () => {
  it("1) same pipelineId:stage:ownerTurnSeq → second call deduped, ONE delivery, dedup audit", async () => {
    const h = await makeDedupeHarness();
    let sends = 0;
    const fallback = (): boolean => { sends++; return true; };

    const first = deliverOwnerWakeOnce(h.session, h.meta, "wake-1", "enqueue", fallback);
    expect(first.outcome.delivered).toBe(true);
    expect(first.deduped).toBe(false);
    // 217 F2 contract: stamp only AFTER success.
    expect(h.meta.ownerWakeStamp?.key).toBe(`${h.meta.pipelineId}:fix:5`);

    const second = deliverOwnerWakeOnce(h.session, h.meta, "wake-2", "enqueue", fallback);
    expect(second.deduped).toBe(true);
    expect(second.outcome.delivered).toBe(false);
    expect(sends).toBe(1); // the second call must NOT touch any channel

    await sleep(20); // flush the fire-and-forget audit appends
    const audit = readAllAudit(h.root);
    expect(countEvents(audit, "owner_wake_deduped")).toBe(1);
    expect(audit).toContain("reason=enqueue");
  });

  it("2) ownerTurnSeq advances (next owner turn) → delivery allowed again, no time window", async () => {
    const h = await makeDedupeHarness();
    let sends = 0;
    const fallback = (): boolean => { sends++; return true; };

    const first = deliverOwnerWakeOnce(h.session, h.meta, "wake-1", "enqueue", fallback);
    expect(first.outcome.delivered).toBe(true);

    // The hook-bridge `finally` incremented the counter → fresh dedupe key.
    h.meta.ownerTurnSeq = 6;
    const second = deliverOwnerWakeOnce(h.session, h.meta, "wake-2", "enqueue", fallback);
    expect(second.deduped).toBe(false);
    expect(second.outcome.delivered).toBe(true);
    expect(sends).toBe(2);
    expect(h.meta.ownerWakeStamp?.key).toBe(`${h.meta.pipelineId}:fix:6`);
    expect(countEvents(readAllAudit(h.root), "owner_wake_deduped")).toBe(0);
  });

  it("3) failed delivery → no stamp, same turn retries, owner_wake_undeliverable written", async () => {
    const h = await makeDedupeHarness();
    let sends = 0;
    const failing = (): boolean => { sends++; return false; };

    const first = deliverOwnerWakeOnce(h.session, h.meta, "wake-1", "blocked_escalation", failing);
    expect(first.outcome.delivered).toBe(false);
    expect(first.deduped).toBe(false);
    expect(h.meta.ownerWakeStamp).toBeUndefined(); // retryable — 217 F2

    const second = deliverOwnerWakeOnce(h.session, h.meta, "wake-2", "blocked_escalation", failing);
    expect(second.deduped).toBe(false); // NOT deduped: the retry is allowed
    expect(sends).toBe(2);

    await sleep(20); // flush the fire-and-forget audit appends
    const audit = readAllAudit(h.root);
    expect(audit).toContain("owner_wake_undeliverable");
    expect(countEvents(audit, "owner_wake_deduped")).toBe(0);
  });

  it("4) stage changes → key changes, immediate delivery", async () => {
    const h = await makeDedupeHarness();
    let sends = 0;
    const fallback = (): boolean => { sends++; return true; };

    const first = deliverOwnerWakeOnce(h.session, h.meta, "wake-1", "enqueue", fallback);
    expect(first.outcome.delivered).toBe(true);

    // Same turn, different stage → different key (per-stage wake is new work).
    h.meta.currentStage = "review" as PipelineStage;
    const second = deliverOwnerWakeOnce(h.session, h.meta, "wake-2", "queued_block", fallback);
    expect(second.deduped).toBe(false);
    expect(sends).toBe(2);
  });
});

describe("218 T1.3: child-route wake hook (fail-open)", () => {
  /** Child runtime ctx: parent header + subagent name pattern (mirrors D4③). */
  const childRuntimeCtx = (): unknown => ({
    _ctx: {
      sessionManager: {
        getHeader: () => ({ parentSession: "/sessions/owner.jsonl" }),
        getSessionName: () => "review-executor#a1b2c3d4",
      },
    },
  });

  it("5) hook not registered → route still succeeds, pending_spawn_wake_unavailable via=hook_unregistered", async () => {
    const h = await makeDedupeHarness({ currentStage: "review" });
    deployDispatchAssets(h.config); // resolveAgentMention reads frontmatter from disk
    setOwnerWakeOnceHook(null);     // explicit: the composition root never installed it
    const bus = createMockEventBus();
    const pi = { events: bus, sendUserMessage: () => {} };

    const result = await spawnStageSubagent(
      pi,
      h.config,
      "review" as PipelineStage,
      h.meta,
      { ui: { notify: () => {} }, session: h.session, runtimeCtx: childRuntimeCtx() } as any,
    );

    // Fail-open: the enqueue itself is NOT blocked by the missing wake hook.
    expect(result).toMatchObject({ spawned: false, fallback: false, queuedForOwner: true });
    expect(h.meta.pendingSpawns?.review?.agentName).toBe("test-agent");

    const audit = readAllAudit(h.root);
    expect(countEvents(audit, "stage_spawn_routed_to_owner")).toBe(1);
    expect(countEvents(audit, "pending_spawn_wake_unavailable")).toBe(1);
    expect(audit).toContain("via=hook_unregistered");
    expect(audit).toContain("delivered=false");
    expect(audit).toContain("deduped=false");
    expect(countEvents(audit, "pending_spawn_wake_delivered")).toBe(0);
  });
});
