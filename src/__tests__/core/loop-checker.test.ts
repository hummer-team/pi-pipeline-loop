import { describe, it, expect } from "bun:test";
import { createLoopChecker } from "../../core/loop-checker";
import { makeTestConfig, makeTestMeta } from "../helpers";

function createCtx(meta: any) {
  const updates: any[] = [];
  return {
    session: {
      getMeta: () => meta,
      updateMeta: (m: any) => {
        updates.push(m);
        Object.assign(meta, m);
      },
    },
    updates,
  };
}

describe("createLoopChecker", () => {
  it("creates a tool named 'loop_check'", () => {
    const tool = createLoopChecker(makeTestConfig());
    expect(tool.name).toBe("loop_check");
  });

  it("returns error when no session context", async () => {
    const tool = createLoopChecker(makeTestConfig());
    const result = await tool.execute({});
    expect(result).toEqual({ error: "No session context available" });
  });

  it("returns error when not in develop or fix stage", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "clarify" });
    const ctx = createCtx(meta);

    const tool = createLoopChecker(config);
    const result = await tool.execute({ result: "pass" }, ctx as any);

    expect((result as any).success).toBe(false);
    expect((result as any).error).toContain("only valid in");
  });

  it("returns advance for pass result", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "develop", loopCount: 1 });
    const ctx = createCtx(meta);

    const tool = createLoopChecker(config);
    const result = await tool.execute({ result: "pass" }, ctx as any);

    expect((result as any).action).toBe("advance");
    expect((result as any).loopCount).toBe(1);
  });

  it("returns retry for fail result within maxLoops", async () => {
    const config = makeTestConfig({ maxLoops: 3 });
    const meta = makeTestMeta({ currentStage: "develop", loopCount: 1, maxLoops: 3 });
    const ctx = createCtx(meta);

    const tool = createLoopChecker(config);
    const result = await tool.execute({ result: "fail", summary: "fixed bug" }, ctx as any);

    expect((result as any).action).toBe("retry");
    expect(meta.loopCount).toBe(2);
    expect(meta.currentStepIndex).toBe(1);
  });

  it("returns halt for fail result at maxLoops", async () => {
    const config = makeTestConfig({ maxLoops: 2 });
    const meta = makeTestMeta({ currentStage: "fix", loopCount: 1, maxLoops: 2 });
    const ctx = createCtx(meta);

    const tool = createLoopChecker(config);
    const result = await tool.execute({ result: "fail" }, ctx as any);

    expect((result as any).action).toBe("halt");
    expect(meta.loopCount).toBe(2);
    // Phase 2: halt now freezes the pipeline
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("loop_halt_overflow");
  });

  it("works in fix stage too", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "fix", loopCount: 0 });
    const ctx = createCtx(meta);

    const tool = createLoopChecker(config);
    const result = await tool.execute({ result: "pass" }, ctx as any);

    expect((result as any).action).toBe("advance");
  });

  it("includes summary in retry response", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "develop", loopCount: 0 });
    const ctx = createCtx(meta);

    const tool = createLoopChecker(config);
    const result = await tool.execute({ result: "fail", summary: "attempted X" }, ctx as any);

    expect((result as any).summary).toBe("attempted X");
  });
});
