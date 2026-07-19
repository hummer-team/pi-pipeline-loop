import { describe, it, expect, beforeAll } from "bun:test";
import { createGenerateSummary } from "../../tools/generate-summary";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = join(tmpdir(), "pi-pipeline-gen-summary-" + Date.now());

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
});

function createCtx(meta: any) {
  const updates: any[] = [];
  return {
    session: {
      getMetadata: () => meta,
      updateMetadata: (m: any) => {
        updates.push(m);
        Object.assign(meta, m);
      },
    },
    updates,
  };
}

describe("createGenerateSummary", () => {
  it("creates a tool named 'generate_stage_summary'", () => {
    const tool = createGenerateSummary(makeTestConfig());
    expect(tool.name).toBe("generate_stage_summary");
  });

  it("returns error when no session context", async () => {
    const tool = createGenerateSummary(makeTestConfig());
    const result = await tool.execute({});
    expect(result).toEqual({ error: "No session context available" });
  });

  it("generates summary with frontmatter and body", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ currentStage: "design", pipelineId: "pipe-gen-1" });
    const ctx = createCtx(meta);

    const tool = createGenerateSummary(config);
    const result = (await tool.execute({
      coreContent: "Core output",
      constraints: ["constraint 1"],
      pendingItems: ["pending 1"],
      referenceFiles: ["file1.ts"],
    }, ctx as any)) as any;

    expect(result.success).toBe(true);
    expect(result.summaryPath).toContain("design.md");
    expect(typeof result.hash).toBe("string");
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("includes generated_by_model: true in frontmatter", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ pipelineId: "pipe-gbm-1" });
    const ctx = createCtx(meta);

    const tool = createGenerateSummary(config);
    await tool.execute({
      coreContent: "test",
      constraints: [],
      pendingItems: [],
      referenceFiles: [],
    }, ctx as any);

    const summaryPath = join(TMP, ".pi", "audit", "pipe-gbm-1", "develop.md");
    const content = await readFile(summaryPath, "utf-8");
    const fmMatch = content.match(/---\n([\s\S]*?)\n---/);
    const fm = JSON.parse(fmMatch![1]);
    expect(fm.generated_by_model).toBe(true);
  });

  it("updates session metadata with summary reference", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ pipelineId: "pipe-meta-1" });
    const ctx = createCtx(meta);

    const tool = createGenerateSummary(config);
    await tool.execute({
      coreContent: "test",
      constraints: [],
      pendingItems: [],
      referenceFiles: [],
    }, ctx as any);

    const lastUpdate = ctx.updates[ctx.updates.length - 1];
    expect(lastUpdate.summaries.develop).toBeDefined();
    expect(lastUpdate.summaries.develop.status).toBe("pending");
  });

  it("writes output to {auditDir}/{pipelineId}/{stage}.md", async () => {
    const config = makeTestConfig({ projectRoot: TMP });
    const meta = makeTestMeta({ pipelineId: "pipe-path-1", currentStage: "review" });
    const ctx = createCtx(meta);

    const tool = createGenerateSummary(config);
    const result = (await tool.execute({
      coreContent: "test",
      constraints: [],
      pendingItems: [],
      referenceFiles: [],
    }, ctx as any)) as any;

    expect(result.summaryPath).toContain(".pi/audit/pipe-path-1/review.md");
  });
});
