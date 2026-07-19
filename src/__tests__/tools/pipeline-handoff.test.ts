import { describe, it, expect, beforeAll } from "bun:test";
import { createPipelineHandoff } from "../../tools/pipeline-handoff";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createCtx(meta: any) {
  const updates: any[] = [];
  return {
    session: {
      getMetadata: () => meta,
      updateMetadata: (m: any) => {
        updates.push(m);
        Object.assign(meta, m);
      },
      setModel: async (_model: string) => {},
    },
    updates,
  };
}

describe("createPipelineHandoff", () => {
  it("creates a tool named 'pipeline_handoff'", () => {
    const tool = createPipelineHandoff(makeTestConfig());
    expect(tool.name).toBe("pipeline_handoff");
  });

  it("returns error when no session context", async () => {
    const tool = createPipelineHandoff(makeTestConfig());
    const result = await tool.execute({});
    expect(result).toEqual({ error: "No session context available" });
  });

  it("blocks handoff when current stage summary is not validated", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "design", summaries: {} });
    const ctx = createCtx(meta);

    const tool = createPipelineHandoff(config);
    const result = (await tool.execute({ nextStage: "plan" }, ctx as any)) as any;

    expect(result.error).toContain("Cannot handoff");
  });

  it("blocks handoff when summary status is pending", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "design",
      summaries: { design: { path: "/tmp/design.md", hash: "abc", status: "pending" as const } },
    });
    const ctx = createCtx(meta);

    const tool = createPipelineHandoff(config);
    const result = (await tool.execute({ nextStage: "plan" }, ctx as any)) as any;

    expect(result.error).toContain("Cannot handoff");
  });

  it("performs handoff when summary is validated", async () => {
    const TMP = join(tmpdir(), "pi-handoff-valid-" + Date.now());
    await mkdir(TMP, { recursive: true });

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["plan"] = { ...config.stages["plan"], model: "claude" } as any;
    const meta = makeTestMeta({
      currentStage: "design",
      summaries: { design: { path: join(TMP, "design.md"), hash: "xyz", status: "valid" as const } },
    });
    const ctx = createCtx(meta);

    const tool = createPipelineHandoff(config);
    const result = (await tool.execute({ nextStage: "plan", note: "ready" }, ctx as any)) as any;

    expect(result.success).toBe(true);
    expect(result.message).toContain("Switched to");
  });

  it("updates metadata with stage transition and resets counters", async () => {
    const TMP = join(tmpdir(), "pi-handoff-meta-" + Date.now());
    await mkdir(TMP, { recursive: true });

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["plan"] = { ...config.stages["plan"], model: "claude" } as any;
    const meta = makeTestMeta({
      currentStage: "design",
      loopCount: 3,
      currentStepIndex: 5,
      summaries: { design: { path: join(TMP, "design.md"), hash: "xyz", status: "valid" as const } },
    });
    const ctx = createCtx(meta);

    const tool = createPipelineHandoff(config);
    await tool.execute({ nextStage: "plan" }, ctx as any);

    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.currentStage).toBe("plan");
    expect(lastUpdate.previousStage).toBe("design");
    expect(lastUpdate.loopCount).toBe(0);
    expect(lastUpdate.currentStepIndex).toBe(0);
  });

  it("writes audit log for handoff", async () => {
    const TMP = join(tmpdir(), "pi-handoff-audit-" + Date.now());
    await mkdir(TMP, { recursive: true });

    const config = makeTestConfig({ projectRoot: TMP });
    config.stages["plan"] = { ...config.stages["plan"], model: "gpt-4o" } as any;
    const meta = makeTestMeta({
      currentStage: "design",
      summaries: { design: { path: join(TMP, "design.md"), hash: "xyz", status: "valid" as const } },
    });
    const ctx = createCtx(meta);

    const tool = createPipelineHandoff(config);
    await tool.execute({ nextStage: "plan", note: "All tests pass" }, ctx as any);

    const logPath = join(TMP, ".pi", "audit", "audit.log");
    const logContent = await readFile(logPath, "utf-8");
    const entry = JSON.parse(logContent.trim().split("\n")[0]);

    expect(entry.action).toBe("handoff");
    expect(entry.from).toBe("design");
    expect(entry.to).toBe("plan");
    expect(entry.model).toBe("gpt-4o");
    expect(entry.summaryHash).toBe("xyz");
    expect(entry.note).toBe("All tests pass");
  });

  it("returns error for unknown next stage", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "design",
      summaries: { design: { path: "/tmp/design.md", hash: "xyz", status: "valid" as const } },
    });
    const ctx = createCtx(meta);

    const tool = createPipelineHandoff(config);
    const result = (await tool.execute({ nextStage: "nonexistent" }, ctx as any)) as any;

    expect(result.error).toContain("Unknown stage");
  });
});
