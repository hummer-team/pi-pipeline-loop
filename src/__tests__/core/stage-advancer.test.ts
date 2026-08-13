import { describe, it, expect, beforeEach } from "bun:test";
import { createStageAdvancer } from "../../core/stage-advancer";
import { makeTestConfig, makeTestMeta, STAGE_LIST } from "../helpers";

/** Minimal mock ctx with session + _ctx for extractAssistantMessages */
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
    _ctx: { sessionManager: { getBranch: () => [], getEntries: () => [] } },
  };
}

describe("createStageAdvancer", () => {
  it("creates a tool named 'stage_advance'", () => {
    const tool = createStageAdvancer(makeTestConfig());
    expect(tool.name).toBe("stage_advance");
    expect(typeof tool.execute).toBe("function");
  });

  it("has nextStage in parameters schema", () => {
    const tool = createStageAdvancer(makeTestConfig());
    expect(tool.parameters).toBeDefined();
    const params = tool.parameters as Record<string, any>;
    expect(params.properties?.nextStage).toBeDefined();
    expect(params.properties.nextStage.type).toBe("string");
    expect(params.required).toEqual([]);
  });

  it("returns error when no session context", async () => {
    const tool = createStageAdvancer(makeTestConfig());
    const result = await tool.execute({});
    expect(result).toEqual({ error: "No session context available" });
  });

  it("advances from current stage to next stage", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "clarify" });
    config.stages["clarify"] = { ...config.stages["clarify"], nextStage: "plan" };

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({}, ctx as any);

    expect((result as any).success).toBe(true);
    expect((result as any).currentStage).toBe("plan");
    expect(meta.currentStage).toBe("plan");
    expect(meta.previousStage).toBe("clarify");
    expect(meta.loopCount).toBe(0);
    expect(meta.currentStepIndex).toBe(0);
  });

  it("marks pipeline as completed when already completed", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "completed" });

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({}, ctx as any);

    expect((result as any).success).toBe(false);
    expect((result as any).message).toContain("already completed");
  });

  it("advances last non-null stage to completed", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "review" });
    config.stages["review"] = { ...config.stages["review"], nextStage: null };

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
      currentStage: "plan",
      loopCount: 5,
      currentStepIndex: 3,
    });
    config.stages["plan"] = { ...config.stages["plan"], nextStage: "develop" };

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    await tool.execute({}, ctx as any);

    expect(meta.loopCount).toBe(0);
    expect(meta.currentStepIndex).toBe(0);
    expect(meta.currentStage).toBe("develop");
  });

  it("resets verifyFailures on advance", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({
      currentStage: "plan",
      verifyFailures: [{ ruleType: "requiredFiles", detail: "missing", timestamp: Date.now() }],
    });
    config.stages["plan"] = { ...config.stages["plan"], nextStage: "develop" };

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    await tool.execute({}, ctx as any);

    expect(meta.verifyFailures).toEqual([]);
  });

  // ─── nextStage parameter override ────────────────────────────────────────

  it("nextStage param overrides default target", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "review" });
    config.stages["review"] = { ...config.stages["review"], nextStage: "completed" };

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({ nextStage: "fix" }, ctx as any);

    expect((result as any).success).toBe(true);
    expect((result as any).currentStage).toBe("fix");
    expect(meta.currentStage).toBe("fix");
    expect(meta.previousStage).toBe("review");
  });

  it("nextStage param works for branch to awaiting_human", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "clarify" });
    config.stages["clarify"] = { ...config.stages["clarify"], nextStage: "plan" };

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({ nextStage: "awaiting_human" }, ctx as any);

    expect((result as any).success).toBe(true);
    expect(meta.currentStage).toBe("awaiting_human");
  });

  it("invalid nextStage returns error and does not advance", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "plan" });
    const originalStage = meta.currentStage;

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({ nextStage: "nonexistent_stage" }, ctx as any);

    expect((result as any).success).toBe(false);
    expect((result as any).message).toContain("not defined");
    expect(meta.currentStage).toBe(originalStage);
  });

  it("nextStage same as current returns error", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "plan" });

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({ nextStage: "plan" }, ctx as any);

    expect((result as any).success).toBe(false);
    expect((result as any).message).toContain("cannot advance to the same stage");
  });

  // ─── Verification gate ───────────────────────────────────────────────────

  describe("verification gate", () => {
    it("skips verification when verify.require is false", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "clarify" });
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        nextStage: "plan",
        verify: { require: false },
      };

      const ctx = createCtx(meta);
      const tool = createStageAdvancer(config);
      const result = await tool.execute({}, ctx as any);

      expect((result as any).success).toBe(true);
      expect(meta.currentStage).toBe("plan");
    });

    it("skips verification when verify is undefined", async () => {
      const config = makeTestConfig();
      const meta = makeTestMeta({ currentStage: "clarify" });
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        nextStage: "plan",
        verify: undefined,
      };

      const ctx = createCtx(meta);
      const tool = createStageAdvancer(config);
      const result = await tool.execute({}, ctx as any);

      expect((result as any).success).toBe(true);
      expect(meta.currentStage).toBe("plan");
    });

    it("verify.require=true and no verify.md file → verification fails, no advance", async () => {
      // When verify.require is true but no verify.md exists,
      // runVerification returns rulePassed=false → should block advance
      const config = makeTestConfig();
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        nextStage: "plan",
        verify: { require: true, mode: "tool" },
      };
      const meta = makeTestMeta({ currentStage: "clarify" });

      const ctx = createCtx(meta);
      const tool = createStageAdvancer(config);
      const result = await tool.execute({}, ctx as any);

      // Verification fails (no verify.md → no rules → rulePassed=false)
      expect((result as any).success).toBe(false);
      expect((result as any).message).toContain("Verification failed");
      expect(meta.currentStage).toBe("clarify"); // did NOT advance
    });

    it("accepts deps with execFn", () => {
      const mockExecFn = async () => ({ stdout: "", stderr: "", code: 0 });
      const tool = createStageAdvancer(makeTestConfig(), { execFn: mockExecFn });
      expect(tool.name).toBe("stage_advance");
      expect(typeof tool.execute).toBe("function");
    });
  });
});
