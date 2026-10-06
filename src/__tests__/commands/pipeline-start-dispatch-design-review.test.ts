import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { dispatchAfterResume } from "../../commands/pipeline-start";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { initAuditLog } from "../../utils/auditLog";
import { createInitialState, computeHash } from "../../core/design-review/state";
import type { SessionMeta } from "../../types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = path.join(tmpdir(), "pi-dispatch-design-review-" + Date.now());
  await fs.mkdir(tmpDir, { recursive: true });
  await initAuditLog(makeTestConfig({ projectRoot: tmpDir }));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeDesignReviewConfig(root: string) {
  const base = makeTestConfig({ projectRoot: root });
  const drStage = {
    ...base.stages["design-review"],
    verify: { require: true },
    agentPath: "agents/design-review.md",
    skillPath: "skills/design-review.md",
  };
  return {
    ...base,
    stages: { ...base.stages, "design-review": drStage as any },
  };
}

async function createPlanDoc(content: string = "# Plan\n\nTest plan content.") {
  const docsDir = path.join(tmpDir, "docs", "design");
  await fs.mkdir(docsDir, { recursive: true });
  const planPath = path.join(docsDir, "77_Config_plan.md");
  await fs.writeFile(planPath, content, "utf-8");
  return planPath;
}

describe("Round 5 Issue N-3: choose_stage → design-review dispatch via coordinator", () => {
  it("dispatchAfterResume dispatches review agent exactly once when authorization is valid", async () => {
    const planPath = await createPlanDoc();
    const config = makeDesignReviewConfig(tmpDir);
    const planHash = computeHash(await fs.readFile(planPath, "utf-8"));
    
    // Create valid authorization state
    const drState = createInitialState(planPath, "menu", planHash);
    drState.phase = "review_ready"; // Ready for review dispatch
    
    const meta = makeTestMeta({
      currentStage: "design-review",
      requirementDoc: "docs/design/77_Config_plan.md",
      pipelineId: "test-n3-dispatch",
      designReview: drState,
    });
    
    // Track spawn calls via spawnOverride test hook
    let spawnCallCount = 0;
    const spawnOverride = async () => {
      spawnCallCount++;
      return { spawned: true, fallback: false, deferred: false, agentId: "test-agent-start-001", dispatchOutcome: "spawned_id" as const };
    };
    
    const ctx = createMockCtx(meta);
    (ctx as any).spawnOverride = spawnOverride;
    
    const ui = {
      notify: () => {},
    };
    
    // Call dispatchAfterResume (simulating choose_stage → onStageChanged callback)
    await dispatchAfterResume(ctx, config, ui as any, meta, planPath);
    
    // Verify coordinator was called and dispatched exactly once
    expect(spawnCallCount).toBe(1);
    
    // Verify meta was updated correctly
    const updatedMeta = ctx.session.getMeta() as SessionMeta;
    expect(updatedMeta.designReview).toBeDefined();
    expect(updatedMeta.designReview?.phase).toBe("review_running");
  });

  it("does not dispatch when authorization is invalid (finished phase)", async () => {
    const planPath = await createPlanDoc();
    const config = makeDesignReviewConfig(tmpDir);
    const planHash = computeHash(await fs.readFile(planPath, "utf-8"));
    
    // Create invalid authorization state (finished phase)
    const drState = createInitialState(planPath, "menu", planHash);
    drState.phase = "finished"; // Finished phase is invalid
    
    const meta = makeTestMeta({
      currentStage: "design-review",
      requirementDoc: "docs/design/77_Config_plan.md",
      pipelineId: "test-n3-finished",
      designReview: drState,
    });
    
    let spawnCallCount = 0;
    const spawnOverride = async () => {
      spawnCallCount++;
      return { spawned: true, fallback: false, deferred: false, agentId: "test-agent-start-001", dispatchOutcome: "spawned_id" as const };
    };
    
    const ctx = createMockCtx(meta);
    (ctx as any).spawnOverride = spawnOverride;
    
    const ui = {
      notify: () => {},
    };
    
    await dispatchAfterResume(ctx, config, ui as any, meta, planPath);
    
    // Should not dispatch when authorization is invalid (finished phase)
    expect(spawnCallCount).toBe(0);
  });

  it("does not dispatch when designReview state is undefined", async () => {
    const planPath = await createPlanDoc();
    const config = makeDesignReviewConfig(tmpDir);
    
    const meta = makeTestMeta({
      currentStage: "design-review",
      requirementDoc: "docs/design/77_Config_plan.md",
      pipelineId: "test-n3-no-auth",
      designReview: undefined,
    });
    
    let spawnCallCount = 0;
    const spawnOverride = async () => {
      spawnCallCount++;
      return { spawned: true, fallback: false, deferred: false, agentId: "test-agent-start-001", dispatchOutcome: "spawned_id" as const };
    };
    
    const ctx = createMockCtx(meta);
    (ctx as any).spawnOverride = spawnOverride;
    
    const ui = {
      notify: () => {},
    };
    
    await dispatchAfterResume(ctx, config, ui as any, meta, planPath);
    
    // Should not dispatch when no authorization exists
    expect(spawnCallCount).toBe(0);
  });
});
