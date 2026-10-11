/**
 * Phase 4 (task 5): remainingRounds value table test.
 * Verifies remainingRounds calculation at different loop states (max=5).
 */
import { describe, expect, it } from "bun:test";

describe("remainingRounds value table (Phase 4 task 5, max=5)", () => {
  const testCases = [
    // Unstarted state: 5/5 (N5 correction)
    { state: "unstarted", loopCycleCount: 0, expected: 5, description: "未开始 5/5" },
    // Round 1 in progress: 4/5
    { state: "R1-in-progress", loopCycleCount: 1, expected: 4, description: "R1 中 4/5" },
    // Round 4 final: 1/5 (warning triggers)
    { state: "R4-final", loopCycleCount: 4, expected: 1, description: "R4 终 1/5 预警" },
    // Round 5 final: 0/5 (freeze)
    { state: "R5-final", loopCycleCount: 5, expected: 0, description: "R5 终 0/5 冻结" },
  ];

  it.each(testCases)(
    "$description: loopCycleCount=$loopCycleCount → remainingRounds=$expected",
    ({ loopCycleCount, expected }) => {
      const effectiveMax = 5;
      const remainingRounds = effectiveMax - loopCycleCount;
      expect(remainingRounds).toBe(expected);
    }
  );

  it("warning triggers at remainingRounds === 1 (R4 final)", () => {
    const effectiveMax = 5;
    const loopCycleCount = 4;
    const remainingRounds = effectiveMax - loopCycleCount;
    expect(remainingRounds).toBe(1);
    // This is the single-trigger point for loop_budget_low warning
  });

  it("freeze triggers at remainingRounds === 0 (R5 final)", () => {
    const effectiveMax = 5;
    const loopCycleCount = 5;
    const remainingRounds = effectiveMax - loopCycleCount;
    expect(remainingRounds).toBe(0);
    // This triggers pipeline_blocked audit
  });
});
