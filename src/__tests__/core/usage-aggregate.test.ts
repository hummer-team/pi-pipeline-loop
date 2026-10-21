/**
 * 210 Phase 7 tests — usage aggregate contract, `stage_usage` audit emission
 * and the terminal status-view Cost/Models lines (requirement 5.9 / task 4).
 *
 * Plan acceptance covered here:
 * - `collectRunAggregate` adds `costUsdTotal` (sum of per-stage costs, 1e-6
 *   tolerance) and `modelsByStage` (`stage:model` comma-joined);
 * - exactly ONE `stage_usage` audit line per tool-path stage exit, carrying
 *   the exiting stage's cumulative snapshot;
 * - pipelines that never recorded usage emit NO `stage_usage` line (baseline
 *   synthetic contexts stay byte-identical);
 * - terminal `pipeline_completed` / `pipeline_session_aborted` carry the two
 *   new aggregate keys;
 * - `/pipeline-status` Last Run view shows `Cost` and `Models` (N/A-safe).
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRunAggregate } from "../../core/stage-evidence";
import { createUsageRecorder, resetUsage } from "../../core/usage-recorder";
import { createStageAdvancer } from "../../core/stage-advancer";
import { markPipelineAborted } from "../../core/flow-state";
import { createPipelineStatusCommand } from "../../commands/pipeline-status";
import { initAuditLog, __setSafeWriteAuditLogOverride } from "../../utils/auditLog";
import { makeTestConfig, makeTestMeta, auditLogFileFor } from "../helpers";
import type { PipelineStage, SessionMeta, StageUsageSnapshot } from "../../types";

// ─── Harness (shared style with audit-enrichment.test.ts) ─────────────────────

let seq = 0;
const nextPid = () => `pipe-210-agg-${Date.now()}-${++seq}`;

function makeCtx(meta: SessionMeta) {
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (patch: Partial<SessionMeta>) => {
        Object.assign(meta, patch);
        return meta;
      },
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      transition: () => {},
      select: async () => undefined,
    },
    pi: { sendUserMessage: () => {} },
    _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
  };
}

async function setupRoot(label: string): Promise<string> {
  const root = join(tmpdir(), `pi-210-agg-${label}-${Date.now()}-${seq}`);
  await mkdir(join(root, ".pi", "audit"), { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: root }));
  return root;
}

async function readAudit(root: string, pipelineId: string): Promise<string> {
  return readFile(auditLogFileFor(join(root, ".pi", "audit"), pipelineId), "utf-8");
}

/** All field maps for the given event, in file order (one entry per line). */
function allAuditFields(content: string, event: string): Record<string, string>[] {
  const re = new RegExp(`\\] ${event} \\|`);
  return content
    .split("\n")
    .filter((l) => re.test(l))
    .map((line) => {
      const out: Record<string, string> = {};
      for (const part of line.split(" | ").slice(1)) {
        const i = part.indexOf("=");
        if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
      }
      return out;
    });
}

/** Feed one assistant usage message through the real recorder hook. */
async function feedUsage(
  ctx: ReturnType<typeof makeCtx>,
  usage: { input: number; output: number; totalTokens: number; costUsd: number },
  model = "qwen3.8-flash",
  timestamp = Date.now(),
): Promise<void> {
  const hook = createUsageRecorder();
  await (hook.handler as (c: unknown) => Promise<void>)({
    session: ctx.session,
    event: {
      message: { role: "assistant", model, provider: "bailian", timestamp, usage },
    },
  });
}

function snap(overrides: Partial<StageUsageSnapshot>): StageUsageSnapshot {
  return {
    provider: "bailian",
    model: "unknown",
    messages: 1,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    updatedAt: 1,
    ...overrides,
  };
}

// ─── collectRunAggregate usage keys ───────────────────────────────────────────

describe("210 Phase 7: collectRunAggregate usage roll-up", () => {
  it("costUsdTotal equals the per-stage sum (1e-6 tolerance) and modelsByStage joins stage:model", async () => {
    const root = await setupRoot("aggregate-keys");
    const config = makeTestConfig({ projectRoot: root });
    const meta = makeTestMeta({
      pipelineId: nextPid(),
      currentStage: "completed" as PipelineStage,
      requirementDoc: undefined,
      usageByStage: {
        plan: snap({ model: "m-plan", costUsd: 0.25, totalTokens: 100 }),
        develop: snap({ model: "m-dev", costUsd: 0.5, totalTokens: 200 }),
        review: snap({ model: "m-rev", costUsd: 0.125, totalTokens: 50 }),
      },
    });

    const agg = await collectRunAggregate(meta, "completed" as PipelineStage, meta.stageStartTime ?? 0);
    expect(Number(agg.costUsdTotal)).toBeCloseTo(0.875, 6);
    expect(agg.modelsByStage).toBe("plan:m-plan,develop:m-dev,review:m-rev");

    await rm(root, { recursive: true, force: true });
  });

  it("a run without usage reports costUsdTotal 0 and an empty modelsByStage", async () => {
    const root = await setupRoot("aggregate-empty");
    const config = makeTestConfig({ projectRoot: root });
    const meta = makeTestMeta({ pipelineId: nextPid() });

    const agg = await collectRunAggregate(meta, "develop", meta.stageStartTime ?? 0);
    expect(agg.costUsdTotal).toBe("0");
    expect(agg.modelsByStage).toBe("");

    await rm(root, { recursive: true, force: true });
  });
});

// ─── stage_usage on the tool-path stage exit ──────────────────────────────────

describe("210 Phase 7: stage_usage audit at the tool-path exit", () => {
  it("records usage then advances: EXACTLY ONE stage_usage with the cumulative snapshot", async () => {
    const root = await setupRoot("tool-usage");
    const config = makeTestConfig({ projectRoot: root });
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: nextPid(),
      requirementDoc: "docs/design/Req.md",
      stageStartTime: Date.now() - 1500,
      summaries: {},
    });
    const ctx = makeCtx(meta);

    await feedUsage(ctx, { input: 100, output: 50, totalTokens: 150, costUsd: 0.25 });
    await feedUsage(ctx, { input: 20, output: 10, totalTokens: 30, costUsd: 0.5 });

    const tool = createStageAdvancer(config);
    const result = (await tool.execute({}, ctx as any)) as { success: boolean };
    expect(result.success).toBe(true);

    const content = await readAudit(root, meta.pipelineId);
    const usageLines = allAuditFields(content, "stage_usage");
    expect(usageLines).toHaveLength(1); // exactly one per exit

    const f = usageLines[0];
    expect(f.stage).toBe("develop");
    expect(f.model).toBe("qwen3.8-flash");
    expect(f.provider).toBe("bailian");
    expect(f.messages).toBe("2");
    expect(f.inputTokens).toBe("120");
    expect(f.outputTokens).toBe("60");
    expect(f.totalTokens).toBe("180");
    expect(f.costUsd).toBe("0.75");
    expect(f.attributionSuspect).toBe("false");

    // Exit also drained the ledger into meta (flush point).
    expect(meta.usageByStage?.develop?.messages).toBe(2);

    resetUsage(meta.pipelineId);
    await rm(root, { recursive: true, force: true });
  });

  it("pipeline_completed carries costUsdTotal/modelsByStage incl. the final flushed stage", async () => {
    const root = await setupRoot("tool-completed-usage");
    const config = makeTestConfig({ projectRoot: root });
    const meta = makeTestMeta({
      currentStage: "awaiting_human",
      pipelineId: nextPid(),
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now() - 1200,
      pipelineStartedAt: Date.now() - 90_000,
      stageVisitOrder: ["plan", "awaiting_human"],
      usageByStage: { plan: snap({ model: "m-plan", costUsd: 0.25, totalTokens: 100 }) },
      summaries: {},
    });
    const ctx = makeCtx(meta);

    await feedUsage(ctx, { input: 8, output: 2, totalTokens: 10, costUsd: 0.5 });

    const tool = createStageAdvancer(config);
    const result = (await tool.execute({}, ctx as any)) as { success: boolean };
    expect(result.success).toBe(true);

    const content = await readAudit(root, meta.pipelineId);
    const done = allAuditFields(content, "pipeline_completed")[0];
    expect(Number(done.costUsdTotal)).toBeCloseTo(0.75, 6); // 0.25 meta + 0.5 flushed
    expect(done.modelsByStage).toBe("plan:m-plan,awaiting_human:qwen3.8-flash");

    // The completed exit is also a stage exit — exactly one stage_usage.
    expect(allAuditFields(content, "stage_usage")).toHaveLength(1);
    expect(allAuditFields(content, "stage_usage")[0].stage).toBe("awaiting_human");

    resetUsage(meta.pipelineId);
    await rm(root, { recursive: true, force: true });
  });

  it("a pipeline that never recorded usage emits NO stage_usage line (baseline silence)", async () => {
    const root = await setupRoot("tool-no-usage");
    const config = makeTestConfig({ projectRoot: root });
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: nextPid(),
      requirementDoc: "docs/design/Req.md",
      stageStartTime: Date.now() - 1500,
      summaries: {},
    });
    const ctx = makeCtx(meta);

    const tool = createStageAdvancer(config);
    await tool.execute({}, ctx as any);

    const content = await readAudit(root, meta.pipelineId);
    expect(content).not.toContain("stage_usage");
    expect(allAuditFields(content, "stage_advance")).toHaveLength(1); // exit itself unchanged
    expect(meta.usageByStage).toBeUndefined();

    await rm(root, { recursive: true, force: true });
  });
});

// ─── terminal/abort aggregate keys via the real paths ─────────────────────────

describe("210 Phase 7: pipeline_session_aborted usage keys", () => {
  afterEach(() => {
    __setSafeWriteAuditLogOverride(null);
  });

  it("aborted audit carries costUsdTotal/modelsByStage from the settled usage (no stage_usage on abort)", async () => {
    const events: Array<{ event: string; message?: Record<string, string | boolean> }> = [];
    __setSafeWriteAuditLogOverride(async (event, message) => {
      events.push({ event, message: message as Record<string, string | boolean> });
    });

    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: nextPid(),
      requirementDoc: "docs/design/77_Config.md",
      stageStartTime: Date.now() - 1000,
      pipelineStartedAt: Date.now() - 70_000,
      usageByStage: { develop: snap({ model: "m-dev", costUsd: 1.5, totalTokens: 999 }) },
      summaries: {},
    });
    const ctx = makeCtx(meta);

    // Pending in-process usage must be drained BEFORE the aggregate is read.
    await feedUsage(ctx, { input: 1, output: 1, totalTokens: 2, costUsd: 0.25 });

    await markPipelineAborted(ctx as any, "session_quit");

    const rec = events.find((e) => e.event === "pipeline_session_aborted");
    expect(rec).toBeDefined();
    expect(Number(rec!.message!.costUsdTotal)).toBeCloseTo(1.75, 6);
    // Flush identity rule: the latest recorded message's model wins the stage.
    expect(rec!.message!.modelsByStage).toBe("develop:qwen3.8-flash");
    expect(meta.usageByStage?.develop?.totalTokens).toBe(1001); // 999 flushed-in + 2
    // The abort path persists usage but renders no stage_usage event.
    expect(events.some((e) => e.event === "stage_usage")).toBe(false);

    resetUsage(meta.pipelineId);
  });
});

// ─── Status view Cost / Models lines ─────────────────────────────────────────

describe("210 Phase 7: /pipeline-status terminal view usage lines", () => {
  async function statusContent(config: ReturnType<typeof makeTestConfig>, meta: SessionMeta): Promise<string> {
    const cmd = createPipelineStatusCommand(config);
    const ctx = { session: { getMeta: () => meta } };
    const result = (await cmd.execute({}, ctx as any)) as { success: boolean; content: string };
    expect(result.success).toBe(true);
    return result.content;
  }

  function lineValue(content: string, label: string): string {
    const line = content.split("\n").find((l) => l.startsWith(`- ${label}:`));
    return line ? line.slice(label.length + 3).trim() : "";
  }

  it("shows Cost and Models rolled up from usageByStage", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "completed" as PipelineStage,
      pipelineId: nextPid(),
      flowState: "completed" as SessionMeta["flowState"],
      usageByStage: {
        plan: snap({ model: "m1", costUsd: 0.25, totalTokens: 200 }),
        review: snap({ model: "m2", costUsd: 0.5, totalTokens: 100 }),
      },
    });

    const content = await statusContent(config, meta);
    expect(lineValue(content, "Cost")).toBe("0.75 usd (totalTokens 300)");
    expect(lineValue(content, "Models")).toBe("plan:m1, review:m2");
    expect(content).not.toContain("undefined");
  });

  it("an empty usage ledger degrades to N/A, never undefined", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      pipelineId: nextPid(),
      flowState: "aborted" as SessionMeta["flowState"],
      terminateReason: "session_quit",
    });

    const content = await statusContent(config, meta);
    expect(content).toContain("## Last Run (terminal)");
    expect(lineValue(content, "Cost")).toBe("N/A");
    expect(lineValue(content, "Models")).toBe("N/A");
    expect(content).not.toContain("undefined");
  });
});
