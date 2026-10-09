/**
 * 194 Phase 3 (C3/C5, task 3): the trusted WAKE SOURCE channel.
 *
 * Covers the plan matrix for `core/stage-executor-turn-source.test.ts`:
 * wake persistence ordering (strict commit BEFORE any send), exactly-once
 * per run+revision (dedup), send-failure resumability (pendingWakeId kept,
 * NO compensation dispatch), replay rejection at the settle gate, and the
 * visible C5 waiting state recorded before tool/smart skips.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createSessionState, __resetSharedStateDir } from "../../core/session-state";
import {
  sendTrustedOwnerWake,
  extractOwnerWakeId,
  verifyOwnerWakeTurn,
  recordAwaitingOwnerConsumption,
  OWNER_WAKE_SIGNATURE,
  TURN_SOURCE_ENTRY_TYPE,
} from "../../core/stage-executor/turn-source";
import type { PipelineConfig, SessionMeta, StageExecutorBinding, StageExecutorRun } from "../../types";
import { makeMockSessionManager } from "../helpers";

const AGENT = "01a11bbb-c3b4-72bc-9397-4f5b9881be41";

function makeBinding(overrides?: Partial<StageExecutorBinding>): StageExecutorBinding {
  return {
    runId: "run-1",
    pipelineId: "pipe-wake-1",
    ownerSessionFile: "/sessions/owner.jsonl",
    stage: "develop",
    stageVisitId: 1_700_000_000_000,
    operationId: "op-1",
    agentId: AGENT,
    ...overrides,
  };
}

function makeRun(binding?: Partial<StageExecutorBinding>, overrides?: Partial<StageExecutorRun>): StageExecutorRun {
  return {
    binding: makeBinding(binding),
    status: "completed",
    recovery: "none",
    consecutiveFailures: 0,
    terminalConsumed: false,
    ...overrides,
  };
}

function baseMeta(overrides?: Partial<SessionMeta>): SessionMeta {
  return {
    currentStage: "develop",
    previousStage: "design-review",
    stageStartTime: 1_700_000_000_000,
    pipelineId: "pipe-wake-1",
    domain: { id: "general", version: "latest", skillPath: "/tmp/domain.md" } as never,
    summaries: {},
    loopCount: 0,
    currentStepIndex: 0,
    maxLoops: 3,
    ...overrides,
  };
}

interface Harness {
  session: ReturnType<typeof createSessionState>;
  entries: unknown[];
  sent: Array<{ msg: string; opts?: Record<string, unknown> }>;
  localEntries: Array<{ customType: string; data: unknown }>;
  config: PipelineConfig;
  breakAppend: () => void;
  failSend: () => void;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const projectRoot = fs.mkdtempSync(path.join(tmpdir(), "dr-wake-"));
  const auditDir = ".pi/audit";
  const entries: unknown[] = [];
  let appendBroken = false;
  const sent: Harness["sent"] = [];
  const localEntries: Harness["localEntries"] = [];
  let sendBroken = false;
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      if (appendBroken) throw new Error("append_entry_simulated_failure");
      entries.push({ type: "custom", customType, data });
      if (customType === TURN_SOURCE_ENTRY_TYPE) localEntries.push({ customType, data });
    },
    sendUserMessage: (msg: string, opts?: Record<string, unknown>) => {
      if (sendBroken) throw new Error("send_simulated_failure");
      sent.push({ msg, opts });
    },
  };
  const session = createSessionState(pi as never, { sessionManager: makeMockSessionManager(entries) } as never, {
    projectRoot,
    auditDir,
  });
  const config = { projectRoot, stages: {}, auditDir } as unknown as PipelineConfig;
  return {
    session,
    entries,
    sent,
    localEntries,
    config,
    breakAppend: () => { appendBroken = true; },
    failSend: () => { sendBroken = true; },
    cleanup: () => {
      __resetSharedStateDir();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function seed(meta: SessionMeta): void {
  h!.session.updateMeta(meta);
}

// ─── wake issuance + ordering ────────────────────────────────────────────────

describe("194 Phase 3 (task 3): trusted owner wake", () => {
  it("persists pendingWakeId BEFORE sending, then carries source in message + entry", async () => {
    h = makeHarness();
    const run = makeRun();
    seed(baseMeta({ stageExecutorRun: run }));

    // Capture what the persisted run looks like AT SEND TIME.
    let wakeIdAtSend: string | undefined;
    const pi = {
      appendEntry: (customType: string, data: unknown) => {
        if (customType === TURN_SOURCE_ENTRY_TYPE) h!.localEntries.push({ customType, data });
      },
      sendUserMessage: (msg: string, opts?: Record<string, unknown>) => {
        wakeIdAtSend = h!.session.getMeta()?.stageExecutorRun?.pendingWakeId;
        h!.sent.push({ msg, opts });
      },
    };
    const res = await sendTrustedOwnerWake({
      pi: pi as never,
      session: h.session,
      config: h.config,
      run,
      status: "completed",
      issueWakeId: () => "wake-1",
    });
    // Full-shape assertion: on failure the diff carries `reason`, which is
    // the only honest way to diagnose environment-dependent regressions.
    expect(res).toEqual({ sent: true, wakeId: "wake-1" });
    // Ordering: the strict commit landed before the channel send.
    expect(wakeIdAtSend).toBe("wake-1");
    expect(h.session.getMeta()!.stageExecutorRun!.pendingWakeId).toBe("wake-1");

    // Message: trusted signature + id + structured detail (SDK-ignored extras).
    const msg = h.sent[0]!.msg;
    expect(msg.startsWith(`${OWNER_WAKE_SIGNATURE} wake-1`)).toBe(true);
    expect(h.sent[0]!.opts?.deliverAs).toBe("followUp");
    expect((h.sent[0]!.opts?.detail as Record<string, unknown>).runId).toBe("run-1");
    expect((h.sent[0]!.opts?.detail as Record<string, unknown>).wakeId).toBe("wake-1");

    // Local entry: the durable source evidence.
    expect(h.localEntries.length).toBe(1);
    const data = h.localEntries[0]!.data as Record<string, unknown>;
    expect(data.wakeId).toBe("wake-1");
    expect(data.stage).toBe("develop");
    expect(data.operationId).toBe("op-1");
  });

  it("exactly-once: an outstanding wake is never re-sent", async () => {
    h = makeHarness();
    const run = makeRun(undefined, { pendingWakeId: "wake-out" });
    seed(baseMeta({ stageExecutorRun: run }));

    const res = await sendTrustedOwnerWake({
      pi: { sendUserMessage: () => { h!.sent.push({ msg: "unexpected" }); }, appendEntry: () => {} } as never,
      session: h.session,
      config: h.config,
      run,
      status: "completed",
    });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe("wake_already_pending");
    expect(h.sent.length).toBe(0);
  });

  it("a consumed run never wakes again", async () => {
    h = makeHarness();
    const run = makeRun(undefined, { terminalConsumed: true });
    seed(baseMeta({ stageExecutorRun: run }));
    const res = await sendTrustedOwnerWake({
      pi: {} as never, session: h.session, config: h.config, run, status: "completed",
    });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe("already_consumed");
  });

  it("run superseded between terminal and wake → zero side effects", async () => {
    h = makeHarness();
    const staleRun = makeRun({ runId: "run-dead" });
    seed(baseMeta({ stageExecutorRun: makeRun({ runId: "run-current" }) }));
    const res = await sendTrustedOwnerWake({
      pi: {} as never, session: h.session, config: h.config, run: staleRun, status: "completed",
    });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe("run_superseded");
    expect(h.session.getMeta()!.stageExecutorRun!.pendingWakeId).toBeUndefined();
  });

  it("persist failure performs ZERO sends (wake only after a reliable commit)", async () => {
    h = makeHarness();
    const run = makeRun();
    seed(baseMeta({ stageExecutorRun: run }));
    h.breakAppend();
    const res = await sendTrustedOwnerWake({
      pi: { sendUserMessage: () => { h!.sent.push({ msg: "must-not-happen" }); }, appendEntry: () => {} } as never,
      session: h.session,
      config: h.config,
      run,
      status: "completed",
    });
    expect(res.sent).toBe(false);
    expect(res.reason).toContain("persist_failed");
    expect(h.sent.length).toBe(0);
  });

  it("send failure KEEPS the persisted wake (resumable) and never re-dispatches", async () => {
    h = makeHarness();
    const run = makeRun();
    seed(baseMeta({ stageExecutorRun: run }));
    h.failSend();
    const res = await sendTrustedOwnerWake({
      pi: {
        appendEntry: () => {},
        sendUserMessage: () => { throw new Error("transport down"); },
      } as never,
      session: h.session,
      config: h.config,
      run,
      status: "completed",
      issueWakeId: () => "wake-keep",
    });
    expect(res.sent).toBe(false);
    expect(res.wakeId).toBe("wake-keep");
    expect(res.reason).toBe("send_failed");
    // The resumable marker stays — the owner can still consume later;
    // NO executor dispatch happened anywhere (pi has no spawn at all).
    expect(h.session.getMeta()!.stageExecutorRun!.pendingWakeId).toBe("wake-keep");
  });

  it("a channel-less runtime persists the wake and reports unavailable", async () => {
    h = makeHarness();
    const run = makeRun();
    seed(baseMeta({ stageExecutorRun: run }));
    const res = await sendTrustedOwnerWake({
      pi: {} as never,
      session: h.session,
      config: h.config,
      run,
      status: "completed",
      issueWakeId: () => "wake-nochan",
    });
    expect(res.sent).toBe(false);
    expect(res.reason).toBe("channel_unavailable");
    expect(h.session.getMeta()!.stageExecutorRun!.pendingWakeId).toBe("wake-nochan");
  });
});

// ─── wake-turn recognition (settle gate source check) ───────────────────────

describe("194 Phase 3 (task 3): wake turn verification", () => {
  const wakeText = (id: string) => `${OWNER_WAKE_SIGNATURE} ${id}\nConsume now.`;

  it("extracts the wake id only from the trusted prefix", () => {
    expect(extractOwnerWakeId(wakeText("w-1"))).toBe("w-1");
    expect(extractOwnerWakeId("hello there")).toBeNull();
    // Mid-text mentions are NOT source evidence (prefix rule).
    expect(extractOwnerWakeId("please read pi-pipeline:owner-wake w-9 notes")).toBeNull();
    expect(extractOwnerWakeId(`${OWNER_WAKE_SIGNATURE}\nno id`)).toBeNull();
  });

  it("a marker matching the persisted pendingWakeId is a trusted turn", () => {
    const meta = baseMeta({ stageExecutorRun: makeRun(undefined, { pendingWakeId: "w-1" }) });
    const v = verifyOwnerWakeTurn(wakeText("w-1"), meta);
    expect(v).toEqual({ matched: true, trusted: true, wakeId: "w-1" });
  });

  it("a replayed wake (id consumed/cleared) is matched but NOT trusted", () => {
    const meta = baseMeta({ stageExecutorRun: makeRun() });
    const v = verifyOwnerWakeTurn(wakeText("w-old"), meta);
    expect(v.matched).toBe(true);
    expect(v.trusted).toBe(false);
  });

  it("a wake bound to a DIFFERENT run is not trusted either", () => {
    const meta = baseMeta({ stageExecutorRun: makeRun({ runId: "run-x" }, { pendingWakeId: "w-cur" }) });
    expect(verifyOwnerWakeTurn(wakeText("w-old"), meta).trusted).toBe(false);
  });

  it("no meta at all never trusts a wake", () => {
    expect(verifyOwnerWakeTurn(wakeText("w-1"), undefined).trusted).toBe(false);
  });
});

// ─── visible C5 waiting state (tool/smart skip) ─────────────────────────────

describe("194 Phase 3 (C5): record awaiting state before a skip", () => {
  it("persists awaiting-owner-tool on the current run", async () => {
    h = makeHarness();
    const run = makeRun({}, {
      status: "completed",
      declaration: { declarationId: "d-1", revision: 3, requestedBy: "pipeline_verify", verificationRequested: true },
    });
    seed(baseMeta({ stageExecutorRun: run }));

    const res = await recordAwaitingOwnerConsumption({ session: h.session, run, state: "awaiting-owner-tool" });
    expect(res.ok).toBe(true);
    const persisted = h.session.getMeta()!.stageExecutorRun!;
    expect(persisted.consumption?.state).toBe("awaiting-owner-tool");
    expect(persisted.consumption?.declarationRevision).toBe(3);
  });

  it("idempotent: the same waiting state re-recorded changes nothing", async () => {
    h = makeHarness();
    const run = makeRun({}, { consumption: { state: "awaiting-confirmation" } });
    seed(baseMeta({ stageExecutorRun: run }));
    const before = h.entries.length;
    const res = await recordAwaitingOwnerConsumption({ session: h.session, run, state: "awaiting-confirmation" });
    expect(res.ok).toBe(true);
    expect(h.entries.length).toBe(before);
  });

  it("a superseded run is refused", async () => {
    h = makeHarness();
    seed(baseMeta({ stageExecutorRun: makeRun({ runId: "run-current" }) }));
    const stale = makeRun({ runId: "run-dead" });
    const res = await recordAwaitingOwnerConsumption({ session: h.session, run: stale, state: "awaiting-owner-tool" });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("run_superseded");
  });

  it("a consumed run never re-opens a waiting state", async () => {
    h = makeHarness();
    const consumed = makeRun(undefined, { terminalConsumed: true });
    seed(baseMeta({ stageExecutorRun: consumed }));
    const res = await recordAwaitingOwnerConsumption({ session: h.session, run: consumed, state: "awaiting-confirmation" });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("already_consumed");
  });

  it("a commit conflict surfaces honestly and mutates nothing", async () => {
    h = makeHarness();
    const run = makeRun();
    seed(baseMeta({ stageExecutorRun: run }));
    h.breakAppend();
    const res = await recordAwaitingOwnerConsumption({ session: h.session, run, state: "awaiting-owner-tool" });
    expect(res.ok).toBe(false);
    expect(h.session.getMeta()!.stageExecutorRun!.consumption).toBeUndefined();
  });
});
