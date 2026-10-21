/**
 * 210 Phase 0: new-period meta reset coverage for the R1/R2 evidence fields
 * (`stageStats`, `usageByStage`, `pipelineStartedAt`).
 *
 * The three fields are set ONLY in `buildNewPeriodResetFields`; start /
 * restart / resume metas all spread it (single construction point).
 */
import { describe, expect, it } from "bun:test";
import { buildContinueResetFields, buildNewPeriodResetFields } from "../../core/meta-reset";
import type { SessionMeta } from "../../types";
import { makeTestConfig } from "../helpers";

const config = makeTestConfig();

describe("buildNewPeriodResetFields (210 Phase 0)", () => {
  it("resets stageStats and usageByStage on a new period", () => {
    const meta = {
      pipelineId: "p-old",
      stageStats: { clarify: { durationMs: 1, verifyAttempts: 1, confirmRejections: 0 } },
      usageByStage: {},
    } as unknown as SessionMeta;
    const fields = buildNewPeriodResetFields(meta, config);
    expect(fields.stageStats).toBeUndefined();
    expect(fields.usageByStage).toBeUndefined();
  });

  it("rebases pipelineStartedAt on a new period", () => {
    const before = Date.now();
    const fields = buildNewPeriodResetFields(undefined, config);
    const after = Date.now();
    expect(typeof fields.pipelineStartedAt).toBe("number");
    expect(fields.pipelineStartedAt as number).toBeGreaterThanOrEqual(before);
    expect(fields.pipelineStartedAt as number).toBeLessThanOrEqual(after);
  });

  it("continue-period reset does NOT touch the new-period evidence fields", () => {
    // "Continue" keeps period-scoped stats per the unified scope table —
    // only new periods rebase them.
    const fields = buildContinueResetFields(undefined, config);
    expect("stageStats" in fields).toBe(false);
    expect("usageByStage" in fields).toBe(false);
    expect("pipelineStartedAt" in fields).toBe(false);
  });
});
