import { describe, it, expect } from "bun:test";
import { createStageAdvancer } from "../../core/stage-advancer";
import { makeTestConfig, makeTestMeta, STAGE_LIST } from "../helpers";

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

describe("createStageAdvancer", () => {
  it("creates a tool named 'stage_advance'", () => {
    const tool = createStageAdvancer(makeTestConfig());
    expect(tool.name).toBe("stage_advance");
    expect(typeof tool.execute).toBe("function");
  });

  it("returns error when no session context", async () => {
    const tool = createStageAdvancer(makeTestConfig());
    const result = await tool.execute({});
    expect(result).toEqual({ error: "No session context available" });
  });

  it("advances from current stage to next stage", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "clarify" });
    config.stages["clarify"] = { ...config.stages["clarify"], nextStage: "design" } as any;

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({}, ctx as any);

    expect((result as any).success).toBe(true);
    expect((result as any).currentStage).toBe("design");
    expect(meta.currentStage).toBe("design");
    expect(meta.previousStage).toBe("clarify");
    expect(meta.loopCount).toBe(0);
    expect(meta.currentStepIndex).toBe(0);
  });

  it("marks pipeline as completed when nextStage is null", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "completed" });
    config.stages["completed"] = { ...config.stages["completed"], nextStage: null } as any;

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({}, ctx as any);

    expect((result as any).success).toBe(false);
    expect((result as any).message).toContain("already completed");
  });

  it("advances last non-null stage to completed", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "review" });
    config.stages["review"] = { ...config.stages["review"], nextStage: null } as any;

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({}, ctx as any);

    expect((result as any).success).toBe(true);
    expect((result as any).message).toContain("Pipeline completed");
    expect(meta.currentStage).toBe("completed");
  });

  it("resets loopCount and currentStepIndex on advance", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "design",
      loopCount: 5,
      currentStepIndex: 3,
    });
    config.stages["design"] = { ...config.stages["design"], nextStage: "plan" } as any;

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    await tool.execute({}, ctx as any);

    expect(meta.loopCount).toBe(0);
    expect(meta.currentStepIndex).toBe(0);
    expect(meta.currentStage).toBe("plan");
  });
});
