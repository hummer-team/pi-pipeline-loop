import { describe, it, expect } from "bun:test";
import { createPipelineState } from "../../core/pipeline-state";
import { makeTestConfig, makeTestMeta } from "../helpers";

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
});
