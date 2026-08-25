import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createPipelineState } from "../../core/pipeline-state";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";

function createCtx(meta: any) {
  return {
    session: { getMeta: () => meta },
  };
}

describe("createPipelineState", () => {
  it("creates a tool named 'pipeline_state'", () => {
    const tool = createPipelineState(makeTestConfig());
    expect(tool.name).toBe("pipeline_state");
  });

  it("returns error when no session context", async () => {
    const tool = createPipelineState(makeTestConfig());
    const result = await tool.execute({});
    expect(result).toEqual({ error: "No session context available" });
  });

  it("returns full pipeline state snapshot", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta();
    const ctx = createCtx(meta);

    const tool = createPipelineState(config);
    const result = (await tool.execute({}, ctx as any)) as any;

    expect(result.pipelineId).toBe("pipe-test-001");
    expect(result.stage.current).toBe("develop");
    expect(result.stage.previous).toBe("plan");
    expect(result.domain.id).toBe("general");
    expect(result.loop.count).toBe(0);
    expect(result.loop.maxLoops).toBe(3);
    expect(result.stageStartTime).toBeDefined();
  });

  it("includes stage sequence", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = createCtx(meta);

    const tool = createPipelineState(config);
    const result = (await tool.execute({}, ctx as any)) as any;

    expect(Array.isArray(result.stage.sequence)).toBe(true);
    expect(result.stage.sequence.length).toBeGreaterThan(0);
    expect(result.stage.sequence[0]).toBe("clarify");
  });

  it("includes summary metadata", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      summaries: {
        plan: { path: "/tmp/plan.md", hash: "abc", status: "valid" as const },
      },
    });
    const ctx = createCtx(meta);

    const tool = createPipelineState(config);
    const result = (await tool.execute({}, ctx as any)) as any;

    expect(result.summaries.plan).toBeDefined();
    expect(result.summaries.plan.status).toBe("valid");
  });

  // ─── Phase 4 (143): summaryIntegrity field ─────────────────────────────────

  describe("summaryIntegrity (143 Phase 4)", () => {
    let TMP: string;

    beforeEach(async () => {
      TMP = join(tmpdir(), `pi-pstate-hash-${Date.now()}`);
      await mkdir(TMP, { recursive: true });
    });

    afterEach(async () => {
      await rm(TMP, { recursive: true, force: true });
    });

    it("includes summaryIntegrity array in pipeline state result", async () => {
      const summaryPath = join(TMP, "plan.md");
      const content = "# Plan";
      await writeFile(summaryPath, content, "utf-8");
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        summaries: { plan: { path: summaryPath, hash, status: "valid" as const } },
      });
      const ctx = createCtx(meta);

      const tool = createPipelineState(config);
      const result = (await tool.execute({}, ctx as any)) as any;

      expect(Array.isArray(result.summaryIntegrity)).toBe(true);
      expect(result.summaryIntegrity.length).toBeGreaterThan(0);
      const planCheck = result.summaryIntegrity.find((c: any) => c.stage === "plan");
      expect(planCheck).toBeDefined();
      expect(planCheck.status).toBe("ok");
      expect(planCheck.match).toBe(true);
    });

    it("reports mismatch when summary file modified", async () => {
      const summaryPath = join(TMP, "develop.md");
      const content = "# Develop";
      await writeFile(summaryPath, content, "utf-8");
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      // Modify the file
      await writeFile(summaryPath, "# Develop Modified", "utf-8");

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        summaries: { develop: { path: summaryPath, hash, status: "valid" as const } },
      });
      const ctx = createCtx(meta);

      const tool = createPipelineState(config);
      const result = (await tool.execute({}, ctx as any)) as any;

      const devCheck = result.summaryIntegrity.find((c: any) => c.stage === "develop");
      expect(devCheck).toBeDefined();
      expect(devCheck.status).toBe("mismatch");
      expect(devCheck.match).toBe(false);
    });

    it("reports missing when summary file deleted", async () => {
      const summaryPath = join(TMP, "nonexistent.md");

      const config = makeTestConfig({ projectRoot: TMP });
      const meta = makeTestMeta({
        summaries: { review: { path: summaryPath, hash: "abc", status: "valid" as const } },
      });
      const ctx = createCtx(meta);

      const tool = createPipelineState(config);
      const result = (await tool.execute({}, ctx as any)) as any;

      const reviewCheck = result.summaryIntegrity.find((c: any) => c.stage === "review");
      expect(reviewCheck).toBeDefined();
      expect(reviewCheck.status).toBe("missing");
    });
  });
});
