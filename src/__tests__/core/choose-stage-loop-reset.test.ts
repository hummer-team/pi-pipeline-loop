import { describe, it, expect } from "bun:test";
import { executeDecision } from "../../core/flow-state";
import { recordStageVisit } from "../../utils/stage-visit";
import { makeTestConfig, makeTestMeta } from "../helpers";

/**
 * Phase 3 (190) Fix-F: choose_stage resets loopCycleCount to prevent immediate refreeze
 *
 * When a user manually selects a new stage via choose_stage, the loopCycleCount
 * should be reset to 0 so that the cycle counting starts fresh for the new stage.
 * This prevents the scenario where a previously accumulated loopCycleCount would
 * immediately trigger maxLoopCycles freeze after stage selection.
 */
describe("Phase 3 (190) Fix-F: choose_stage resets loopCycleCount", () => {
  it("choose_stage resets loopCycleCount to 0", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "max_loop_cycles",
      loopCycleCount: 3,
    });
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<typeof meta>) => {
          Object.assign(meta, patch);
          return meta;
        },
      },
      ui: { notify: () => {} },
    };
    const config = makeTestConfig();

    const result = await executeDecision(
      ctx as any,
      meta,
      "choose_stage",
      config,
      { targetStage: "review" }
    );

    expect(result.success).toBe(true);
    expect(meta.loopCycleCount).toBe(0);
    expect(meta.currentStage).toBe("review");
  });

  it("after choose_stage reset, revisit counting starts from 0 (does not immediately trigger maxLoopCycles)", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "max_loop_cycles",
      loopCycleCount: 3,
      stageVisitOrder: ["clarify", "plan", "develop"],
    });
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<typeof meta>) => {
          Object.assign(meta, patch);
          return meta;
        },
      },
      ui: { notify: () => {} },
    };
    const config = makeTestConfig({ maxLoopCycles: 3 });

    // First, reset via choose_stage
    const result = await executeDecision(
      ctx as any,
      meta,
      "choose_stage",
      config,
      { targetStage: "review" }
    );
    expect(result.success).toBe(true);
    expect(meta.loopCycleCount).toBe(0);

    // Now simulate a revisit to review stage
    // After choose_stage, "review" was already appended to stageVisitOrder (flow-state.ts:509-511),
    // so this is a revisit (second visit)
    const visitResult = recordStageVisit(meta, "review", 3, config);
    expect(visitResult.ok).toBe(true);
    // When ok is true, wouldFreeze property should not exist on the result
    expect("wouldFreeze" in visitResult).toBe(false);
    // Phase 3 (195_Bug): counted-edge semantics per plan classifyVisitEdge truth table (12-A) — old "any revisit counts" assertion superseded
    // Self-loop (review → review) is C4 unclassified, not counted, so loopCycleCount remains 0
    expect(visitResult.patch.loopCycleCount).toBe(0);
  });

  it("resume does NOT reset loopCycleCount (regression test)", async () => {
    const meta = makeTestMeta({
      currentStage: "develop",
      flowState: "blocked",
      blockedReason: "max_loop_cycles",
      loopCycleCount: 2,
    });
    const ctx = {
      session: {
        getMeta: () => meta,
        updateMeta: (patch: Partial<typeof meta>) => {
          Object.assign(meta, patch);
          return meta;
        },
      },
      ui: { notify: () => {} },
    };
    const config = makeTestConfig();

    const result = await executeDecision(ctx as any, meta, "resume", config);

    expect(result.success).toBe(true);
    // loopCycleCount should remain 2 (not reset to 0)
    expect(meta.loopCycleCount).toBe(2);
  });
});
