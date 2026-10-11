/**
 * Unit tests for remainingRoundsOf helper (M9 / Issue 9)
 * 
 * Value table (max=5, N5):
 * - Not started: 5/5 (count=0, c0Used=0)
 * - R1 in progress: 4/5 (count=0, c0Used=1)
 * - R4 completed: 1/5 (count=3, c0Used=1, warning)
 * - R5 completed: 0/5 (count=4, c0Used=1, freeze)
 */

import { describe, expect, it } from "bun:test";
import { remainingRoundsOf } from "../../utils/stage-visit";
import type { PipelineConfig, SessionMeta } from "../../types";

describe("remainingRoundsOf", () => {
  const createConfig = (maxLoopCycles = 5): PipelineConfig => ({
    maxLoopCycles,
    stages: {
      clarify: { nextStage: "plan" },
      plan: { nextStage: "develop" },
      develop: { nextStage: "review" },
      review: { nextStage: "fix" },
      fix: { nextStage: "review" },
      awaiting_human: { nextStage: null },
      completed: { nextStage: null },
    },
  } as PipelineConfig);

  const createMeta = (
    overrides: Partial<SessionMeta> = {}
  ): Pick<SessionMeta, "maxLoopCycles" | "loopCycleCount" | "stageVisitOrder" | "currentStage"> => ({
    maxLoopCycles: overrides.maxLoopCycles,
    loopCycleCount: overrides.loopCycleCount ?? 0,
    stageVisitOrder: overrides.stageVisitOrder ?? [],
    currentStage: overrides.currentStage ?? "review",
  });

  describe("value table (max=5, N5)", () => {
    it("Not started: 5/5 (count=0, c0Used=0)", () => {
      const config = createConfig(5);
      const meta = createMeta({
        loopCycleCount: 0,
        stageVisitOrder: [], // No visits yet
      });

      const result = remainingRoundsOf(meta, config);
      expect(result).toBe(5);
    });

    it("R1 in progress: 4/5 (count=0, c0Used=1)", () => {
      const config = createConfig(5);
      const meta = createMeta({
        loopCycleCount: 0,
        // Rework loop: review → develop is backward edge (C2), counted
        // stageVisitOrder: ["clarify", "plan", "develop", "review", "develop"]
        // review → develop: source=review(3), target=develop(2), 2<3, C2 counted
        stageVisitOrder: ["clarify", "plan", "develop", "review", "develop"],
      });

      const result = remainingRoundsOf(meta, config);
      expect(result).toBe(4);
    });

    it("R4 completed: 1/5 (count=3, c0Used=1, warning)", () => {
      const config = createConfig(5);
      const meta = createMeta({
        loopCycleCount: 3,
        // 4 rework loops with backward edges
        // review → develop (C2), develop → review (C1), review → develop (C2), ...
        stageVisitOrder: [
          "clarify", "plan", "develop", "review",
          "develop", "review", "develop", "review", "develop"
        ],
      });

      const result = remainingRoundsOf(meta, config);
      expect(result).toBe(1);
    });

    it("R5 completed: 0/5 (count=4, c0Used=1, freeze)", () => {
      const config = createConfig(5);
      const meta = createMeta({
        loopCycleCount: 4,
        // 5 rework loops with backward edges
        stageVisitOrder: [
          "clarify", "plan", "develop", "review",
          "develop", "review", "develop", "review", "develop", "review", "develop"
        ],
      });

      const result = remainingRoundsOf(meta, config);
      expect(result).toBe(0);
    });
  });

  describe("design-review cycle (c0Used=0)", () => {
    it("should return max - count when no counted edges exist", () => {
      const config = createConfig(5);
      const meta = createMeta({
        loopCycleCount: 2,
        // Only forward edges (C1), no backward or loop_return
        stageVisitOrder: ["clarify", "plan", "develop"],
      });

      const result = remainingRoundsOf(meta, config);
      expect(result).toBe(3); // 5 - 2 - 0 = 3
    });
  });

  describe("edge cases", () => {
    it("should handle undefined loopCycleCount", () => {
      const config = createConfig(5);
      const meta = createMeta({
        loopCycleCount: undefined,
        stageVisitOrder: [],
      });

      const result = remainingRoundsOf(meta, config);
      expect(result).toBe(5);
    });

    it("should handle undefined maxLoopCycles from meta", () => {
      const config = createConfig(5);
      const meta = createMeta({
        maxLoopCycles: undefined,
        loopCycleCount: 0,
        stageVisitOrder: [],
      });

      const result = remainingRoundsOf(meta, config);
      expect(result).toBe(5); // Uses config.maxLoopCycles
    });

    it("should prefer meta.maxLoopCycles over config", () => {
      const config = createConfig(10);
      const meta = createMeta({
        maxLoopCycles: 5,
        loopCycleCount: 0,
        stageVisitOrder: [],
      });

      const result = remainingRoundsOf(meta, config);
      expect(result).toBe(5);
    });
  });
});
