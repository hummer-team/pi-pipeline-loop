import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { createAgentSettled } from "../../core/agent-settled";
import { makeTestConfig, makeTestMeta, createMockCtx, deployDispatchAssets } from "../helpers";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuditLog } from "../../utils/auditLog";
import type { SessionMeta, PipelineStage } from "../../types";
import { auditLogFileFor } from "../helpers";

const TMP = join(tmpdir(), "pi-pipeline-probe-deferral-" + Date.now());
const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
  const config = makeTestConfig({ projectRoot: TMP });
  await initAuditLog(config);
  deployDispatchAssets(config);
});

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true });
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL];
});

function makeReservedEntry(stage: PipelineStage): SessionMeta["activeSpawns"] {
  return {
    [stage]: {
      agentName: "test-agent",
      reserved: true,
      startedAt: Date.now(),
    },
  };
}

async function readAuditEntries(projectRoot: string, pipelineId?: string): Promise<string[]> {
  const logPath = auditLogFileFor(join(projectRoot, ".pi", "audit"), pipelineId);
  try {
    const content = await readFile(logPath, "utf-8");
    return content.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("agent-settled probe deferral cap (Phase 8)", () => {
  it("reserved×2 → probe_gave_up_after_delay exactly once with count 2, falls through", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const stage: PipelineStage = "develop";
    const pipelineId = "pipe-deferral-cap-001";

    let meta = makeTestMeta({
      currentStage: stage,
      pipelineId,
      activeSpawns: makeReservedEntry(stage),
    });
    let ctx = createMockCtx(meta);
    const hook = createAgentSettled(config);

    await hook.handler(ctx as any);

    let entries = await readAuditEntries(TMP);
    let deferredEntry = entries.find(
      (e) => e.includes("advance_deferred_stage_agent_live") && e.includes(pipelineId),
    );
    expect(deferredEntry).toBeDefined();
    expect(deferredEntry).toContain("deferralCount");
    expect(deferredEntry).toContain("deferralCount=1");

    let updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.probeDeferralCount).toBe(1);
    expect(updatedMeta.probeDeferralStage).toBe(stage);

    meta = updatedMeta;
    meta.activeSpawns = makeReservedEntry(stage);
    ctx = createMockCtx(meta);

    await hook.handler(ctx as any);

    entries = await readAuditEntries(TMP);
    const gaveUpEntries = entries.filter(
      (e) => e.includes("probe_gave_up_after_delay") && e.includes(pipelineId),
    );
    expect(gaveUpEntries.length).toBe(1);

    const gaveUpEntry = gaveUpEntries[0];
    expect(gaveUpEntry).toContain("deferralCount=2");

    updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.probeDeferralCount).toBe(0);
    expect(updatedMeta.probeDeferralStage).toBeUndefined();
    expect(updatedMeta.dispatchedProbeDeferrals).toBeDefined();
    expect(updatedMeta.dispatchedProbeDeferrals![`${pipelineId}:${stage}`]).toBeDefined();
  });

  it("positive evidence (manual_live_probe) ×3 → all deferred, no gave_up, count stays undefined", async () => {
    (globalThis as Record<symbol, unknown>)[MANAGER_SYMBOL] = {
      listRecords: () => [{ name: "test-agent", status: "running", id: "fake-agent-live-001" }],
    };

    const config = makeTestConfig({ projectRoot: TMP });
    const stage: PipelineStage = "develop";
    const pipelineId = "pipe-positive-evidence-001";

    let meta = makeTestMeta({
      currentStage: stage,
      pipelineId,
    });
    let ctx = createMockCtx(meta);
    const hook = createAgentSettled(config);

    for (let i = 0; i < 3; i++) {
      meta = ctx.session.getMeta();
      ctx = createMockCtx(meta);
      await hook.handler(ctx as any);
    }

    const entries = await readAuditEntries(TMP, pipelineId);
    const gaveUpEntries = entries.filter(
      (e) => e.includes("probe_gave_up_after_delay") && e.includes(pipelineId),
    );
    expect(gaveUpEntries.length).toBe(0);

    const deferredEntries = entries.filter(
      (e) => e.includes("advance_deferred_stage_agent_live") && e.includes(pipelineId),
    );
    expect(deferredEntries.length).toBeGreaterThanOrEqual(3);

    for (const entry of deferredEntries.slice(-3)) {
      expect(entry).not.toContain("deferralCount");
    }

    const updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.probeDeferralCount).toBeUndefined();
    expect(updatedMeta.probeDeferralStage).toBeUndefined();
  });

  it("reserved then stage change then reserved → count resets from 1 (no gave_up)", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const stage1: PipelineStage = "develop";
    const stage2: PipelineStage = "review";
    const pipelineId = "pipe-stage-change-001";

    let meta = makeTestMeta({
      currentStage: stage1,
      pipelineId,
      activeSpawns: makeReservedEntry(stage1),
    });
    let ctx = createMockCtx(meta);
    const hook = createAgentSettled(config);

    await hook.handler(ctx as any);

    let updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.probeDeferralCount).toBe(1);
    expect(updatedMeta.probeDeferralStage).toBe(stage1);

    meta = { ...updatedMeta, currentStage: stage2 };
    meta.activeSpawns = makeReservedEntry(stage2);
    ctx = createMockCtx(meta);

    await hook.handler(ctx as any);

    updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.probeDeferralCount).toBe(1);
    expect(updatedMeta.probeDeferralStage).toBe(stage2);

    const entries = await readAuditEntries(TMP, pipelineId);
    const gaveUpEntries = entries.filter(
      (e) => e.includes("probe_gave_up_after_delay") && e.includes(pipelineId),
    );
    expect(gaveUpEntries.length).toBe(0);
  });

  it("after gave_up, reserved×2 → replay_skipped, no double gave_up", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const stage: PipelineStage = "develop";
    const pipelineId = "pipe-replay-dedup-001";

    let meta = makeTestMeta({
      currentStage: stage,
      pipelineId,
      activeSpawns: makeReservedEntry(stage),
    });
    let ctx = createMockCtx(meta);
    const hook = createAgentSettled(config);

    await hook.handler(ctx as any);
    meta = ctx.session.getMeta();
    meta.activeSpawns = makeReservedEntry(stage);
    ctx = createMockCtx(meta);
    await hook.handler(ctx as any);

    meta = ctx.session.getMeta();
    meta.activeSpawns = makeReservedEntry(stage);
    ctx = createMockCtx(meta);
    await hook.handler(ctx as any);

    meta = ctx.session.getMeta();
    meta.activeSpawns = makeReservedEntry(stage);
    ctx = createMockCtx(meta);
    await hook.handler(ctx as any);

    const entries = await readAuditEntries(TMP, pipelineId);
    const gaveUpEntries = entries.filter(
      (e) => e.includes("probe_gave_up_after_delay") && e.includes(pipelineId),
    );
    expect(gaveUpEntries.length).toBe(1);

    const replayEntries = entries.filter(
      (e) => e.includes("agent_settled_owner_wake_replay_skipped") && e.includes(pipelineId),
    );
    expect(replayEntries.length).toBe(1);

    const updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.probeDeferralCount).toBe(0);
  });

  it("no liveEvidence → counter reset to undefined", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const stage: PipelineStage = "develop";
    const pipelineId = "pipe-no-evidence-001";

    const meta = makeTestMeta({
      currentStage: stage,
      pipelineId,
      probeDeferralCount: 1,
      probeDeferralStage: stage,
    });
    const ctx = createMockCtx(meta);
    const hook = createAgentSettled(config);

    await hook.handler(ctx as any);

    const updatedMeta = ctx.session.getMeta();
    expect(updatedMeta.probeDeferralCount).toBeUndefined();
    expect(updatedMeta.probeDeferralStage).toBeUndefined();
  });
});
