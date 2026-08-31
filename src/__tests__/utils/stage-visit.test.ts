import { describe, it, expect } from "bun:test";
import { recordStageVisit } from "../../utils/stage-visit";
import { makeTestMeta } from "../helpers";
import type { SessionMeta } from "../../types";

describe("recordStageVisit", () => {
  it("first visit: appends stage and sets loopCycleCount=0", () => {
    const meta = makeTestMeta({ stageVisitOrder: ["clarify"], loopCycleCount: undefined });
    const result = recordStageVisit(meta, "plan", 3);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.stageVisitOrder).toEqual(["clarify", "plan"]);
      expect(result.patch.loopCycleCount).toBe(0);
    }
  });

  it("first visit with undefined stageVisitOrder: creates array with stage", () => {
    const meta = makeTestMeta({ stageVisitOrder: undefined, loopCycleCount: undefined });
    const result = recordStageVisit(meta, "develop", 3);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.stageVisitOrder).toEqual(["develop"]);
      expect(result.patch.loopCycleCount).toBe(0);
    }
  });

  it("revisit: increments loopCycleCount and appends", () => {
    const meta = makeTestMeta({
      stageVisitOrder: ["clarify", "plan", "develop"],
      loopCycleCount: 0,
    });
    const result = recordStageVisit(meta, "plan", 3);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.stageVisitOrder).toEqual(["clarify", "plan", "develop", "plan"]);
      expect(result.patch.loopCycleCount).toBe(1);
    }
  });

  it("revisit reaching maxCycles: returns ok:false with wouldFreeze", () => {
    const meta = makeTestMeta({
      stageVisitOrder: ["clarify", "plan", "develop", "review", "fix", "develop"],
      loopCycleCount: 2,
    });
    const result = recordStageVisit(meta, "develop", 3);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.wouldFreeze).toBe(true);
      expect(result.patch.loopCycleCount).toBe(3);
      expect(result.patch.stageVisitOrder).toEqual([
        "clarify", "plan", "develop", "review", "fix", "develop", "develop",
      ]);
    }
  });

  it("completed stage is appended like any other stage", () => {
    const meta = makeTestMeta({
      stageVisitOrder: ["clarify", "plan", "develop", "review"],
      loopCycleCount: 0,
    });
    const result = recordStageVisit(meta, "completed", 3);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.stageVisitOrder).toEqual(["clarify", "plan", "develop", "review", "completed"]);
      expect(result.patch.loopCycleCount).toBe(0);
    }
  });

  it("does not mutate original meta", () => {
    const meta = makeTestMeta({
      stageVisitOrder: ["clarify"],
      loopCycleCount: 0,
    });
    const originalOrder = [...(meta.stageVisitOrder ?? [])];

    recordStageVisit(meta, "plan", 3);

    expect(meta.stageVisitOrder).toEqual(originalOrder);
  });
});
