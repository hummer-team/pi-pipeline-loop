import { describe, it, expect } from "bun:test";
import { buildStageSequence } from "../../utils/stage-sequence";
import { makeTestConfig, STAGE_LIST } from "../helpers";
import type { PipelineConfig, PipelineStage } from "../../types";

describe("buildStageSequence", () => {
  it("returns full chain from first stage to terminal", () => {
    const config = makeTestConfig();
    const result = buildStageSequence(config, "clarify");
    // Default test config: clarify → plan → develop → review → fix → awaiting_human → completed → null
    expect(result).toEqual([
      "clarify", "plan", "develop", "review", "fix", "awaiting_human", "completed",
    ]);
  });

  it("returns subset starting from a mid-chain stage", () => {
    const config = makeTestConfig();
    const result = buildStageSequence(config, "develop");
    expect(result[0]).toBe("develop");
    expect(result).toContain("review");
    expect(result).toContain("completed");
    expect(result.indexOf("develop")).toBeLessThan(result.indexOf("review"));
  });

  it("returns single element when starting from terminal stage", () => {
    const config = makeTestConfig();
    const result = buildStageSequence(config, "completed");
    expect(result).toEqual(["completed"]);
  });

  it("handles circular chain without infinite loop", () => {
    // Create a config with a cycle: develop → review → develop
    const config = makeTestConfig();
    (config.stages.develop as any).nextStage = "review";
    (config.stages.review as any).nextStage = "develop";

    const result = buildStageSequence(config, "develop");
    // Should stop at the cycle boundary (visited-set guard)
    expect(result).toEqual(["develop", "review"]);
  });

  it("handles missing stage config gracefully", () => {
    const config = {
      projectRoot: "/tmp/test",
      stages: {
        clarify: { agentFile: "", skillPath: "", nextStage: "plan" as PipelineStage | null, requireDomain: false },
      },
    } as PipelineConfig;
    // plan is not defined in stages — chain stops after plan (its config is missing)
    const result = buildStageSequence(config, "clarify");
    expect(result).toEqual(["clarify", "plan"]);
  });

  it("respects the hard cap of 16 iterations", () => {
    // Build a config with a long chain (but no cycle) exceeding 16 stages
    const stages: Record<string, any> = {};
    for (let i = 0; i < 20; i++) {
      const name = `stage_${i}`;
      const next = i < 19 ? `stage_${i + 1}` : null;
      stages[name] = { agentFile: "", skillPath: "", nextStage: next, requireDomain: false };
    }
    const config = { projectRoot: "/tmp/test", stages } as unknown as PipelineConfig;

    const result = buildStageSequence(config, "stage_0" as PipelineStage);
    // Hard cap is 16 iterations
    expect(result.length).toBe(16);
  });
});
