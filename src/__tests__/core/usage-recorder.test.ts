/**
 * 210 Phase 7 tests — `usage-recorder` (requirement 5.9, R2 record-only).
 *
 * Plan acceptance covered here:
 * - messages without `usage` (or non-assistant role) produce ZERO writes;
 * - `message_end` on a dormant session returns immediately;
 * - aggregated values grow monotonically per assistant message;
 * - flush is idempotent (an empty delta performs no meta write) and merges
 *   additively into `meta.usageByStage`;
 * - `attributionSuspect` boundary at exactly / within / beyond the 60s margin,
 *   consumed once per `stage_usage` render;
 * - restart / resume (pipeline-start builders) clear the in-process ledger.
 */

import { describe, it, expect } from "bun:test";
import {
  createUsageRecorder,
  flushUsageToMeta,
  resetUsage,
  takeStageUsageAuditFields,
  __usageSnapshot,
  parseUsageMessage,
  USAGE_ATTRIBUTION_MARGIN_MS,
} from "../../core/usage-recorder";
import { buildStartMeta, buildResumeMeta } from "../../commands/pipeline-start";
import { makeTestConfig, makeTestMeta } from "../helpers";
import type { PipelineStage, SessionMeta } from "../../types";

// ─── Harness ──────────────────────────────────────────────────────────────────

let seq = 0;
/** Unique pipelineId per case (the usage store is process-global). */
const nextPid = () => `pipe-210-rec-${Date.now()}-${++seq}`;

/** Shared-store style session: updateMeta mutates the SAME meta object. */
function makeSession(meta: SessionMeta) {
  const updates: Partial<SessionMeta>[] = [];
  return {
    meta,
    updates,
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        updates.push(patch);
        Object.assign(meta, patch);
        return meta;
      },
    },
  };
}

type Harness = ReturnType<typeof makeSession>;

/** Feed one raw `message_end` payload through the recorder hook. */
async function feed(h: Harness, message: unknown, stage?: PipelineStage): Promise<void> {
  if (stage) h.meta.currentStage = stage;
  const hook = createUsageRecorder();
  await (hook.handler as (ctx: unknown) => Promise<void>)({
    session: h.session,
    event: { message },
  });
}

/** A well-formed assistant usage message (exact-binary costs avoid float noise). */
function usageMsg(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    role: "assistant",
    model: "qwen3.8-flash",
    provider: "bailian",
    timestamp: Date.now(),
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, costUsd: 0.25 },
    ...overrides,
  };
}

// ─── parseUsageMessage filtering ──────────────────────────────────────────────

describe("210 Phase 7: parseUsageMessage", () => {
  it("returns null for non-assistant roles, missing usage and non-objects", () => {
    expect(parseUsageMessage({ role: "user", usage: { input: 5 } })).toBeNull();
    expect(parseUsageMessage({ role: "assistant" })).toBeNull();
    expect(parseUsageMessage({ role: "assistant", usage: null })).toBeNull();
    expect(parseUsageMessage("nope")).toBeNull();
    expect(parseUsageMessage(undefined)).toBeNull();
  });

  it("treats an all-zero usage block as no-information (null, no touch)", () => {
    expect(
      parseUsageMessage({ role: "assistant", usage: { input: 0, output: 0, costUsd: 0 } }),
    ).toBeNull();
  });

  it("accepts the pi-ai shape aliases (inputTokens, cost.usd)", () => {
    const p = parseUsageMessage({
      role: "assistant",
      model: "openai/gpt-4o",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cost: { usd: 0.5 } },
    });
    expect(p).not.toBeNull();
    expect(p!.input).toBe(10);
    expect(p!.output).toBe(4);
    expect(p!.costUsd).toBe(0.5);
    // "provider/model" convention fills the provider.
    expect(p!.provider).toBe("openai");
  });

  it("derives totalTokens from the components when absent", () => {
    const p = parseUsageMessage({
      role: "assistant",
      usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, costUsd: 0 },
    });
    expect(p!.totalTokens).toBe(13);
  });

  it("normalizes ISO timestamps and falls back to now", () => {
    const iso = "2026-10-01T10:00:00.000Z";
    expect(parseUsageMessage({ role: "assistant", timestamp: iso, usage: { input: 1 } })!.timestamp).toBe(
      Date.parse(iso),
    );
    const before = Date.now();
    const t = parseUsageMessage({ role: "assistant", usage: { input: 1 } })!.timestamp;
    expect(t).toBeGreaterThanOrEqual(before);
  });
});

// ─── In-process aggregation ───────────────────────────────────────────────────

describe("210 Phase 7: message_end aggregation", () => {
  it("aggregates assistant usage monotonically under pipelineId -> currentStage", async () => {
    const pid = nextPid();
    const h = makeSession(makeTestMeta({ pipelineId: pid, currentStage: "plan" }));

    await feed(h, usageMsg());
    let snap = __usageSnapshot(pid);
    expect(snap.plan).toEqual({
      provider: "bailian",
      model: "qwen3.8-flash",
      messages: 1,
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      costUsd: 0.25,
      updatedAt: expect.any(Number),
    });

    const first = snap.plan!.totalTokens;
    const ts2 = Date.now() + 1000;
    await feed(h, usageMsg({ timestamp: ts2, usage: { input: 200, output: 90, totalTokens: 290, costUsd: 0.5 } }));
    snap = __usageSnapshot(pid);
    expect(snap.plan!.messages).toBe(2);
    expect(snap.plan!.input).toBe(300);
    expect(snap.plan!.totalTokens).toBeGreaterThan(first);
    expect(snap.plan!.costUsd).toBe(0.75);
    expect(snap.plan!.updatedAt).toBe(ts2);

    resetUsage(pid);
  });

  it("separates stages when the pipeline advances mid-run", async () => {
    const pid = nextPid();
    const h = makeSession(makeTestMeta({ pipelineId: pid, currentStage: "plan" }));

    await feed(h, usageMsg());
    await feed(h, usageMsg(), "develop");

    const snap = __usageSnapshot(pid);
    expect(Object.keys(snap).sort()).toEqual(["develop", "plan"]);
    expect(snap.plan!.messages).toBe(1);
    expect(snap.develop!.messages).toBe(1);

    resetUsage(pid);
  });

  it("owner and child sessions sharing a pipelineId aggregate into one store", async () => {
    const pid = nextPid();
    const owner = makeSession(makeTestMeta({ pipelineId: pid, currentStage: "review" }));
    const child = makeSession(makeTestMeta({ pipelineId: pid, currentStage: "review" }));

    await feed(owner, usageMsg());
    await feed(child, usageMsg());

    const snap = __usageSnapshot(pid);
    expect(snap.review!.messages).toBe(2);
    expect(snap.review!.input).toBe(200);
    // Flush at the OWNER drains the shared delta; the child performs no writes.
    flushUsageToMeta(owner.session as any, pid);
    expect(owner.meta.usageByStage!.review!.messages).toBe(2);
    expect(child.updates.length).toBe(0);

    resetUsage(pid);
  });

  it("keeps the latest known model/provider across mixed messages", async () => {
    const pid = nextPid();
    const h = makeSession(makeTestMeta({ pipelineId: pid, currentStage: "plan" }));

    await feed(h, usageMsg({ model: "m1", provider: "p1" }));
    await feed(h, usageMsg({ model: "m2", provider: "p2" }));
    // An identity-less message must not clobber the known model.
    await feed(h, usageMsg({ model: "", provider: "" }));

    const snap = __usageSnapshot(pid);
    expect(snap.plan!.model).toBe("m2");
    expect(snap.plan!.provider).toBe("p2");

    resetUsage(pid);
  });

  it("dormant sessions and usage-less messages produce no writes at all", async () => {
    const aborted = nextPid();
    const hA = makeSession(makeTestMeta({ pipelineId: aborted, flowState: "aborted" as SessionMeta["flowState"] }));
    await feed(hA, usageMsg());
    expect(__usageSnapshot(aborted)).toEqual({});
    expect(hA.updates.length).toBe(0);

    const done = nextPid();
    const hC = makeSession(makeTestMeta({ pipelineId: done, currentStage: "completed" as PipelineStage }));
    await feed(hC, usageMsg());
    expect(__usageSnapshot(done)).toEqual({});

    const never = nextPid();
    const hN = makeSession(makeTestMeta({ pipelineId: "" }));
    await feed(hN, usageMsg());
    expect(hN.updates.length).toBe(0);

    const pid = nextPid();
    const hU = makeSession(makeTestMeta({ pipelineId: pid }));
    await feed(hU, { role: "assistant", content: [] }); // no usage block
    await feed(hU, { role: "user", usage: { input: 5 } }); // wrong role
    expect(__usageSnapshot(pid)).toEqual({});
    expect(hU.updates.length).toBe(0);
  });
});

// ─── flushUsageToMeta ─────────────────────────────────────────────────────────

describe("210 Phase 7: flushUsageToMeta", () => {
  it("drains once, then the second flush performs zero meta writes (idempotent)", async () => {
    const pid = nextPid();
    const h = makeSession(makeTestMeta({ pipelineId: pid, currentStage: "plan" }));
    await feed(h, usageMsg());

    flushUsageToMeta(h.session as any, pid);
    expect(h.updates.length).toBe(1);
    expect(h.meta.usageByStage!.plan!.messages).toBe(1);
    expect(__usageSnapshot(pid)).toEqual({});

    flushUsageToMeta(h.session as any, pid);
    expect(h.updates.length).toBe(1); // no second write

    resetUsage(pid);
  });

  it("merges additively into a pre-existing usageByStage snapshot", async () => {
    const pid = nextPid();
    const h = makeSession(
      makeTestMeta({
        pipelineId: pid,
        currentStage: "plan",
        usageByStage: {
          plan: {
            provider: "bailian",
            model: "qwen3.8-flash",
            messages: 5,
            input: 1000,
            output: 500,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1500,
            costUsd: 1,
            updatedAt: 1,
          },
        },
      }),
    );
    await feed(h, usageMsg());

    flushUsageToMeta(h.session as any, pid);
    const snap = h.meta.usageByStage!.plan!;
    expect(snap.messages).toBe(6);
    expect(snap.input).toBe(1100);
    expect(snap.totalTokens).toBe(1650);
    expect(snap.costUsd).toBe(1.25);

    resetUsage(pid);
  });

  it("never touches meta for a pipeline that recorded nothing", () => {
    const h = makeSession(makeTestMeta({ pipelineId: nextPid() }));
    flushUsageToMeta(h.session as any, h.meta.pipelineId);
    expect(h.updates.length).toBe(0);
  });
});

// ─── resetUsage ───────────────────────────────────────────────────────────────

describe("210 Phase 7: resetUsage", () => {
  it("drops the pending delta, the touched flag and the suspect ledger", async () => {
    const pid = nextPid();
    const stageStart = Date.now();
    const h = makeSession(makeTestMeta({ pipelineId: pid, currentStage: "plan", stageStartTime: stageStart }));
    // Beyond-margin sample -> touched + suspect flagged.
    await feed(h, usageMsg({ timestamp: stageStart - USAGE_ATTRIBUTION_MARGIN_MS - 1000 }));
    expect(Object.keys(__usageSnapshot(pid)).length).toBe(1);

    resetUsage(pid);

    expect(__usageSnapshot(pid)).toEqual({});
    expect(takeStageUsageAuditFields(h.session as any, pid, "plan")).toBeNull();
    expect(h.updates.length).toBe(0);
  });
});

// ─── attributionSuspect boundary ──────────────────────────────────────────────

describe("210 Phase 7: attributionSuspect (60s margin)", () => {
  async function probe(tsOffset: number): Promise<Record<string, string> | null> {
    const pid = nextPid();
    const stageStart = Date.now();
    const h = makeSession(makeTestMeta({ pipelineId: pid, currentStage: "plan", stageStartTime: stageStart }));
    await feed(h, usageMsg({ timestamp: stageStart + tsOffset }));
    const fields = takeStageUsageAuditFields(h.session as any, pid, "plan");
    resetUsage(pid);
    return fields;
  }

  it("exactly at stageStart - 60s is NOT suspect (strict less-than)", async () => {
    const f = await probe(-USAGE_ATTRIBUTION_MARGIN_MS);
    expect(f!.attributionSuspect).toBe("false");
  });

  it("inside the margin (61s before entry) IS suspect and the sample is still counted", async () => {
    const f = await probe(-USAGE_ATTRIBUTION_MARGIN_MS - 1);
    expect(f!.attributionSuspect).toBe("true");
    // Never dropped: the flagged sample contributes to the totals.
    expect(f!.inputTokens).toBe("100");
    expect(f!.messages).toBe("1");
  });

  it("a recent tail message (30s before entry) is NOT suspect", async () => {
    const f = await probe(-30_000);
    expect(f!.attributionSuspect).toBe("false");
  });

  it("the flag survives a flush drain and is consumed by exactly one take", async () => {
    const pid = nextPid();
    const stageStart = Date.now();
    const h = makeSession(makeTestMeta({ pipelineId: pid, currentStage: "plan", stageStartTime: stageStart }));
    await feed(h, usageMsg({ timestamp: stageStart - USAGE_ATTRIBUTION_MARGIN_MS - 5000 }));

    // Intermediate settle-flush drains the DELTA but must not lose the flag.
    flushUsageToMeta(h.session as any, pid);
    expect(__usageSnapshot(pid)).toEqual({});

    const first = takeStageUsageAuditFields(h.session as any, pid, "plan");
    expect(first!.attributionSuspect).toBe("true");
    const second = takeStageUsageAuditFields(h.session as any, pid, "plan");
    expect(second!.attributionSuspect).toBe("false"); // consumed once

    resetUsage(pid);
  });
});

// ─── takeStageUsageAuditFields ────────────────────────────────────────────────

describe("210 Phase 7: takeStageUsageAuditFields", () => {
  it("returns null (and writes nothing) for a pipeline that never recorded usage", () => {
    const h = makeSession(makeTestMeta({ pipelineId: nextPid() }));
    expect(takeStageUsageAuditFields(h.session as any, h.meta.pipelineId, "plan")).toBeNull();
    expect(h.updates.length).toBe(0);
  });

  it("renders the exiting stage snapshot as flat k=v fields with the stage override", async () => {
    const pid = nextPid();
    const h = makeSession(makeTestMeta({ pipelineId: pid, currentStage: "review" }));
    await feed(h, usageMsg());
    await feed(h, usageMsg({ usage: { input: 20, output: 10, totalTokens: 30, costUsd: 0.5 } }));

    const f = takeStageUsageAuditFields(h.session as any, pid, "review");
    expect(f).not.toBeNull();
    expect(Object.keys(f!).sort()).toEqual([
      "attributionSuspect",
      "cacheRead",
      "cacheWrite",
      "costUsd",
      "inputTokens",
      "messages",
      "model",
      "outputTokens",
      "provider",
      "stage",
      "totalTokens",
    ]);
    expect(f!.stage).toBe("review");
    expect(f!.model).toBe("qwen3.8-flash");
    expect(f!.provider).toBe("bailian");
    expect(f!.messages).toBe("2");
    expect(f!.inputTokens).toBe("120");
    expect(f!.outputTokens).toBe("60");
    expect(f!.totalTokens).toBe("180");
    expect(f!.costUsd).toBe("0.75");
    expect(f!.attributionSuspect).toBe("false");

    resetUsage(pid);
  });

  it("reports the CUMULATIVE exiting-stage snapshot across repeated takes", async () => {
    const pid = nextPid();
    const h = makeSession(makeTestMeta({ pipelineId: pid, currentStage: "plan" }));
    await feed(h, usageMsg());
    const f1 = takeStageUsageAuditFields(h.session as any, pid, "plan");
    expect(f1!.messages).toBe("1");

    // Same stage re-entered (a later visit) — new delta on top of meta history.
    await feed(h, usageMsg());
    const f2 = takeStageUsageAuditFields(h.session as any, pid, "plan");
    expect(f2!.messages).toBe("2");
    expect(h.meta.usageByStage!.plan!.messages).toBe(2);

    resetUsage(pid);
  });

  it("emits a zero-filled snapshot for a stage the pipeline touched but said nothing in", async () => {
    const pid = nextPid();
    const h = makeSession(makeTestMeta({ pipelineId: pid, currentStage: "plan" }));
    await feed(h, usageMsg(), "develop"); // touched, but NOTHING recorded under plan

    const f = takeStageUsageAuditFields(h.session as any, pid, "plan");
    expect(f).not.toBeNull(); // pipeline-level gate is per-pipeline, not per-stage
    expect(f!.stage).toBe("plan");
    expect(f!.model).toBe("unknown");
    expect(f!.messages).toBe("0");
    expect(f!.totalTokens).toBe("0");
    expect(f!.costUsd).toBe("0");

    resetUsage(pid);
  });
});

// ─── New-period clear via pipeline-start builders ─────────────────────────────

describe("210 Phase 7: pipeline-start builders clear the ledger", () => {
  const config = makeTestConfig();

  it("buildStartMeta drops the superseded pipeline's in-process usage", async () => {
    const oldPid = nextPid();
    const oldMeta = makeTestMeta({ pipelineId: oldPid, currentStage: "plan" });
    const h = makeSession(oldMeta);
    await feed(h, usageMsg());
    expect(Object.keys(__usageSnapshot(oldPid)).length).toBe(1);

    const { newMeta } = buildStartMeta(oldMeta, config, "docs/design/Req.md");
    expect(Object.keys(__usageSnapshot(oldPid))).toHaveLength(0);
    expect(newMeta.usageByStage).toBeUndefined();
    // The NEW pipeline starts untouched: take renders null (silent baseline).
    expect(takeStageUsageAuditFields(h.session as any, newMeta.pipelineId, "clarify")).toBeNull();
  });

  it("buildResumeMeta clears the SAME pipelineId's pending accumulator", async () => {
    const pid = nextPid();
    const meta = makeTestMeta({ pipelineId: pid, currentStage: "develop" });
    const h = makeSession(meta);
    await feed(h, usageMsg());

    const resumed = buildResumeMeta(meta, config);
    expect(resumed.pipelineId).toBe(pid);
    expect(resumed.usageByStage).toBeUndefined();
    expect(__usageSnapshot(pid)).toEqual({});
    // Pending delta is gone — no meta write may resurrect it.
    const before = h.updates.length;
    flushUsageToMeta(h.session as any, pid);
    expect(h.updates.length).toBe(before);
  });
});
