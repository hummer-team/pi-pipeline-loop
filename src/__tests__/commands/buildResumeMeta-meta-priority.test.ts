/**
 * Phase 4 (task 5): buildResumeMeta meta-priority regression test.
 * Verifies that buildResumeMeta respects meta.maxLoopCycles over config.maxLoopCycles.
 */
import { describe, expect, it } from "bun:test";
import { buildResumeMeta } from "../../commands/pipeline-start";
import { DEFAULT_MAX_LOOP_CYCLES } from "../../constants";
import { makeTestConfig, makeTestMeta } from "../helpers";

describe("buildResumeMeta: meta priority over config (Phase 4 task 5)", () => {
  it("meta.maxLoopCycles overrides config.maxLoopCycles", () => {
    const existingMeta = makeTestMeta({
      pipelineId: "pipe-test-123",
      currentStage: "plan",
      maxLoopCycles: 8,
    });
    const config = makeTestConfig({
      maxLoopCycles: 5,
    });

    const result = buildResumeMeta(existingMeta, config);
    expect(result.maxLoopCycles).toBe(8); // meta takes precedence
  });

  it("config.maxLoopCycles used when meta is missing", () => {
    const existingMeta = makeTestMeta({
      pipelineId: "pipe-test-456",
      currentStage: "plan",
    });
    const config = makeTestConfig({
      maxLoopCycles: 6,
    });

    const result = buildResumeMeta(existingMeta, config);
    expect(result.maxLoopCycles).toBe(6); // config used
  });

  it("DEFAULT used when both are missing", () => {
    const existingMeta = makeTestMeta({
      pipelineId: "pipe-test-789",
      currentStage: "plan",
    });
    const config = makeTestConfig();

    const result = buildResumeMeta(existingMeta, config);
    expect(result.maxLoopCycles).toBe(DEFAULT_MAX_LOOP_CYCLES); // DEFAULT used
  });
});
