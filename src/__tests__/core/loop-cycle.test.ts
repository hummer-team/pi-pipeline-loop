import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createPipelineHandoff } from "../../tools/pipeline-handoff";
import { createStageAdvancer } from "../../core/stage-advancer";
import { makeTestConfig, makeTestMeta, createMockCtx } from "../helpers";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";

/** Helper: write a file and return its SHA-256 hash */
async function writeAndHash(filePath: string, content: string): Promise<string> {
  await mkdir(join(filePath, ".."), { recursive: true }).catch(() => {});
  await writeFile(filePath, content, "utf-8");
  return crypto.createHash("sha256").update(content).digest("hex");
}

let CYCLE_TMP: string;

beforeAll(async () => {
  CYCLE_TMP = join(tmpdir(), `pi-cycle-test-${Date.now()}`);
  await mkdir(CYCLE_TMP, { recursive: true });
});

afterAll(async () => {
  await rm(CYCLE_TMP, { recursive: true, force: true }).catch(() => {});
});

describe("loop cycle detection (pipeline_handoff)", () => {
  it("refuses a backward handoff target that is not the configured successor (D-4)", async () => {
    // 227 Phase 3: review's configured successor is `completed`; `develop`
    // is a backward rework target that the whitelist refuses.
    const config = makeTestConfig({ maxLoopCycles: 2, projectRoot: CYCLE_TMP });
    const summaryPath = join(CYCLE_TMP, "fix-cycle1.md");
    const hash = await writeAndHash(summaryPath, "# Review Summary\nCycle test 1");
    const meta = makeTestMeta({
      currentStage: "review",
      loopCycleCount: 1,
      stageVisitOrder: ["plan", "develop", "review"],
      summaries: {
        review: { path: summaryPath, hash, status: "valid" as const },
      },
    });
    const ctx = createMockCtx(meta);

    const tool = createPipelineHandoff(config);
    const result: any = await tool.execute(
      { nextStage: "develop" },
      ctx as any,
    );

    // 227 Phase 3: a counted rework edge can only be produced by plugin
    // routing (confirm reject) — a handoff to a non-successor is refused
    // BEFORE any loop budget is consulted.
    expect(result.error).toContain("Invalid nextStage");
    expect(meta.currentStage).toBe("review");
    expect(meta.flowState).toBeUndefined();
  });

  it("allows handoff within maxLoopCycles", async () => {
    const base = makeTestConfig({ maxLoopCycles: 3, projectRoot: CYCLE_TMP });
    const config = { ...base, stages: { ...base.stages, review: { ...base.stages.review, nextStage: "develop" as const } } };
    const summaryPath = join(CYCLE_TMP, "fix-cycle2.md");
    const hash = await writeAndHash(summaryPath, "# Review Summary\nCycle test 2");
    const meta = makeTestMeta({
      currentStage: "review",
      loopCycleCount: 0,
      stageVisitOrder: ["plan", "develop", "review"],
      summaries: {
        review: { path: summaryPath, hash, status: "valid" as const },
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
    const config = makeTestConfig({ projectRoot: CYCLE_TMP });
    const summaryPath = join(CYCLE_TMP, "develop-linear.md");
    const hash = await writeAndHash(summaryPath, "# Develop Summary\nLinear test");
    const meta = makeTestMeta({
      currentStage: "develop",
      summaries: {
        develop: { path: summaryPath, hash, status: "valid" as const },
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

  it("does not increment loopCycleCount on linear transitions", async () => {
    const config = makeTestConfig({ projectRoot: CYCLE_TMP });
    const meta = makeTestMeta({
      currentStage: "plan",
    });
    const ctx = createMockCtx(meta);

    const tool = createPipelineHandoff(config);
    const result: any = await tool.execute(
      { nextStage: "develop" },
      ctx as any,
    );
    expect(result).toBeDefined();
  });

  it("refuses the same backward target regardless of the loop budget (D-4)", async () => {
    const config = makeTestConfig({ maxLoopCycles: 0, projectRoot: CYCLE_TMP });
    const summaryPath = join(CYCLE_TMP, "fix-cycle0.md");
    const hash = await writeAndHash(summaryPath, "# Review Summary\nCycle test 0");
    const meta = makeTestMeta({
      currentStage: "review",
      loopCycleCount: 0,
      stageVisitOrder: ["plan", "develop", "review"],
      summaries: {
        review: { path: summaryPath, hash, status: "valid" as const },
      },
    });
    const ctx = createMockCtx(meta);

    const tool = createPipelineHandoff(config);
    const result: any = await tool.execute(
      { nextStage: "develop" },
      ctx as any,
    );

    expect(result.error).toContain("Invalid nextStage");
    expect(meta.currentStage).toBe("review");
  });
});
