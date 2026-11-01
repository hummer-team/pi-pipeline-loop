/**
 * 220 Phase 5 (D5): the `"auto"` start-stage derivation.
 *
 * Facts:
 * - `"auto"` derives from on-disk plan evidence only: confirmed plan ⇒ develop,
 *   unconfirmed plan ⇒ plan, no plan ⇒ clarify.
 * - An explicit request is passed through untouched (the evidence gate decides
 *   whether it is actually startable).
 * - No glob is ever consulted: the plan path is derived exactly by the caller.
 */
import { describe, it, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { RESUMABLE_STAGES } from "../../constants";
import { resolveStartStage } from "../../core/auto-pipeline/resolve-start-stage";
import { derivePlanDocPath } from "../../core/auto-pipeline/start-stage-evidence";
import * as fileVerifier from "../../core/verifiers/file-verifier";

const SOURCES = path.resolve(__dirname, "..", "..", "core", "auto-pipeline");

describe("resolveStartStage — auto derivation", () => {
  it("confirmed plan → develop", () => {
    expect(resolveStartStage("auto", { planPath: "docs/design/1_Feat_Plan.md", planConfirmed: true })).toEqual({
      stage: "develop",
      derivation: "auto",
    });
  });

  it("plan without the confirmation marker → plan", () => {
    expect(resolveStartStage("auto", { planPath: "docs/design/1_Feat_Plan.md", planConfirmed: false })).toEqual({
      stage: "plan",
      derivation: "auto",
    });
  });

  it("no plan → clarify", () => {
    expect(resolveStartStage("auto", { planPath: null, planConfirmed: false })).toEqual({
      stage: "clarify",
      derivation: "auto",
    });
  });
});

describe("resolveStartStage — explicit requests", () => {
  for (const stage of RESUMABLE_STAGES) {
    it(`${stage} is passed through unchanged`, () => {
      expect(resolveStartStage(stage, { planPath: null, planConfirmed: false })).toEqual({
        stage,
        derivation: "explicit",
      });
    });
  }

  it("an explicit stage ignores the plan facts (no silent upgrade)", () => {
    const planPath = "docs/design/1_Feat_Plan.md";
    expect(resolveStartStage("clarify", { planPath, planConfirmed: true })).toEqual({
      stage: "clarify",
      derivation: "explicit",
    });
    expect(resolveStartStage("plan", { planPath, planConfirmed: true })).toEqual({
      stage: "plan",
      derivation: "explicit",
    });
  });
});

describe("resolveStartStage — exact derivation only", () => {
  it("derives the plan path exactly and never calls the glob helper", () => {
    const spy = spyOn(fileVerifier, "globMatchFiles").mockImplementation(async () => {
      throw new Error("glob must not be consulted for the start-stage derivation");
    });
    try {
      const requirement = "docs/design/220_Feat.md";
      const planPath = derivePlanDocPath(requirement);
      expect(planPath).toBe("docs/design/220_Feat_Plan.md");
      const resolved = resolveStartStage("auto", { planPath, planConfirmed: false });
      expect(resolved).toEqual({ stage: "plan", derivation: "auto" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("the module itself imports neither the glob helper nor the glob-falling resolver", () => {
    for (const file of ["resolve-start-stage.ts", "start-stage-evidence.ts"]) {
      const source = fs.readFileSync(path.join(SOURCES, file), "utf8");
      expect(source.includes("globMatchFiles")).toBe(false);
      expect(source.includes("resolvePlanDocPath")).toBe(false);
    }
  });
});
