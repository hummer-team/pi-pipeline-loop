import { describe, it, expect } from "bun:test";
import { createPipelineHandoff } from "../../tools/pipeline-handoff";
import { createStageAdvancer } from "../../core/stage-advancer";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";

describe("loop cycle detection (pipeline_handoff)", () => {
  it("rejects handoff when maxLoopCycles reached", async () => {
    const config = makeTestConfig({ maxLoopCycles: 2 });
    const meta = makeTestMeta({
      currentStage: "fix",
      loopCycleCount: 1,
      stageVisitOrder: ["develop", "review", "fix"],
      summaries: {
        ...makeTestMeta().summaries,
        fix: { path: "/tmp/summary.md", hash: "abc", status: "valid" as const },
      },
    });
    const ctx = createMockCtx(meta);

    const tool = createPipelineHandoff(config);
    const result: any = await tool.execute(
      { nextStage: "develop" },
      ctx as any,
    );

    expect(result.error).toContain("Max loop cycles");
    expect(result.error).toContain("2");
  });

  it("allows handoff within maxLoopCycles", async () => {
    const config = makeTestConfig({ maxLoopCycles: 3 });
    const meta = makeTestMeta({
      currentStage: "fix",
      loopCycleCount: 0,
      stageVisitOrder: ["develop", "review", "fix"],
      summaries: {
        ...makeTestMeta().summaries,
        fix: { path: "/tmp/summary.md", hash: "abc", status: "valid" as const },
      },
    });
    const ctx = createMockCtx(meta);

    const tool = createPipelineHandoff(config);
    const result: any = await tool.execute(
      { nextStage: "develop" },
      ctx as any,
    );

    expect(result.success).toBe(true);
  });

  it("does not cycle-detect linear transitions", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "develop",
      summaries: {
        ...makeTestMeta().summaries,
        develop: { path: "/tmp/summary.md", hash: "abc", status: "valid" as const },
      },
    });
    const ctx = createMockCtx(meta);

    const tool = createPipelineHandoff(config);
    const result: any = await tool.execute(
      { nextStage: "review" },
      ctx as any,
    );

    expect(result.success).toBe(true);
  });
});
