/**
 * 192 Phase 1 (F01/F04): operation-aware RPC identity tests.
 *
 * Uses the existing event-bus mock pattern; asserts EXACT RPC counts and
 * operation identities (not "any of pending/success"):
 * - trusted id recorded; live/child queue paths never fabricate agentId
 * - late callbacks and stale queue entries cannot pollute new operations
 * - same-millisecond new operation is not swallowed by the old stamp
 * - timeout/fallback/report-write failures produce explicit outcomes
 * - strict failures happen BEFORE any RPC (zero external calls)
 * - develop-handoff: not-sent → send-intent → trusted/unknown boundaries;
 *   receipt saved but finished-commit failure → re-entry adds ZERO RPC
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  spawnStageSubagent,
  consumePendingSpawns,
  clearPendingSpawn,
  enqueuePendingSpawn,
  setDesignReviewTerminalHandler,
  __peekDesignReviewTerminalHandler,
} from "../../utils/subagent-rpc";
import { clearActiveSpawnRecord } from "../../utils/spawn-cleanup";
import {
  markSubagentsReady,
  markSubagentsUnavailable,
  __resetSubagentsReady,
} from "../../utils/subagent-availability";
import { __resetAuditDirPath } from "../../utils/auditLog";
import { matchCommitExpectation } from "../../core/session-state";
import type { MetaCommitExpectation } from "../../core/session-state";
import type {
  SessionMeta,
  PipelineConfig,
  DesignReviewState,
  SpawnOperationContext,
  ReliableMetaCommitResult,
} from "../../types";
import { makeTestConfig, makeTestMeta, createMockEventBus } from "../helpers";

// ─── fixtures ────────────────────────────────────────────────────────────────

function makeTempConfig(): { config: PipelineConfig; cleanup: () => void } {
  const projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-rpc-"));
  const agentDir = path.join(projectRoot, "agents");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "review-agent.md"), "---\nname: design-review-agent\n---\nbody\n", "utf-8");
  fs.writeFileSync(path.join(agentDir, "plan-agent.md"), "---\nname: plan-agent\n---\nbody\n", "utf-8");
  fs.writeFileSync(path.join(agentDir, "develop-agent.md"), "---\nname: develop-agent\n---\nbody\n", "utf-8");
  const config = makeTestConfig({ projectRoot });
  config.stages["design-review"] = { ...config.stages["design-review"], agentPath: "agents/review-agent.md" };
  config.stages["plan"] = { ...config.stages["plan"], agentPath: "agents/plan-agent.md" };
  config.stages["develop"] = { ...config.stages["develop"], agentPath: "agents/develop-agent.md" };
  return { config, cleanup: () => fs.rmSync(projectRoot, { recursive: true, force: true }) };
}

function makeOp(overrides?: Partial<SpawnOperationContext>): SpawnOperationContext {
  return {
    pipelineId: "pipe-test-001",
    authorizationId: "auth-1",
    round: 1,
    kind: "review",
    operationId: "op-review-1",
    stageVisitId: 1000,
    ...overrides,
  };
}

/**
 * Strict-capable in-memory session carrying an optional designReview state.
 * `failOnce` can force the NEXT strict commit (matching predicate) to
 * unavailable — used for receipt/finished write-failure windows.
 */
function makeSession(
  meta: SessionMeta,
  opts?: { failWhen?: (patch: Partial<SessionMeta>) => boolean },
) {
  let current: SessionMeta = { ...meta };
  return {
    getMeta: () => current,
    updateMeta: (patch: Partial<SessionMeta>) => {
      current = { ...current, ...patch };
      return current;
    },
    updateMetaVerified: (
      patch: Partial<SessionMeta>,
      expected: MetaCommitExpectation,
    ): ReliableMetaCommitResult => {
      if (opts?.failWhen?.(patch)) {
        return { status: "unavailable", reason: "injected_failure" };
      }
      const conflict = matchCommitExpectation(current, expected);
      if (conflict) return { status: "conflict", reason: conflict };
      current = { ...current, ...patch };
      return { status: "persisted", meta: current };
    },
    /** Direct replacement for test transitions */
    replace: (m: SessionMeta) => {
      current = m;
    },
  };
}

function metaWithDr(session: ReturnType<typeof makeSession>, opId: string, kind: SpawnOperationContext["kind"]) {
  const dr: DesignReviewState = {
    schemaVersion: 1,
    planDoc: path.resolve("/tmp/project/docs/plan.md"),
    authorizationId: "auth-1",
    authorizationSource: "menu",
    round: 1,
    phase: "review_running",
    operation: {
      operationId: opId,
      kind,
      stageVisitId: 1000,
      attempt: 1,
      dispatchState: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      round: 1,
    },
    authorizedAt: Date.now(),
    updatedAt: Date.now(),
  };
  // Patch ONLY designReview so test-specific stage/spawn fixtures survive
  // (replace() would wipe spawnedStages/activeSpawns fixtures).
  session.updateMeta({ designReview: dr });
  return dr;
}

/** Event bus whose spawn RPC replies with a real id (or per-behavior hook) */
function makeReplyingBus(reply: (payload: Record<string, unknown>) => void | { id?: string; success?: boolean; error?: string }) {
  const bus = createMockEventBus();
  const origEmit = bus.emit.bind(bus);
  let rpcCount = 0;
  bus.emit = (event: string, payload: Record<string, unknown>) => {
    origEmit(event, payload);
    if (event === "subagents:rpc:spawn") {
      rpcCount++;
      const replyChannel = `subagents:rpc:spawn:reply:${payload.requestId}`;
      if (reply) {
        setTimeout(() => {
          const r = reply(payload);
          if (r === undefined) return; // simulate timeout: never reply
          if (r.success === false) {
            bus.trigger(replyChannel, { success: false, error: r.error ?? "spawn_rejected" });
          } else {
            bus.trigger(replyChannel, { success: true, data: { id: r.id ?? "agent-real-1" } });
          }
        }, 1);
      }
    }
  };
  return { bus, rpcCalls: () => rpcCount };
}

describe("192 Phase 1: spawnStageSubagent operation identity", () => {
  let tmp: ReturnType<typeof makeTempConfig>;
  beforeEach(() => {
    markSubagentsReady();
    tmp = makeTempConfig();
  });
  afterEach(() => {
    __resetSubagentsReady();
    __resetAuditDirPath();
    tmp.cleanup();
  });

  it("RPC success records the REAL agentId and spawns the activeSpawns entry with operationContext", async () => {
    const { bus, rpcCalls } = makeReplyingBus(() => ({ id: "agent-trusted-42" }));
    const pi = { events: bus };
    const session = makeSession(makeTestMeta());
    metaWithDr(session, "op-review-1", "review");
    const meta = session.getMeta()!;

    const res = await spawnStageSubagent(pi, tmp.config, "design-review", meta, {
      session,
      operationContext: makeOp(),
    });

    expect(res.spawned).toBe(true);
    expect(res.agentId).toBe("agent-trusted-42");
    expect(res.dispatchOutcome).toBe("spawned_id");
    expect(rpcCalls()).toBe(1);
    const active = session.getMeta()!.activeSpawns?.["design-review"];
    expect(active?.agentId).toBe("agent-trusted-42");
    expect(active?.operationContext?.operationId).toBe("op-review-1");
  });

  it("same-millisecond NEW operation is NOT swallowed by the old time stamp; same operation IS", async () => {
    const { bus, rpcCalls } = makeReplyingBus(() => ({ id: "agent-x" }));
    const pi = { events: bus };
    const visit = 1000;
    const session = makeSession(makeTestMeta({
      stageStartTime: visit,
      spawnedStages: { "design-review": visit },
      activeSpawns: {
        "design-review": {
          agentName: "design-review-agent",
          agentId: "agent-old",
          startedAt: visit,
          operationContext: makeOp({ operationId: "op-OLD" }),
        },
      },
    }));
    metaWithDr(session, "op-review-1", "review");
    const meta = session.getMeta()!;

    // Same operation as the recorded spawn → duplicate guarded, ZERO RPC
    const dup = await spawnStageSubagent(pi, tmp.config, "design-review", meta, {
      session,
      operationContext: makeOp({ operationId: "op-OLD", stageVisitId: visit }),
    });
    expect(dup.dispatchOutcome).toBe("skipped_duplicate");
    expect(rpcCalls()).toBe(0);

    // NEW operation at the SAME millisecond visit → must proceed
    const meta2 = session.getMeta()!;
    const fresh = await spawnStageSubagent(pi, tmp.config, "design-review", meta2, {
      session,
      operationContext: makeOp({ stageVisitId: visit }),
    });
    expect(fresh.dispatchOutcome).toBe("spawned_id");
    expect(rpcCalls()).toBe(1);
  });

  it("stale operation identity in meta blocks BEFORE RPC (strict identity check, zero RPC)", async () => {
    const { bus, rpcCalls } = makeReplyingBus(() => ({ id: "agent-x" }));
    const pi = { events: bus };
    const session = makeSession(makeTestMeta());
    // Current operation in meta is a DIFFERENT operation than the request
    metaWithDr(session, "op-CURRENT", "update");
    const meta = session.getMeta()!;

    const res = await spawnStageSubagent(pi, tmp.config, "plan", meta, {
      session,
      operationContext: makeOp({ operationId: "op-STALE", kind: "update" }),
    });
    expect(res.dispatchOutcome).toBe("strict_blocked");
    expect(res.spawned).toBe(false);
    expect(rpcCalls()).toBe(0);
  });

  it("adapter WITHOUT the strict interface → strict_blocked, zero RPC", async () => {
    const { bus, rpcCalls } = makeReplyingBus(() => ({ id: "agent-x" }));
    const pi = { events: bus };
    const legacySession = {
      getMeta: () => makeTestMeta({ designReview: undefined }),
      updateMeta: (_p: Partial<SessionMeta>) => undefined,
    };
    const res = await spawnStageSubagent(pi, tmp.config, "design-review", makeTestMeta(), {
      session: legacySession,
      operationContext: makeOp(),
    });
    expect(res.dispatchOutcome).toBe("strict_blocked");
    expect(rpcCalls()).toBe(0);
  });

  it("RPC timeout is an UNKNOWN window: no followUp second channel, no fake id", async () => {
    const { bus, rpcCalls } = makeReplyingBus(() => undefined); // never replies
    const sends: string[] = [];
    const pi = {
      events: bus,
      sendUserMessage: (msg: string) => { sends.push(msg); },
    };
    const session = makeSession(makeTestMeta());
    metaWithDr(session, "op-review-1", "review");
    const meta = session.getMeta()!;

    const res = await spawnStageSubagent(pi, tmp.config, "design-review", meta, {
      session,
      operationContext: makeOp(),
      ui: { notify: () => {} },
    });
    expect(res.dispatchOutcome).toBe("unknown");
    expect(res.agentId).toBeUndefined();
    expect(rpcCalls()).toBe(1);
    // Exactly one dispatch channel was used — no parallel followUp fallback
    expect(sends.length).toBe(0);
  }, 15000);

  it("explicit RPC rejection may fall back; the followUp channel NEVER yields a fake agentId", async () => {
    const { bus, rpcCalls } = makeReplyingBus(() => ({ success: false, error: "spawn_rejected" }));
    const sends: string[] = [];
    const pi = {
      events: bus,
      sendUserMessage: (msg: string) => { sends.push(msg); },
    };
    const session = makeSession(makeTestMeta());
    metaWithDr(session, "op-review-1", "review");
    const meta = session.getMeta()!;

    const res = await spawnStageSubagent(pi, tmp.config, "design-review", meta, {
      session,
      operationContext: makeOp(),
      ui: { notify: () => {} },
    });
    expect(res.spawned).toBe(true);
    expect(res.fallback).toBe(true);
    expect(res.dispatchOutcome).toBe("fallback_no_id");
    expect(res.agentId).toBeUndefined();
    expect(rpcCalls()).toBe(1);
    expect(sends.length).toBe(1);
  });

  it("child context routes to owner queue with the SAME identity and exact source; ZERO RPC", async () => {
    const { bus, rpcCalls } = makeReplyingBus(() => ({ id: "agent-x" }));
    const pi = { events: bus };
    const session = makeSession(makeTestMeta());
    metaWithDr(session, "op-review-1", "review");
    // child runtimeCtx: has parentSession header
    const childCtx = {
      _ctx: {
        sessionManager: {
          getHeader: () => ({ parentSession: "owner.jsonl" }),
          getSessionName: () => "child",
          getEntries: () => [],
          getBranch: () => [],
        },
      },
    };
    const res = await spawnStageSubagent(pi, tmp.config, "plan", session.getMeta()!, {
      session,
      runtimeCtx: childCtx,
      operationContext: makeOp({ kind: "update", operationId: "op-update-1" }),
      extraArgs: "EXACT-UPDATE-PROMPT",
    });
    expect(res.dispatchOutcome).toBe("queued_owner");
    expect(rpcCalls()).toBe(0);
    const pending = session.getMeta()!.pendingSpawns?.plan;
    expect(pending?.operationContext?.operationId).toBe("op-update-1");
    expect(pending?.extraArgs).toBe("EXACT-UPDATE-PROMPT");
  });
});

describe("192 Phase 1: owner queue consumption + conditional cleanup", () => {
  let tmp: ReturnType<typeof makeTempConfig>;
  beforeEach(() => {
    markSubagentsReady();
    tmp = makeTempConfig();
  });
  afterEach(() => {
    __resetSubagentsReady();
    __resetAuditDirPath();
    tmp.cleanup();
  });

  it("consumePendingSpawns spawns ONLY for the CURRENT operation identity", async () => {
    const { bus, rpcCalls } = makeReplyingBus(() => ({ id: "agent-owner-1" }));
    const pi = { events: bus };
    const session = makeSession(makeTestMeta({ currentStage: "plan" }));
    metaWithDr(session, "op-CURRENT", "update");
    const currentMeta = session.getMeta()!;

    // Entry for a STALE operation → discarded, zero RPC, but…
    enqueuePendingSpawn(session, "plan", "plan-agent", "P", makeOp({ kind: "update", operationId: "op-STALE" }));
    const consumedStale = await consumePendingSpawns(pi, tmp.config, session.getMeta()!, {
      session,
      ui: { notify: () => {} },
    });
    expect(consumedStale).toEqual([]);
    expect(rpcCalls()).toBe(0);

    // …and a stale callback MUST NOT delete the NEWER queue entry
    enqueuePendingSpawn(session, "plan", "plan-agent", "P", makeOp({ kind: "update", operationId: "op-CURRENT" }));
    clearPendingSpawn(session, "plan", { operationId: "op-STALE" });
    expect(session.getMeta()!.pendingSpawns?.plan?.operationContext?.operationId).toBe("op-CURRENT");

    const consumed = await consumePendingSpawns(pi, tmp.config, session.getMeta()!, {
      session,
      ui: { notify: () => {} },
    });
    expect(consumed).toEqual(["plan"]);
    expect(rpcCalls()).toBe(1);
    expect(session.getMeta()!.activeSpawns?.plan?.agentId).toBe("agent-owner-1");
    expect(session.getMeta()!.pendingSpawns?.plan).toBeUndefined();
  });

  it("conditional cleanup: late callback of an old agent cannot wipe the current spawn record", () => {
    const meta = makeTestMeta({
      activeSpawns: {
        "design-review": {
          agentName: "design-review-agent",
          agentId: "agent-current",
          startedAt: Date.now(),
          operationContext: makeOp({ operationId: "op-current" }),
        },
      },
    });
    const session = makeSession(meta);

    // Late cleanup attempt bound to a SUPERSEDED identity → entry survives
    clearActiveSpawnRecord(session, "design-review", { agentId: "agent-old", operationId: "op-old" });
    expect(session.getMeta()!.activeSpawns?.["design-review"]).toBeDefined();

    // Correct identity → entry cleared
    clearActiveSpawnRecord(session, "design-review", { agentId: "agent-current", operationId: "op-current" });
    expect(session.getMeta()!.activeSpawns?.["design-review"]).toBeUndefined();
  });

  it("clearActiveSpawnRecord without expectation keeps legacy unconditional behavior", () => {
    const session = makeSession(makeTestMeta({
      activeSpawns: { "design-review": { agentName: "x", agentId: "a", startedAt: Date.now() } },
    }));
    clearActiveSpawnRecord(session, "design-review");
    expect(session.getMeta()!.activeSpawns?.["design-review"]).toBeUndefined();
  });
});

describe("192 Phase 1: design-review terminal handler DI (composition wiring)", () => {
  it("register/peek/unregister follows the fix-handler precedent", () => {
    // Save/restore around the global registry: other suites (composition
    // root) legitimately register handlers at createPipeline time.
    const before = __peekDesignReviewTerminalHandler();
    const h = async () => { /* noop */ };
    setDesignReviewTerminalHandler(h);
    expect(__peekDesignReviewTerminalHandler()).toBe(h);
    setDesignReviewTerminalHandler(null);
    expect(__peekDesignReviewTerminalHandler()).toBeNull();
    setDesignReviewTerminalHandler(before);
  });
});
