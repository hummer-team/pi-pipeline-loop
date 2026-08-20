import { describe, it, expect, beforeEach } from "bun:test";
import { createStageAdvancer } from "../../core/stage-advancer";
import { makeTestConfig, makeTestMeta, STAGE_LIST } from "../helpers";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

  it("clearStage when resolvedTarget is explicitly 'completed'", async () => {
    const config = makeTestConfig();
    const meta = makeTestMeta({ currentStage: "review" });
    // review → completed (explicit, not null)
    config.stages["review"] = { ...config.stages["review"], nextStage: "completed" as any };

    const ctx = createCtx(meta);
    const tool = createStageAdvancer(config);
    const result = await tool.execute({}, ctx as any);

    expect((result as any).success).toBe(true);
    expect(meta.currentStage).toBe("completed");
    // clearStage path: message contains "Advanced" (not "Pipeline completed — no further stages")
    expect((result as any).message).toContain("Advanced");
    expect((result as any).message).toContain("completed");
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

    it("verify.require=true and verification passes → advance to nextStage", async () => {
      // Set up a temp directory with a verify.md containing a passing rule
      const TMP = join(tmpdir(), "pi-advancer-verify-pass-" + Date.now());
      const verifyDir = join(TMP, ".pi", "references", "clarify_spec");
      await mkdir(verifyDir, { recursive: true });
      // Create a target file that the requiredFiles rule will check
      const targetFile = join(TMP, "docs", "design", "test_plan.md");
      await mkdir(join(TMP, "docs", "design"), { recursive: true });
      await writeFile(targetFile, "# Plan");
      // Create verify.md with a requiredFiles rule that will pass
      await writeFile(
        join(verifyDir, "verify.md"),
        `---
rules:
  requiredFiles:
    - "docs/design/test_plan.md"
---
Verify plan document exists.`,
      );

      const config = makeTestConfig({ projectRoot: TMP });
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        nextStage: "plan",
        verify: { require: true, mode: "tool", verifyFile: ".pi/references/clarify_spec/verify.md" },
      };
      const meta = makeTestMeta({ currentStage: "clarify" });

      const ctx = createCtx(meta);
      const tool = createStageAdvancer(config);
      const result = await tool.execute({}, ctx as any);

      // Verification passes → should advance
      expect((result as any).success).toBe(true);
      expect((result as any).currentStage).toBe("plan");
      expect(meta.currentStage).toBe("plan");
      expect(meta.previousStage).toBe("clarify");
    });

    it("accepts deps with execFn", () => {
      const mockExecFn = async () => ({ stdout: "", stderr: "", code: 0 });
      const tool = createStageAdvancer(makeTestConfig(), { execFn: mockExecFn });
      expect(tool.name).toBe("stage_advance");
      expect(typeof tool.execute).toBe("function");
    });

    it("tool mode: verify failure at maxVerifyAttempts triggers circuit breaker (flowState → blocked)", async () => {
      const config = makeTestConfig();
      config.maxVerifyAttempts = 2;
      config.stages["clarify"] = {
        ...config.stages["clarify"],
        nextStage: "plan",
        verify: { require: true, mode: "tool" },
      };
      const meta = makeTestMeta({
        currentStage: "clarify",
        verifyAttempts: 1, // One previous attempt
      });

      const ctx = createCtx(meta);
      // Add ui mock for freezeAndPrompt notification
      (ctx as any).ui = { notify: () => {}, select: async () => undefined };
      const tool = createStageAdvancer(config);
      const result = await tool.execute({}, ctx as any);

      // Should fail and freeze the pipeline (circuit breaker)
      expect((result as any).success).toBe(false);
      expect(meta.flowState).toBe("blocked");
    });
  });
});
