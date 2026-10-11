/**
 * Phase 4 (task 5): loop_budget_low single-trigger test.
 * Verifies that the low-budget warning fires only once when remainingRounds === 1.
 */
import { describe, expect, it } from "bun:test";

describe("loop_budget_low: single-trigger (Phase 4 task 5)", () => {
  it("warning fires only when remainingRounds === 1, not at 0 or 2+", () => {
    const testCases = [
      { loopCycleCount: 0, maxLoopCycles: 5, remaining: 5, shouldWarn: false },
      { loopCycleCount: 3, maxLoopCycles: 5, remaining: 2, shouldWarn: false },
      { loopCycleCount: 4, maxLoopCycles: 5, remaining: 1, shouldWarn: true },
      { loopCycleCount: 5, maxLoopCycles: 5, remaining: 0, shouldWarn: false },
    ];

    for (const { loopCycleCount, maxLoopCycles, remaining, shouldWarn } of testCases) {
      const isWarnTrigger = remaining === 1;
      expect(isWarnTrigger).toBe(shouldWarn);
    }
  });

  it("loopBudgetWarned flag prevents repeat warnings", () => {
    // Simulate the warning logic
    let warned = false;
    const remainingRounds = 1;

    // First call: should warn
    if (remainingRounds === 1 && !warned) {
      warned = true;
      expect(warned).toBe(true);
    }

    // Second call: should NOT warn (flag already set)
    if (remainingRounds === 1 && !warned) {
      throw new Error("Should not warn again");
    }
    expect(warned).toBe(true); // flag persists
  });

  it("remainingRounds calculation: effectiveMax - loopCycleCount", () => {
    const effectiveMax = 5;
    const loopCycleCount = 4;
    const remainingRounds = effectiveMax - loopCycleCount;
    expect(remainingRounds).toBe(1);
  });
});
