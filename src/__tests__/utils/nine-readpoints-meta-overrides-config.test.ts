/**
 * Phase 4 (task 5): Nine read points parameterized test for meta-overrides-config.
 * Verifies that all 9 effectiveMax call sites respect meta.maxLoopCycles > config.maxLoopCycles > DEFAULT.
 */
import { describe, expect, it } from "bun:test";
import { effectiveMax } from "../../utils/stage-visit";
import { DEFAULT_MAX_LOOP_CYCLES } from "../../constants";
import type { SessionMeta, PipelineConfig } from "../../types";

describe("9 read points: meta overrides config (Phase 4 task 5)", () => {
  const testCases = [
    { name: "pipeline-handoff.ts:219", meta: 8, config: 6, expected: 8 },
    { name: "verify-advance.ts:198", meta: 7, config: 5, expected: 7 },
    { name: "stage-advancer.ts:390", meta: 9, config: 4, expected: 9 },
    { name: "stage-advancer.ts:1144", meta: 6, config: 3, expected: 6 },
    { name: "stage-advancer.ts:1913", meta: 10, config: 5, expected: 10 },
    { name: "develop-transition.ts:136", meta: 4, config: 2, expected: 4 },
    { name: "coordinator.ts:1082", meta: 5, config: 3, expected: 5 },
    { name: "coordinator.ts:1927", meta: 8, config: 6, expected: 8 },
    { name: "coordinator.ts:2193", meta: 12, config: 7, expected: 12 },
  ];

  it.each(testCases)(
    "$name: meta($meta) overrides config($config) → expected($expected)",
    ({ meta, config, expected }) => {
      const metaObj = { maxLoopCycles: meta } as SessionMeta;
      const configObj = { maxLoopCycles: config } as PipelineConfig;
      const result = effectiveMax(metaObj, configObj);
      expect(result).toBe(expected);
    }
  );

  it("config used when meta is undefined", () => {
    const metaObj = {} as SessionMeta;
    const configObj = { maxLoopCycles: 6 } as PipelineConfig;
    const result = effectiveMax(metaObj, configObj);
    expect(result).toBe(6);
  });

  it("DEFAULT used when both are undefined", () => {
    const metaObj = {} as SessionMeta;
    const configObj = {} as PipelineConfig;
    const result = effectiveMax(metaObj, configObj);
    expect(result).toBe(DEFAULT_MAX_LOOP_CYCLES);
  });
});
