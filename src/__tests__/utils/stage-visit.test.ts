import { describe, it, expect } from "bun:test";
import { recordStageVisit, classifyVisitEdge } from "../../utils/stage-visit";
import { makeTestConfig, makeTestMeta } from "../helpers";
import { effectiveMax } from "../../utils/stage-visit";
import { DEFAULT_MAX_LOOP_CYCLES } from "../../constants";

// Test helper config for recordStageVisit
// Aligned with actual template chain from pipeline_loop.json:
// clarify→plan→develop→review→completed, design-review→develop, fix→review
const createTestConfig = () => makeTestConfig({
  stages: {
    clarify: { nextStage: "plan" as const, skillPath: "clarify/SKILL.md", requireDomain: false },
    plan: { nextStage: "develop" as const, skillPath: "plan/SKILL.md", requireDomain: false },
    "design-review": { nextStage: "develop" as const, skillPath: "design-review/SKILL.md", requireDomain: false },
    develop: { nextStage: "review" as const, skillPath: "develop/SKILL.md", requireDomain: false },
    review: { nextStage: "completed" as const, skillPath: "review/SKILL.md", requireDomain: false },
    fix: { nextStage: "review" as const, skillPath: "fix/SKILL.md", requireDomain: false },
    awaiting_human: { nextStage: null, skillPath: "awaiting-human/SKILL.md", requireDomain: false },
    completed: { nextStage: null, skillPath: "completed/SKILL.md", requireDomain: false },
  },
});

describe("recordStageVisit", () => {
  it("first visit: appends stage and sets loopCycleCount=0", () => {
    const meta = makeTestMeta({ stageVisitOrder: ["clarify"], loopCycleCount: undefined });
    const result = recordStageVisit(meta, "plan", 3, createTestConfig() as any);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.stageVisitOrder).toEqual(["clarify", "plan"]);
      expect(result.patch.loopCycleCount).toBe(0);
    }
  });

  it("first visit with undefined stageVisitOrder: creates array with stage", () => {
    const meta = makeTestMeta({ stageVisitOrder: undefined, loopCycleCount: undefined });
    const result = recordStageVisit(meta, "develop", 3, createTestConfig() as any);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.stageVisitOrder).toEqual(["develop"]);
      expect(result.patch.loopCycleCount).toBe(0);
    }
  });

  it("C2 backward revisit: increments loopCycleCount and appends", () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      stageVisitOrder: ["clarify", "plan", "develop"],
      loopCycleCount: 0,
    });
    const result = recordStageVisit(meta, "plan", 3, createTestConfig() as any);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.patch.stageVisitOrder).toEqual(["clarify", "plan", "develop", "plan"]);
      expect(result.patch.loopCycleCount).toBe(1);
    }
  });

  it("C2 backward revisit reaching maxCycles: returns ok:false with wouldFreeze", () => {
    // Phase 3 (195_Bug): counted-edge semantics per plan classifyVisitEdge truth table (12-A) — old "any revisit counts" assertion superseded
    // Use C2 backward edge (fix → develop) to trigger freeze, not self-loop (C4 unclassified)
    const meta = makeTestMeta({
      currentStage: "fix",
      stageVisitOrder: ["clarify", "plan", "develop", "review", "fix"],
      loopCycleCount: 2,
    });
    const result = recordStageVisit(meta, "develop", 3, createTestConfig() as any);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.wouldFreeze).toBe(true);
      expect(result.patch.loopCycleCount).toBe(3);
      expect(result.patch.stageVisitOrder).toEqual([
        "clarify", "plan", "develop", "review", "fix", "develop",
      ]);
    }
  });

  it("first visit to new stage resets loopCycleCount to 0", () => {
    const meta = makeTestMeta({
      stageVisitOrder: ["clarify", "plan", "develop", "review"],
      loopCycleCount: 2,
    });
    const result = recordStageVisit(meta, "completed", 3, createTestConfig() as any);

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

    recordStageVisit(meta, "plan", 3, createTestConfig() as any);

    expect(meta.stageVisitOrder).toEqual(originalOrder);
  });
});

describe("classifyVisitEdge", () => {
  it("C0 first: target not in stageVisitOrder", () => {
    const meta = makeTestMeta({
      currentStage: "plan",
      stageVisitOrder: ["clarify", "plan"],
    });
    const result = classifyVisitEdge(meta, createTestConfig() as any, "develop");
    expect(result.kind).toBe("first");
    expect(result.counted).toBe(false);
  });

  it("C1 forward: config-defined nextStage chain", () => {
    // With corrected config: develop.nextStage = "review"
    // C1 fires when target IS in visitOrder AND target === source.nextStage
    const meta = makeTestMeta({
      currentStage: "develop",
      stageVisitOrder: ["clarify", "plan", "develop", "review"],
    });
    const result = classifyVisitEdge(meta, createTestConfig() as any, "review");
    expect(result.kind).toBe("forward");
    expect(result.counted).toBe(false);
  });

  it("C2 backward: ordinal regression in canonical order", () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      stageVisitOrder: ["clarify", "plan", "develop"],
    });
    const result = classifyVisitEdge(meta, createTestConfig() as any, "plan");
    expect(result.kind).toBe("backward");
    expect(result.counted).toBe(true);
  });

  it("C3 loop_return: config rework entry", () => {
    // With corrected config: fix.nextStage = "review"
    // C3 fires when target IS in visitOrder AND config.stages[target].nextStage === source
    const meta = makeTestMeta({
      currentStage: "review",
      stageVisitOrder: ["clarify", "plan", "develop", "review", "fix", "develop", "review"],
    });
    const result = classifyVisitEdge(meta, createTestConfig() as any, "fix");
    expect(result.kind).toBe("loop_return");
    expect(result.counted).toBe(true);
  });

  it("C4 unclassified: fallback (self-loop)", () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      stageVisitOrder: ["clarify", "plan", "develop"],
    });
    const result = classifyVisitEdge(meta, createTestConfig() as any, "develop");
    expect(result.kind).toBe("unclassified");
    expect(result.counted).toBe(false);
  });

  it("vaultmind regression: review↔fix cycle with correct template chain", () => {
    // Plan truth table with corrected config (fix.nextStage = "review"):
    // - review→fix (fix未访问): C0 first, count=0
    // - fix→review: C1 forward, count stays
    // - review→fix (fix已访问): C3 loop_return, count+1
    const meta = makeTestMeta({
      currentStage: "review",
      stageVisitOrder: ["clarify", "plan", "develop", "review"],
      loopCycleCount: 0,
    });
    const config = createTestConfig() as any;
    
    // review → fix (first visit, C0, count=0)
    const result1 = recordStageVisit(meta, "fix", 5, config);
    expect(result1.ok).toBe(true);
    if (result1.ok) {
      expect(result1.edgeKind).toBe("first");
      expect(result1.patch.loopCycleCount).toBe(0);
    }

    // fix → review (C1 forward, count stays at 0)
    const meta2 = makeTestMeta({
      currentStage: "fix",
      stageVisitOrder: ["clarify", "plan", "develop", "review", "fix"],
      loopCycleCount: 0,
    });
    const result2 = recordStageVisit(meta2, "review", 5, config);
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.edgeKind).toBe("forward");
      expect(result2.patch.loopCycleCount).toBe(0);
    }

    // review → fix (fix已访问, C3 loop_return, count=1)
    const meta3 = makeTestMeta({
      currentStage: "review",
      stageVisitOrder: ["clarify", "plan", "develop", "review", "fix", "review"],
      loopCycleCount: 0,
    });
    const result3 = recordStageVisit(meta3, "fix", 5, config);
    expect(result3.ok).toBe(true);
    if (result3.ok) {
      expect(result3.edgeKind).toBe("loop_return");
      expect(result3.patch.loopCycleCount).toBe(1);
    }

    // fix → review (C1 forward, count stays at 1)
    const meta4 = makeTestMeta({
      currentStage: "fix",
      stageVisitOrder: ["clarify", "plan", "develop", "review", "fix", "review", "fix"],
      loopCycleCount: 1,
    });
    const result4 = recordStageVisit(meta4, "review", 5, config);
    expect(result4.ok).toBe(true);
    if (result4.ok) {
      expect(result4.edgeKind).toBe("forward");
      expect(result4.patch.loopCycleCount).toBe(1);
    }

    // review → fix (C3, count=2)
    const meta5 = makeTestMeta({
      currentStage: "review",
      stageVisitOrder: ["clarify", "plan", "develop", "review", "fix", "review", "fix", "review"],
      loopCycleCount: 1,
    });
    const result5 = recordStageVisit(meta5, "fix", 5, config);
    expect(result5.ok).toBe(true);
    if (result5.ok) {
      expect(result5.edgeKind).toBe("loop_return");
      expect(result5.patch.loopCycleCount).toBe(2);
    }

    // count=4 → 5, 5 >= maxCycles=5 → freeze! (6th review→fix attempt)
    const meta6 = makeTestMeta({
      currentStage: "review",
      stageVisitOrder: ["clarify", "plan", "develop", "review", "fix", "review", "fix", "review", "fix", "review", "fix", "review"],
      loopCycleCount: 4,
    });
    const result6 = recordStageVisit(meta6, "fix", 5, config);
    expect(result6.ok).toBe(false);
    if (!result6.ok) {
      expect(result6.wouldFreeze).toBe(true);
      expect(result6.edgeKind).toBe("loop_return");
      expect(result6.patch.loopCycleCount).toBe(5);
    }
  });
});

// Phase 0 (195_Bug): Tests for effectiveMax three-level fallback
describe("effectiveMax (Phase 0: 195_Bug)", () => {
  it("returns meta.maxLoopCycles when set (highest priority)", () => {
    const meta = { maxLoopCycles: 10 };
    const config = { maxLoopCycles: 7 };
    expect(effectiveMax(meta, config)).toBe(10);
  });

  it("returns config.maxLoopCycles when meta.maxLoopCycles is undefined (fallback level 2)", () => {
    const meta = { maxLoopCycles: undefined };
    const config = { maxLoopCycles: 7 };
    expect(effectiveMax(meta, config)).toBe(7);
  });

  it("returns DEFAULT_MAX_LOOP_CYCLES when both are undefined (fallback level 3)", () => {
    const meta = { maxLoopCycles: undefined };
    const config = { maxLoopCycles: undefined };
    expect(effectiveMax(meta, config)).toBe(DEFAULT_MAX_LOOP_CYCLES);
    expect(effectiveMax(meta, config)).toBe(5); // DEFAULT_MAX_LOOP_CYCLES = 5
  });

  it("returns DEFAULT_MAX_LOOP_CYCLES when config.maxLoopCycles is missing entirely", () => {
    const meta = {};
    const config = {};
    expect(effectiveMax(meta, config)).toBe(DEFAULT_MAX_LOOP_CYCLES);
  });
});
