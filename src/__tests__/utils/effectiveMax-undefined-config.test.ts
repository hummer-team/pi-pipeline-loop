/**
 * Phase 4 (task 5): effectiveMax undefined-config fallback test.
 * Verifies that effectiveMax gracefully handles undefined config parameter.
 */
import { describe, expect, it } from "bun:test";
import { effectiveMax } from "../../utils/stage-visit";
import { DEFAULT_MAX_LOOP_CYCLES } from "../../constants";
import type { SessionMeta } from "../../types";

describe("effectiveMax undefined-config fallback (Phase 4 task 5)", () => {
  it("falls back to DEFAULT_MAX_LOOP_CYCLES when config is undefined", () => {
    const meta = { maxLoopCycles: 7 } as SessionMeta;
    const result = effectiveMax(meta, undefined);
    expect(result).toBe(7); // meta takes precedence
  });

  it("uses DEFAULT_MAX_LOOP_CYCLES when both meta and config are undefined/missing", () => {
    const meta = {} as SessionMeta;
    const result = effectiveMax(meta, undefined);
    expect(result).toBe(DEFAULT_MAX_LOOP_CYCLES);
  });

  it("meta overrides DEFAULT when config is undefined", () => {
    const meta = { maxLoopCycles: 10 } as SessionMeta;
    const result = effectiveMax(meta, undefined);
    expect(result).toBe(10);
  });
});
