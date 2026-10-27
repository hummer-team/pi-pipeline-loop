/**
 * 216 Phase 1 (F2 / T1.1–T1.3): owner-queued spawns must not wake the child.
 *
 * Covers the plan matrix for `core/advance-wake-routing.test.ts`:
 * - ①/② `spawnStageSubagent` child routing carries the UNCONDITIONAL
 *   `queuedForOwner` signal while the 192 `queued_owner` dispatchOutcome
 *   semantics stay untouched;
 * - ③ the auto-advance chain skips the child wake on that route: zero
 *   `auto_advance_wake`, one `stage_advance`, one
 *   `auto_advance_wake_skipped | reason=queued_owner_route`, `pendingSpawns`
 *   retained for the owner;
 * - ④ `enqueuePendingSpawn` same-target idempotency (R6-2): BOTH `requestedAt`
 *   and `attempts` stay unchanged (attempts keeps its "failed deliveries"
 *   meaning bounded by PENDING_SPAWN_MAX_ATTEMPTS = 1);
 * - ⑤ a DIFFERENT operationId still replaces the stale request (192 contract);
 * - ⑥ entry survival: after two same-target re-enqueues the owner's
 *   `consumePendingSpawns` still spawns exactly once and clears the entry —
 *   the queued entry never silently disappears;
 * - boundary: a REAL spawn keeps the verbatim `subagent_spawned` skip reason.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnStageSubagent,
  consumePendingSpawns,
  enqueuePendingSpawn,
} from "../../utils/subagent-rpc";
import { autoAdvanceAfterVerify } from "../../core/verify-advance";
import { createPipelineUI } from "../../core/pipeline-ui";
import { markSubagentsReady, __resetSubagentsReady } from "../../utils/subagent-availability";
import { initAuditLog, __resetAuditDirPath, __resetAuditRoutingState } from "../../utils/auditLog";
import {
  makeTestConfig,
  makeTestMeta,
  createMockEventBus,
  deployDispatchAssets,
} from "../helpers";
import type {
  PipelineConfig,
  PipelineStage,
  SessionMeta,
  SpawnOperationContext,
} from "../../types";

// ─── Harness ──────────────────────────────────────────────────────────────────

const PASS_RESULT = {
  structuredResult: { failures: [] },
  ruleMissing: [],
  verifyResult: { structured: { passed: true }, llm: null as unknown, overallPassed: true },
};

let seq = 0;
const nextPid = () => `pipe-216-route-${Date.now()}-${++seq}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Child runtime ctx: parent header + subagent name pattern (mirrors D4③). */
function childRuntimeCtx(): unknown {
  return {
    _ctx: {
      sessionManager: {
        getHeader: () => ({ parentSession: "/sessions/owner.jsonl" }),
        getSessionName: () => "review-executor#a1b2c3d4",
      },
    },
  };
}

/** Owner-ish runtime ctx: no child signals at all. */
function ownerRuntimeCtx(): unknown {
  return { _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } } };
}

interface Harness {
  root: string;
  config: PipelineConfig;
  meta: SessionMeta;
  // SpawnSession structural mock — `as any` is the established convention.
  session: any;
}

/**
 * Fresh tmp projectRoot + initialized audit subsystem + deployed stage agents
 * (resolveAgentMention reads the frontmatter `name:` from disk, so the child
 * routing branch needs a real agent file).
 */
async function makeHarness(metaOver?: Partial<SessionMeta>): Promise<Harness> {
  const root = join(tmpdir(), `pi-216-route-${Date.now()}-${seq}`);
  await mkdir(join(root, ".pi", "audit"), { recursive: true });
  const config = makeTestConfig({ projectRoot: root });
  deployDispatchAssets(config); // every stage agent ships name: test-agent
  await initAuditLog(config);
  seq++;
  const meta = makeTestMeta({ pipelineId: nextPid(), ...(metaOver ?? {}) });
  const session = {
    getMeta: () => meta,
    updateMeta: (patch: Partial<SessionMeta>) => {
      Object.assign(meta, patch);
      return meta;
    },
  };
  return { root, config, meta, session };
}

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

function fieldsOfLast(content: string, event: string): Record<string, string> {
  const re = new RegExp(`\\] ${event} \\|`);
  const lines = content.split("\n").filter((l) => re.test(l));
  if (lines.length === 0) throw new Error(`no audit line for event "${event}" in:\n${content}`);
  const out: Record<string, string> = {};
  for (const part of lines[lines.length - 1].split(" | ").slice(1)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** Operation identity fixture for ②/⑤. */
function opCtx(operationId: string, pipelineId: string): SpawnOperationContext {
  return {
    pipelineId,
    authorizationId: "auth-216",
    round: 1,
    kind: "review",
    operationId,
    stageVisitId: 1_700_000_000_000,
  };
}

afterEach(() => {
  __resetSubagentsReady();
  __resetAuditDirPath();
  __resetAuditRoutingState();
});

// ─── ①/② spawnStageSubagent: the unconditional route signal ──────────────────

describe("216 P2: child routing carries queuedForOwner", () => {
  it("① child runtime + session → queuedForOwner:true with dispatchOutcome undefined and no RPC spawn", async () => {
    const h = await makeHarness();
    const bus = createMockEventBus();
    const pi = { events: bus, sendUserMessage: () => {} };

    const result = await spawnStageSubagent(
      pi,
      h.config,
      "review" as PipelineStage,
      h.meta,
      { ui: { notify: () => {} }, session: h.session, runtimeCtx: childRuntimeCtx() } as any,
    );

    // F2: the signal is UNCONDITIONAL — present without an operationContext.
    expect(result).toMatchObject({ spawned: false, fallback: false, queuedForOwner: true });
    expect(result.deferred).toBeUndefined();
    expect(result.dispatchOutcome).toBeUndefined();
    expect(result.agentId).toBeUndefined();

    // The request is queued for the OWNER instead of spawning in place.
    expect(h.meta.pendingSpawns?.review?.agentName).toBe("test-agent");
    expect(h.meta.pendingSpawns?.review?.attempts).toBe(0);
    expect(bus.emitted.some((e) => e.event === "subagents:rpc:spawn")).toBe(false);

    // Positive control: the routing audit still fires.
    expect(countEvents(readAllAudit(h.root), "stage_spawn_routed_to_owner")).toBe(1);
  });

  it("② with operationContext → queuedForOwner:true AND dispatchOutcome 'queued_owner' (192 no-regression)", async () => {
    const h = await makeHarness();
    const oc = opCtx("op-216-a", h.meta.pipelineId);
    const bus = createMockEventBus();
    const pi = { events: bus, sendUserMessage: () => {} };

    const result = await spawnStageSubagent(
      pi,
      h.config,
      "review" as PipelineStage,
      h.meta,
      {
        ui: { notify: () => {} },
        session: h.session,
        runtimeCtx: childRuntimeCtx(),
        operationContext: oc,
      } as any,
    );

    // F2 field and the 192 taxonomy coexist — dispatchOutcome semantics 按原样.
    expect(result).toMatchObject({ spawned: false, fallback: false, queuedForOwner: true });
    expect(result.dispatchOutcome).toBe("queued_owner");
    expect(h.meta.pendingSpawns?.review?.operationContext?.operationId).toBe("op-216-a");
    expect(bus.emitted.some((e) => e.event === "subagents:rpc:spawn")).toBe(false);
  });
});

// ─── ③ the chain: owner queue = no child wake ────────────────────────────────

describe("216 P2: the auto-advance chain skips the wake on the owner route", () => {
  it("③ child-settled advance → zero auto_advance_wake, one stage_advance, one wake_skipped(queued_owner_route), pendingSpawns retained", async () => {
    const h = await makeHarness();
    const wakes: string[] = [];
    const bus = createMockEventBus();
    const ctx = {
      session: h.session,
      ui: { notify: () => {}, setStatus: () => {}, select: async () => undefined },
      pi: { events: bus, sendUserMessage: (msg: string) => { wakes.push(msg); } },
      config: h.config,
      // The hook ctx IS the child runtime ctx (agent_settled on the child).
      _ctx: (childRuntimeCtx() as { _ctx: unknown })._ctx,
    };

    const outcome = await autoAdvanceAfterVerify(
      h.config,
      ctx as any,
      h.meta,
      "develop",
      "review" as PipelineStage,
      PASS_RESULT,
      createPipelineUI(h.config),
      { caller: "auto_advance" },
    );

    // The transition DID commit — truthful success plus owner-route dispatch.
    expect(outcome).toEqual({ advanced: true });
    expect(h.meta.currentStage).toBe("review");
    // The next-stage spawn is queued for the OWNER, not executed here.
    expect(h.meta.pendingSpawns?.review?.agentName).toBe("test-agent");

    // THE LOOP BREAK: the child receives no wake message at all.
    expect(wakes).toEqual([]);

    const content = readAllAudit(h.root);
    expect(countEvents(content, "auto_advance_wake")).toBe(0);
    expect(countEvents(content, "stage_advance")).toBe(1);
    expect(countEvents(content, "auto_advance_wake_skipped")).toBe(1);
    const f = fieldsOfLast(content, "auto_advance_wake_skipped");
    expect(f.reason).toBe("queued_owner_route");
    expect(f.fromStage).toBe("develop");
    expect(f.toStage).toBe("review");
    expect(fieldsOfLast(content, "stage_advance").method).toBe("hook_auto_advance");
  });

  // Boundary (plan §Phase1): a REAL spawn keeps its verbatim skip reason.
  it("boundary: real fallback spawn via the chain keeps reason=subagent_spawned (unchanged)", async () => {
    const h = await makeHarness();
    const sent: string[] = [];
    const ctx = {
      session: h.session,
      ui: { notify: () => {}, setStatus: () => {}, select: async () => undefined },
      // No events bus + latch reset below → spawnStageSubagent takes the
      // documented fallback channel (sendUserMessage with @mention).
      pi: { sendUserMessage: (msg: string) => { sent.push(msg); } },
      config: h.config,
      _ctx: (ownerRuntimeCtx() as { _ctx: unknown })._ctx,
    };

    const outcome = await autoAdvanceAfterVerify(
      h.config,
      ctx as any,
      h.meta,
      "develop",
      "review" as PipelineStage,
      PASS_RESULT,
      createPipelineUI(h.config),
      { caller: "auto_advance" },
    );

    expect(outcome).toEqual({ advanced: true });
    // The fallback channel delivered the stage prompt (@test-agent mention).
    expect(sent.some((m) => m.includes("@test-agent"))).toBe(true);

    const content = readAllAudit(h.root);
    expect(countEvents(content, "auto_advance_wake")).toBe(0);
    expect(countEvents(content, "auto_advance_wake_skipped")).toBe(1);
    // VERBATIM: the pre-216 reason taxonomy did not drift for real spawns.
    expect(fieldsOfLast(content, "auto_advance_wake_skipped").reason).toBe("subagent_spawned");
  });
});

// ─── ④/⑤ enqueuePendingSpawn idempotency (R6-2) ─────────────────────────────

describe("216 P2: pendingSpawn re-enqueue keeps age and delivery budget", () => {
  it("④ same target (agent, no operation) → requestedAt AND attempts both unchanged", async () => {
    const h = await makeHarness();

    enqueuePendingSpawn(h.session, "review" as PipelineStage, "test-agent");
    const first = h.meta.pendingSpawns!.review!;
    expect(first.attempts).toBe(0);
    const requestedAt = first.requestedAt;

    // Age the queue a little: a broken (Date.now()) stamp would drift.
    await sleep(5);
    enqueuePendingSpawn(h.session, "review" as PipelineStage, "test-agent");
    const second = h.meta.pendingSpawns!.review!;
    expect(second.requestedAt).toBe(requestedAt);
    expect(second.attempts).toBe(0);

    // attempts keeps its "failed deliveries" MEANING: a pre-existing count
    // survives a same-target re-enqueue untouched (never incremented toward
    // the PENDING_SPAWN_MAX_ATTEMPTS silent-drop bound, never reset either).
    h.session.updateMeta({
      pendingSpawns: { review: { ...h.meta.pendingSpawns!.review!, attempts: 1 } },
    });
    await sleep(5);
    enqueuePendingSpawn(h.session, "review" as PipelineStage, "test-agent");
    const third = h.meta.pendingSpawns!.review!;
    expect(third.requestedAt).toBe(requestedAt);
    expect(third.attempts).toBe(1);
  });

  it("⑤ different operationId → stale request replaced (192), same operationId kept", async () => {
    const h = await makeHarness();
    const pid = h.meta.pipelineId;

    enqueuePendingSpawn(h.session, "review" as PipelineStage, "test-agent", undefined, opCtx("op-A", pid));
    // Simulate an aged, already-failed entry for op-A.
    h.session.updateMeta({
      pendingSpawns: {
        review: {
          ...h.meta.pendingSpawns!.review!,
          requestedAt: Date.now() - 60_000,
          attempts: 1,
        },
      },
    });

    await sleep(5);
    enqueuePendingSpawn(h.session, "review" as PipelineStage, "test-agent", undefined, opCtx("op-B", pid));
    const replaced = h.meta.pendingSpawns!.review!;
    expect(replaced.operationContext?.operationId).toBe("op-B");
    // Different target identity → refresh age and reset the delivery budget.
    expect(replaced.requestedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(replaced.attempts).toBe(0);

    // SAME operationId again → exact R6-2 keep-both behaviour.
    const keptRequestedAt = replaced.requestedAt;
    await sleep(5);
    h.session.updateMeta({
      pendingSpawns: { review: { ...replaced, attempts: 2 } },
    });
    enqueuePendingSpawn(h.session, "review" as PipelineStage, "test-agent", undefined, opCtx("op-B", pid));
    const kept = h.meta.pendingSpawns!.review!;
    expect(kept.requestedAt).toBe(keptRequestedAt);
    expect(kept.attempts).toBe(2);
  });

  it("⑥ entry survival: two same-target re-enqueues, the owner still consumes ONE spawn", async () => {
    markSubagentsReady();
    const h = await makeHarness({ currentStage: "review" });

    // Two child settles re-queue the SAME develop→review target.
    enqueuePendingSpawn(h.session, "review" as PipelineStage, "test-agent");
    const requestedAt = h.meta.pendingSpawns!.review!.requestedAt;
    await sleep(5);
    enqueuePendingSpawn(h.session, "review" as PipelineStage, "test-agent");
    expect(h.meta.pendingSpawns!.review!.requestedAt).toBe(requestedAt);
    expect(h.meta.pendingSpawns!.review!.attempts).toBe(0);

    // The owner consumes: RPC spawn answered once → entry cleared.
    const bus = createMockEventBus();
    const origEmit = bus.emit.bind(bus);
    bus.emit = (event: string, payload: Record<string, unknown>) => {
      origEmit(event, payload);
      if (event === "subagents:rpc:spawn") {
        const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
        setTimeout(() => bus.trigger(replyChannel, { success: true, data: { id: "sa-216" } }), 5);
      }
    };
    const pi = { events: bus, sendUserMessage: () => {} };

    const consumed = await consumePendingSpawns(
      pi,
      h.config,
      h.session.getMeta(),
      { ui: { notify: () => {} }, session: h.session, runtimeCtx: ownerRuntimeCtx() } as any,
    );

    // R6-2 proof: the queued entry never silently disappears — the FIRST
    // consume delivers exactly one spawn and clears the queue.
    expect(consumed).toEqual(["review"]);
    expect(h.meta.pendingSpawns?.review).toBeUndefined();
    expect(bus.emitted.filter((e) => e.event === "subagents:rpc:spawn").length).toBe(1);
  });
});
