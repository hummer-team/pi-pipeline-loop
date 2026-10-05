import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { maybeHandleConfirmGate } from "../../core/stage-advancer";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { initAuditLog } from "../../utils/auditLog";
import type { SessionMeta } from "../../types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(tmpdir(), "pi-auto-review-plan-" + Date.now());
  await fs.mkdir(tmpDir, { recursive: true });
  // Initialize audit log so writeAuditLog doesn't fail with ENOENT
  await initAuditLog(makeTestConfig({ projectRoot: tmpDir }));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeDesignReviewConfig(root: string) {
  const base = makeTestConfig({ projectRoot: root });
  // Enable design-review stage with verify.require
  const drStage = {
    ...base.stages["design-review"],
    verify: { require: true },
    agentPath: "agents/design-review.md",
    skillPath: "skills/design-review.md",
  };
  // Ensure plan stage has manual confirm mode to trigger the menu
  const planStage = {
    ...base.stages.plan,
    confirm: { mode: "manual" as const },
  };
  return {
    ...base,
    stages: { ...base.stages, plan: planStage, "design-review": drStage as any },
  };
}

async function createPlanDoc(content: string = "# Plan\n\nTest plan content.") {
  const docsDir = path.join(tmpDir, "docs", "design");
  await fs.mkdir(docsDir, { recursive: true });
  const planPath = path.join(docsDir, "77_Config_plan.md");
  await fs.writeFile(planPath, content, "utf-8");
  return planPath;
}

describe("Round 4 Issue #1: Auto Review Plan handler", () => {
  it("D02 compliance: does NOT write '## 用户确认' marker when Auto Review Plan is selected", async () => {
    const planPath = await createPlanDoc();
    const config = makeDesignReviewConfig(tmpDir);
    const meta = makeTestMeta({ 
      currentStage: "plan", 
      requirementDoc: "docs/design/77_Config_plan.md",
      pipelineId: "test-pipeline-1",
    });
    // Fix: pass selectReturn to createMockCtx so ctx.ui.select returns "Auto Review Plan"
    const ctx = createMockCtx(meta, { selectReturn: "Auto Review Plan" });
    
    const ui = { 
      notify: () => {},
    };
    
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { 
      mode: "manual",
      sessionFile: tmpDir + "/session.json",
    });
    
    // Verify result indicates stage was advanced
    expect(result.result).toBe("handled");
    expect((result as { result: "handled"; action: string; toStage?: string }).action).toBe("advanced");
    expect((result as { result: "handled"; action: string; toStage?: string }).toStage).toBe("design-review");
    
    // D02 compliance: Verify NO confirmation marker was written
    const planContent = await fs.readFile(planPath, "utf-8");
    expect(planContent).not.toContain("## 用户确认");
    expect(planContent).not.toContain("## User Confirmation");
    expect(planContent).not.toContain("Confirmation timestamp");
  });

  it("creates authorization with source='menu' (not 'direct-entry')", async () => {
    await createPlanDoc();
    const config = makeDesignReviewConfig(tmpDir);
    const meta = makeTestMeta({ 
      currentStage: "plan", 
      requirementDoc: "docs/design/77_Config_plan.md",
      pipelineId: "test-pipeline-2",
    });
    // Fix: pass selectReturn to createMockCtx so ctx.ui.select returns "Auto Review Plan"
    const ctx = createMockCtx(meta, { selectReturn: "Auto Review Plan" });
    const ui = { 
      notify: () => {},
    };
    
    await maybeHandleConfirmGate(config, ctx, meta, ui as any, { 
      mode: "manual",
      sessionFile: tmpDir + "/session.json",
    });
    
    // Verify authorization was created with source="menu"
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    expect(updatedMeta.designReview).toBeDefined();
    expect(updatedMeta.designReview?.authorizationSource).toBe("menu");
    expect(updatedMeta.designReview?.authorizationSource).not.toBe("direct-entry");
  });

  it("switches currentStage from 'plan' to 'design-review'", async () => {
    await createPlanDoc();
    const config = makeDesignReviewConfig(tmpDir);
    const meta = makeTestMeta({ 
      currentStage: "plan", 
      requirementDoc: "docs/design/77_Config_plan.md",
      pipelineId: "test-pipeline-3",
    });
    // Fix: pass selectReturn to createMockCtx so ctx.ui.select returns "Auto Review Plan"
    const ctx = createMockCtx(meta, { selectReturn: "Auto Review Plan" });
    const ui = { 
      notify: () => {},
    };
    
    await maybeHandleConfirmGate(config, ctx, meta, ui as any, { 
      mode: "manual",
      sessionFile: tmpDir + "/session.json",
    });
    
    // Verify stage was switched
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    expect(updatedMeta.currentStage).toBe("design-review");
    expect(updatedMeta.previousStage).toBe("plan");
    expect(updatedMeta.stageStartTime).toBeDefined();
    expect(typeof updatedMeta.stageStartTime).toBe("number");
  });

  it("resets verify/loop counters when switching to design-review", async () => {
    await createPlanDoc();
    const config = makeDesignReviewConfig(tmpDir);
    const meta = makeTestMeta({ 
      currentStage: "plan", 
      requirementDoc: "docs/design/77_Config_plan.md",
      pipelineId: "test-pipeline-4",
      verifyAttempts: 5,
      verifyFailures: [{ ruleType: "test", detail: "test failure", timestamp: Date.now() }],
      violations: [{ type: "write_protected", detail: "test violation", timestamp: Date.now() }],
    });
    // Fix: pass selectReturn to createMockCtx so ctx.ui.select returns "Auto Review Plan"
    const ctx = createMockCtx(meta, { selectReturn: "Auto Review Plan" });
    const ui = { 
      notify: () => {},
    };
    
    await maybeHandleConfirmGate(config, ctx, meta, ui as any, { 
      mode: "manual",
      sessionFile: tmpDir + "/session.json",
    });
    
    // Verify counters were reset
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    expect(updatedMeta.verifyAttempts).toBe(0);
    expect(updatedMeta.verifyFailures).toEqual([]);
    expect(updatedMeta.violations).toEqual([]);
  });

  it("dispatches review agent via coordinator exactly once", async () => {
    await createPlanDoc();
    const config = makeDesignReviewConfig(tmpDir);
    const meta = makeTestMeta({ 
      currentStage: "plan", 
      requirementDoc: "docs/design/77_Config_plan.md",
      pipelineId: "test-pipeline-5",
    });
    
    // Track spawn calls via spawnOverride test hook
    let spawnCallCount = 0;
    const spawnOverride = async () => {
      spawnCallCount++;
      return { spawned: true, fallback: false, deferred: false };
    };
    
    // Fix: pass selectReturn and spawnOverride to createMockCtx
    const ctx = createMockCtx(meta, { selectReturn: "Auto Review Plan" });
    // Add spawnOverride to ctx for coordinator dispatch tracking
    (ctx as any).spawnOverride = spawnOverride;
    
    const ui = { 
      notify: () => {},
    };
    
    await maybeHandleConfirmGate(config, ctx, meta, ui as any, { 
      mode: "manual",
      sessionFile: tmpDir + "/session.json",
    });
    
    // Verify coordinator was called and dispatched exactly once
    expect(spawnCallCount).toBe(1);
  });

  it("cancel path: does not switch stage or dispatch when user cancels", async () => {
    await createPlanDoc();
    const config = makeDesignReviewConfig(tmpDir);
    const meta = makeTestMeta({ 
      currentStage: "plan", 
      requirementDoc: "docs/design/77_Config_plan.md",
      pipelineId: "test-pipeline-6",
    });
    const ctx = createMockCtx(meta);
    
    // Mock UI select to return undefined (cancel)
    const ui = { 
      notify: () => {},
      select: async () => undefined,
    };
    
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { 
      mode: "manual",
      sessionFile: tmpDir + "/session.json",
    });
    
    // Verify stage was NOT switched
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    expect(updatedMeta.currentStage).toBe("plan");
    expect(updatedMeta.designReview).toBeUndefined();
    
    // Verify result indicates handled but not advanced
    expect(result.result).toBe("handled");
    expect((result as { result: "handled"; action: string }).action).toBe("pending");
  });

  it("authorization failure: does not switch stage when design-review is not enabled", async () => {
    await createPlanDoc();
    const config = makeTestConfig({ projectRoot: tmpDir });
    // Disable design-review stage
    const planStage = {
      ...config.stages.plan,
      confirm: { mode: "manual" as const },
    };
    const drStage = {
      ...config.stages["design-review"],
      verify: { require: false }, // Disabled
    };
    const disabledConfig = {
      ...config,
      stages: { ...config.stages, plan: planStage, "design-review": drStage as any },
    };
    
    const meta = makeTestMeta({ 
      currentStage: "plan", 
      requirementDoc: "docs/design/77_Config_plan.md",
      pipelineId: "test-pipeline-7",
    });
    // Fix: pass selectReturn to createMockCtx so ctx.ui.select returns "Auto Review Plan"
    const ctx = createMockCtx(meta, { selectReturn: "Auto Review Plan" });
    const ui = { 
      notify: () => {},
    };
    
    const result = await maybeHandleConfirmGate(disabledConfig, ctx, meta, ui as any, { 
      mode: "manual",
      sessionFile: tmpDir + "/session.json",
    });
    
    // Verify stage was NOT switched
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    expect(updatedMeta.currentStage).toBe("plan");
    expect(updatedMeta.designReview).toBeUndefined();
    
    // Verify result indicates handled but not advanced
    expect(result.result).toBe("handled");
    expect((result as { result: "handled"; action: string }).action).toBe("pending");
  });

  it("failure path: does not switch stage when plan document is not found", async () => {
    // Don't create plan document
    const config = makeDesignReviewConfig(tmpDir);
    const meta = makeTestMeta({ 
      currentStage: "plan", 
      requirementDoc: "docs/design/nonexistent_plan.md",
      pipelineId: "test-pipeline-8",
    });
    // Fix: pass selectReturn to createMockCtx so ctx.ui.select returns "Auto Review Plan"
    const ctx = createMockCtx(meta, { selectReturn: "Auto Review Plan" });
    const ui = { 
      notify: () => {},
    };
    
    const result = await maybeHandleConfirmGate(config, ctx, meta, ui as any, { 
      mode: "manual",
      sessionFile: tmpDir + "/session.json",
    });
    
    // Verify stage was NOT switched
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    expect(updatedMeta.currentStage).toBe("plan");
    expect(updatedMeta.designReview).toBeUndefined();
    
    // Verify result indicates handled but not advanced
    expect(result.result).toBe("handled");
    expect((result as { result: "handled"; action: string }).action).toBe("pending");
  });
});
