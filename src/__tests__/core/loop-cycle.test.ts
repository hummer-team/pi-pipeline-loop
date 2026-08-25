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
  it("rejects handoff when maxLoopCycles reached", async () => {
    const config = makeTestConfig({ maxLoopCycles: 2, projectRoot: CYCLE_TMP });
    const summaryPath = join(CYCLE_TMP, "fix-cycle1.md");
    const hash = await writeAndHash(summaryPath, "# Fix Summary\nCycle test 1");
    const meta = makeTestMeta({
      currentStage: "fix",
      loopCycleCount: 1,
      stageVisitOrder: ["develop", "review", "fix"],
      summaries: {
        fix: { path: summaryPath, hash, status: "valid" as const },
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
    // Phase 2: maxLoopCycles freeze → flowState=blocked
    expect(meta.flowState).toBe("blocked");
    expect(meta.blockedReason).toBe("max_loop_cycles");
  });

  it("allows handoff within maxLoopCycles", async () => {
    const config = makeTestConfig({ maxLoopCycles: 3, projectRoot: CYCLE_TMP });
    const summaryPath = join(CYCLE_TMP, "fix-cycle2.md");
    const hash = await writeAndHash(summaryPath, "# Fix Summary\nCycle test 2");
    const meta = makeTestMeta({
      currentStage: "fix",
      loopCycleCount: 0,
      stageVisitOrder: ["develop", "review", "fix"],
      summaries: {
        fix: { path: summaryPath, hash, status: "valid" as const },
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

  it("rejects cycle immediately when maxLoopCycles=0", async () => {
    const config = makeTestConfig({ maxLoopCycles: 0, projectRoot: CYCLE_TMP });
    const summaryPath = join(CYCLE_TMP, "fix-cycle0.md");
    const hash = await writeAndHash(summaryPath, "# Fix Summary\nCycle test 0");
    const meta = makeTestMeta({
      currentStage: "fix",
      loopCycleCount: 0,
      stageVisitOrder: ["develop", "review", "fix"],
      summaries: {
        fix: { path: summaryPath, hash, status: "valid" as const },
      },
    });
    const ctx = createMockCtx(meta);

    const tool = createPipelineHandoff(config);
    const result: any = await tool.execute(
      { nextStage: "develop" },
      ctx as any,
    );

    expect(result.error).toContain("Max loop cycles");
    expect(result.error).toContain("0");
  });
});
